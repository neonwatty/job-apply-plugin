import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ClaimsService } from '../workspace-core/claims.js';
import { nativeAttemptPidName, nativeAttemptPidPendingName, validateNativeAttemptPid } from '../store/native-store-layout.js';
import type { PosixFlockProvider } from '../store/posix-flock.js';
import type { Document } from '../contracts/workspace/values.js';
import { AttemptAuthority } from './attempt-authority.js';
import { AttemptFrameDecoder, attemptError, attemptHeartbeatMilliseconds, attemptIdleMilliseconds, attemptSocketPath, encodeAttemptFrame } from './attempt-protocol.js';

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
/** Stage on the Store filesystem so publication never exposes an empty final PID. */
async function publishPid(root: string, processPath: string): Promise<void> {
  await validateNativeAttemptPid(root);
  const pendingPath = join(root, nativeAttemptPidPendingName);
  const pid = await open(pendingPath, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  let owned: { dev: number; ino: number } | undefined;
  try {
    const metadata = await pid.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.getuid!()
      || (metadata.mode & 0o777) !== 0o600) throw new Error('attempt PID unavailable');
    owned = { dev: metadata.dev, ino: metadata.ino };
    await pid.truncate(0);
    await pid.writeFile(`${process.pid}\n`);
    await pid.sync();
    await rename(pendingPath, processPath);
    const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    try { await pid.close(); }
    finally {
      if (owned) {
        const remaining = await lstat(pendingPath).catch(error => {
          if (error.code === 'ENOENT') return null; throw error;
        });
        if (remaining?.isFile() && remaining.dev === owned.dev && remaining.ino === owned.ino) await unlink(pendingPath);
      }
    }
  }
}
interface BrokerOptions { idleMilliseconds?: number; heartbeatMilliseconds?: number }
export async function runAttemptBroker(root: string, service: ClaimsService, provider: PosixFlockProvider, options: BrokerOptions = {}): Promise<void> {
  const path = await runtimePath(root), processPath = join(root, nativeAttemptPidName);
  // Hold an inode-stable private lock for the whole broker lifetime. It prevents two
  // launchers from unlinking each other's endpoint during stale-socket recovery.
  const ownership = await open(path + '.lock', constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  const info = await ownership.stat();
  if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o600) {
    await ownership.close(); throw new Error('attempt ownership unavailable');
  }
  let locked = false, listening = false, acquired = false, stopped = false, pidWritten = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let resolveStopped!: () => void;
  const stoppedPromise = new Promise<void>(resolve => { resolveStopped = resolve; });
  const stop = () => { stopped = true; resolveStopped(); };
  const authority = new AttemptAuthority(service, { heartbeatMilliseconds: options.heartbeatMilliseconds ?? attemptHeartbeatMilliseconds, onHeartbeatFailure: stop });
  const clients = new Set<Socket>();
  let begin!: () => void;
  let queue = new Promise<void>(resolve => { begin = resolve; });
  const server = createServer({ allowHalfOpen: true }, socket => {
    clients.add(socket); socket.on('close', () => clients.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(1000, () => socket.destroy());
    const decoder = new AttemptFrameDecoder();
    let queued = false, rejected = false, received = false;
    const reject = () => {
      rejected = true;
      socket.end(encodeAttemptFrame(attemptError('request_rejected')), () => { if (!acquired) stop(); });
    };
    socket.on('data', bytes => {
      received = true;
      let request: Document | null;
      try { request = decoder.push(bytes); }
      catch { reject(); return; }
      if (!request || queued) return;
      queued = true;
      const incoming = request;
      queue = queue.then(async () => {
        if (stopped || rejected) return;
        let complete = false, response: Document;
        try {
          if (!acquired) {
            response = await authority.acquire(incoming); acquired = true; clearTimeout(idle);
          } else {
            const result = await authority.dispatch(incoming); response = result.response; complete = result.complete;
          }
        } catch { response = attemptError('request_rejected'); complete = !acquired; }
        socket.end(encodeAttemptFrame(response), () => { if (complete) stop(); });
        if (complete && socket.destroyed) stop();
      }).catch(stop);
    });
    socket.once('end', () => {
      if (!queued && !rejected) { if (received) reject(); else socket.destroy(); }
    });
  });
  server.on('error', stop);
  try {
    locked = provider.tryLock(ownership.fd);
    if (!locked || await reachable(path)) throw new Error('attempt already running');
    const stale = await lstat(path).catch(error => {
      if (error.code === 'ENOENT') return null; throw error;
    });
    if (stale) {
      if (!stale.isSocket() || stale.uid !== process.getuid!()) throw new Error('attempt endpoint unavailable');
      await unlink(path);
    }
    await listen(server, path); listening = true;
    await chmod(path, 0o600);
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
  const child = spawn(process.execPath, [executable, '--broker', '--root', root], { detached: true, stdio: 'ignore' });
  child.on('error', () => {}); child.unref();
}
async function exchange(path: string, request: Document): Promise<Document> {
  const frame = encodeAttemptFrame(request);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path, allowHalfOpen: true });
    const decoder = new AttemptFrameDecoder();
    let result: Document | null = null;
    const fail = () => { socket.destroy(); reject(new Error('attempt unavailable')); };
    socket.once('connect', () => socket.end(frame));
    socket.on('data', bytes => { try { result = decoder.push(bytes); } catch { fail(); } });
    socket.once('end', () => { socket.destroy(); if (result) resolve(result); else fail(); });
    socket.once('error', fail); socket.setTimeout(1000, fail);
  });
}
export async function requestAttempt(root: string, request: Document, options: { start?: boolean; executable?: string } = {}): Promise<Document> {
  const path = await runtimePath(root), deadline = Date.now() + 10_000;
  // Reject oversized frames before starting any broker.
  encodeAttemptFrame(request);
  let launched = false;
  for (;;) {
    try { return await exchange(path, request); }
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
