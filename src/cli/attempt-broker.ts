import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { syncDirectory } from '../store/directory-sync.js';
import type { ClaimsService } from '../workspace-core/claims.js';
import { nativeAttemptPidName, nativeAttemptPidPendingName, validateNativeAttemptPid } from '../store/native-store-layout.js';
import type { PosixFlockProvider } from '../store/posix-flock.js';
import type { Document } from '../contracts/workspace/values.js';
import { AttemptAuthority } from './attempt-authority.js';
import { AttemptFrameDecoder, attemptError, attemptHeartbeatMilliseconds, attemptIdleMilliseconds, attemptSocketPath, encodeAttemptFrame } from './attempt-protocol.js';
import { acceptPipeClient, attemptLockPath, attemptPipePath, connectPipeBroker, encodePipeRequest, publishAttemptKey, readAttemptKey, readPipeRequest } from './attempt-pipe.js';
import { openPrivateStoreFile } from '../store/private-store-entry.js';
import { windowsFileIdentity, windowsMetadata } from '../store/windows-store.js';
import type { ApplicationAuthorityService } from '../workspace-core/application-authority.js';

const windows = process.platform === 'win32';
async function runtimePath(root: string): Promise<string> {
  if (!['darwin', 'linux'].includes(process.platform) || !process.getuid) throw new Error('attempt transport unavailable');
  const uid = process.getuid(), path = attemptSocketPath(root, uid), directory = dirname(path);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o777) !== 0o700) {
    throw new Error('attempt runtime unavailable');
  }
  return path;
}
async function reachable(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection(path);
    const finish = (result: boolean) => { socket.destroy(); resolve(result); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(200, () => finish(false));
  });
}
async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ path, backlog: 8 }, () => { server.off('error', reject); resolve(); });
  });
}
async function pendingIdentity(path: string): Promise<string | null> {
  try {
    if (windows) return windowsFileIdentity(windowsMetadata(path));
    const remaining = await lstat(path);
    return remaining.isFile() ? `${remaining.dev}:${remaining.ino}` : null;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
/** Stage on the Store filesystem so publication never exposes an empty final PID. */
async function publishPid(root: string, processPath: string): Promise<void> {
  await validateNativeAttemptPid(root);
  const pendingPath = join(root, nativeAttemptPidPendingName);
  const pid = windows
    ? await openPrivateStoreFile(pendingPath, constants.O_WRONLY | constants.O_CREAT, 'attempt PID unavailable')
    : await open(pendingPath, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  let owned: string | undefined;
  try {
    if (windows) owned = windowsFileIdentity(windowsMetadata(pid.fd));
    else {
      const metadata = await pid.stat();
      if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.getuid!()
        || (metadata.mode & 0o777) !== 0o600) throw new Error('attempt PID unavailable');
      owned = `${metadata.dev}:${metadata.ino}`;
    }
    await pid.truncate(0);
    await pid.writeFile(`${process.pid}\n`);
    await pid.sync();
    await rename(pendingPath, processPath);
    await syncDirectory(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } finally {
    try { await pid.close(); }
    finally {
      if (owned) {
        if (await pendingIdentity(pendingPath) === owned) await unlink(pendingPath);
      }
    }
  }
}
interface BrokerOptions { idleMilliseconds?: number; heartbeatMilliseconds?: number }
export async function runAttemptBroker(root: string, service: ClaimsService, provider: PosixFlockProvider,
  options: BrokerOptions = {}, application?: ApplicationAuthorityService): Promise<void> {
  const processPath = join(root, nativeAttemptPidName);
  let path = windows ? '' : await runtimePath(root), key: Buffer = Buffer.alloc(0);
  // Hold an inode-stable private lock for the whole broker lifetime. It prevents two
  // launchers from unlinking each other's endpoint during stale-socket recovery.
  const ownership = windows
    ? await openPrivateStoreFile(attemptLockPath(root), constants.O_RDWR | constants.O_CREAT, 'attempt ownership unavailable')
    : await open(path + '.lock', constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  const info = await ownership.stat();
  if (!windows && (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o600)) {
    await ownership.close(); throw new Error('attempt ownership unavailable');
  }
  let locked = false, listening = false, acquired = false, stopped = false, pidWritten = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let resolveStopped!: () => void;
  const stoppedPromise = new Promise<void>(resolve => { resolveStopped = resolve; });
  const stop = () => { stopped = true; resolveStopped(); };
  const authority = new AttemptAuthority(service,
    { heartbeatMilliseconds: options.heartbeatMilliseconds ?? attemptHeartbeatMilliseconds, onHeartbeatFailure: stop }, application);
  const clients = new Set<Socket>();
  let begin!: () => void;
  let queue = new Promise<void>(resolve => { begin = resolve; });
  const server = createServer({ allowHalfOpen: true }, socket => {
    clients.add(socket); socket.on('close', () => clients.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(1000, () => socket.destroy());
    let rejected = false;
    const reject = () => {
      if (rejected || socket.destroyed) return;
      rejected = true;
      socket.end(encodeAttemptFrame(attemptError('request_rejected')), () => { if (!acquired) stop(); });
    };
    if (windows) {
      // Authentication comes first. The declared frame is the only request on this connection.
      acceptPipeClient(socket, key).then(initial => {
        readPipeRequest(socket, initial).then(request => {
          socket.resume(); // Drain bytes beyond the declared request while returning its result.
          respond(request);
        }, reject);
      }, () => socket.destroy());
    } else {
      const decoder = new AttemptFrameDecoder();
      let received = false, incoming: Document | null = null;
      socket.on('data', bytes => {
        if (rejected) return;
        received = true;
        try { incoming = decoder.push(bytes); }
        catch { reject(); }
      });
      socket.once('end', () => {
        if (rejected) return;
        if (incoming === null) { if (received) reject(); else socket.destroy(); return; }
        respond(incoming);
      });
    }
    function respond(request: Document): void {
      // The one-second deadline bounds framing, not a Store transaction waiting on its lock.
      socket.setTimeout(0);
      queue = queue.then(async () => {
        if (stopped || rejected) return;
        let complete = false, response: Document;
        try {
          if (!acquired) {
            response = await authority.acquire(request); acquired = true; clearTimeout(idle);
          } else {
            const result = await authority.dispatch(request); response = result.response; complete = result.complete;
          }
        } catch { response = attemptError('request_rejected'); complete = !acquired; }
        socket.end(encodeAttemptFrame(response), () => { if (complete) stop(); });
        if (complete && socket.destroyed) stop();
      }).catch(stop);
    }
  });
  server.on('error', stop);
  try {
    locked = provider.tryLock(ownership.fd);
    if (!locked) throw new Error('attempt already running');
    // The lock holder is the only writer of the key, and a pipe vanishes with its server.
    if (windows) { key = await publishAttemptKey(root); path = attemptPipePath(root, key); }
    else if (await reachable(path)) throw new Error('attempt already running');
    const stale = windows ? null : await lstat(path).catch(error => {
      if (error.code === 'ENOENT') return null; throw error;
    });
    if (stale) {
      if (!stale.isSocket() || stale.uid !== process.getuid!()) throw new Error('attempt endpoint unavailable');
      await unlink(path);
    }
    await listen(server, path); listening = true;
    if (!windows) await chmod(path, 0o600);
    await publishPid(root, processPath); pidWritten = true;
    begin();
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    idle = setTimeout(stop, options.idleMilliseconds ?? attemptIdleMilliseconds);
    await stoppedPromise;
  } finally {
    stopped = true; clearTimeout(idle); begin();
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    try {
      await queue; await authority.close();
      for (const client of clients) client.destroy();
      if (listening) await new Promise<void>(resolve => server.close(() => resolve()));
      // Node removes the socket it bound. Never remove metadata we did not write.
      if (pidWritten) {
        try {
          if ((await readFile(processPath, 'utf8')).trim() === String(process.pid)) await unlink(processPath);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    } finally {
      try { if (locked) provider.unlock(ownership.fd); }
      finally { await ownership.close(); }
    }
  }
}
export function spawnAttemptBroker(root: string, executable: string): void {
  const child = spawn(process.execPath, [executable, '--broker', '--root', root], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {}); child.unref();
}
async function exchange(path: string, request: Document, key?: Buffer): Promise<Document> {
  const frame = encodeAttemptFrame(request);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path, allowHalfOpen: true });
    const decoder = new AttemptFrameDecoder();
    let result: Document | null = null;
    const fail = () => { socket.destroy(); reject(new Error('attempt unavailable')); };
    const decode = (bytes: Buffer) => { try { result = decoder.push(bytes); } catch { fail(); } };
    // Windows: authenticate the broker before sending any request bytes, and write without
    // ending because a pipe cannot half-close.
    socket.once('connect', () => {
      if (!key) { socket.on('data', decode); socket.end(frame); return; }
      connectPipeBroker(socket, key).then(proven => {
        socket.on('data', decode); socket.write(Buffer.concat([proven, encodePipeRequest(frame)])); socket.resume();
      }, fail);
    });
    socket.once('end', () => { socket.destroy(); if (result) resolve(result); else fail(); });
    // Store lock acquisition permits 30 seconds; allow the response to finish after that wait.
    socket.once('error', fail); socket.setTimeout(60_000, fail);
  });
}
export async function requestAttempt(root: string, request: Document, options: { start?: boolean; executable?: string } = {}): Promise<Document> {
  const path = windows ? '' : await runtimePath(root), deadline = Date.now() + 10_000;
  // Reject oversized frames before starting any broker.
  encodeAttemptFrame(request);
  let launched = false;
  for (;;) {
    try {
      if (!windows) return await exchange(path, request);
      // Re-read each try: a broker that started meanwhile publishes a new key and pipe.
      const key = await readAttemptKey(root);
      return await exchange(attemptPipePath(root, key), request, key);
    }
    catch {
      if (!options.start || Date.now() >= deadline) throw new Error('attempt unavailable');
      if (!launched) {
        if (!options.executable) throw new Error('attempt executable unavailable');
        spawnAttemptBroker(root, options.executable); launched = true;
      }
      await delay(50);
    }
  }
}
