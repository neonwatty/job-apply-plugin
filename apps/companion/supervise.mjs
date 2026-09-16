import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeStoreBootstrap } from '../../runtime/store/native-store-bootstrap.js';
import { prepareCanonicalStoreClone } from '../../runtime/store/native-store-clone.js';
import { recoverNativeWriterSwitch } from '../../runtime/store/native-writer-switch.js';
import { ProcessOwnedWriterController } from '../../runtime/store/process-owned-writer.js';
import { withExclusiveFileLock } from '../../runtime/store/exclusive-file-lock.js';
import { loadPosixFlockProvider } from '../../runtime/store/posix-flock.js';
import { resolvePackagedNativeLock } from '../../runtime/package/native-lock-artifact.js';
import { attemptSocketPath } from '../../runtime/cli/attempt-protocol.js';

const values = new Set(['--root', '--plugin-root', '--port', '--native-lock']);
export function parseSupervisorOptions(args, app) {
  const options = { root: undefined, pluginRoot: resolve(app, '../..'), port: 0, nativeLock: undefined, dev: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (seen.has(key)) throw new Error('Duplicate supervisor option');
    seen.add(key);
    if (key === '--dev') { options.dev = true; continue; }
    if (!values.has(key)) throw new Error('Unknown supervisor option');
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error('Missing supervisor option value');
    if (key === '--root') options.root = resolve(value);
    if (key === '--plugin-root') options.pluginRoot = resolve(value);
    if (key === '--port') options.port = Number(value);
    if (key === '--native-lock') options.nativeLock = resolve(value);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('Invalid port');
  return options;
}
export function resolveSupervisorRoot(options, environment = process.env, home = homedir()) {
  const selected = options.root ?? environment.JOB_APPLY_STORE_DIR ?? join(home, '.job-apply');
  const expanded = selected === '~' || selected.startsWith('~/') ? home + selected.slice(1) : selected;
  return resolve(expanded);
}
async function existing(path) { return lstat(path).then(() => true).catch(error => {
  if (error?.code === 'ENOENT') return false; throw error;
}); }
async function validateSupervisorRoot(root) {
  const parent = dirname(root);
  const [canonicalParent, parentInfo, rootInfo, canonicalRoot] = await Promise.all([
    realpath(parent).catch(() => null), lstat(parent).catch(() => null),
    lstat(root).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error)), realpath(root).catch(() => null),
  ]);
  if (!isAbsolute(root) || root !== resolve(root) || canonicalParent !== parent || !parentInfo?.isDirectory()
    || parentInfo.isSymbolicLink() || parentInfo.uid !== process.getuid?.() || parentInfo.mode & 0o077
    || (rootInfo && (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || canonicalRoot !== root
      || rootInfo.uid !== process.getuid?.() || rootInfo.mode & 0o077))) throw new Error('Companion Store root is invalid');
}
export async function assertNoLiveDetachedAttempt(root) {
  const path = join(root, '.job-apply-attempt.pid');
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error?.code === 'ENOENT') return; throw new Error('detached attempt broker metadata is unavailable'); }
  try {
    const metadata = await handle.stat(), text = (await handle.readFile()).toString('ascii');
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600
      || !/^[1-9][0-9]{0,19}\n$/.test(text)) throw new Error('detached attempt broker metadata is invalid');
    try { process.kill(Number(text.slice(0, -1)), 0); }
    catch (error) { if (error?.code === 'ESRCH') return; throw error; }
    throw new Error('detached attempt broker is live; stop it before switching writers');
  } finally { await handle.close(); }
}
async function clearStaleDetachedAttempt(root) {
  const path = join(root, '.job-apply-attempt.pid'); let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error?.code === 'ENOENT') return; throw new Error('detached attempt broker metadata is unavailable'); }
  try {
    const metadata = await handle.stat(), text = (await handle.readFile()).toString('ascii');
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600
      || !/^[1-9][0-9]{0,19}\n$/.test(text)) throw new Error('detached attempt broker metadata is invalid');
    try { process.kill(Number(text.slice(0, -1)), 0); }
    catch (error) {
      if (error?.code !== 'ESRCH') throw error;
      const current = await lstat(path);
      if (current.dev !== metadata.dev || current.ino !== metadata.ino) throw new Error('detached attempt broker metadata changed');
      await unlink(path); return;
    }
    throw new Error('detached attempt broker is live; stop it before switching writers');
  } finally { await handle.close(); }
}
function failedActivationMarker(root) { return `${root}.native-activation-failed`; }
export async function acquireAttemptExclusion(root, provider) {
  if (!process.getuid) throw new Error('attempt broker exclusion is unavailable');
  const path = attemptSocketPath(root, process.getuid()), directory = dirname(path);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || directoryInfo.uid !== process.getuid()
    || (directoryInfo.mode & 0o777) !== 0o700) throw new Error('attempt broker exclusion is unavailable');
  const handle = await open(`${path}.lock`, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  let locked = false;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600) {
      throw new Error('attempt broker exclusion is unavailable');
    }
    locked = provider.tryLock(handle.fd);
    if (!locked) throw new Error('detached attempt broker is live; stop it before switching writers');
    return { async release() { provider.unlock(handle.fd); await handle.close(); } };
  } catch (error) { if (locked) provider.unlock(handle.fd); await handle.close(); throw error; }
}
export async function prepareNativeDefault(root, provider, options = {}) {
  await validateSupervisorRoot(root);
  await assertNoLiveDetachedAttempt(root);
  const candidate = `${root}.native-candidate`, retained = `${root}.native-retained`, rollback = `${root}.python-rollback`;
  if (await existing(failedActivationMarker(root)) && !options.allowFailedActivation) {
    throw new Error('native activation previously failed; run Companion with --rollback before retrying');
  }
  if (await Promise.all([existing(candidate), existing(retained), existing(rollback)]).then(values => values.some(Boolean))) {
    const mode = await recoverNativeWriterSwitch(root, { provider, signal: options.signal });
    return { mode, candidate, durablePythonRollback: mode === 'python' && await existing(retained) };
  }
  await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
  const bootstrap = createNativeStoreBootstrap(root, undefined, process.env, undefined, {
    ...(options.now ? { clock: options.now } : {}),
    locked: operation => withExclusiveFileLock(join(root, '.store.lock'), async () => {
      await clearStaleDetachedAttempt(root); options.signal?.throwIfAborted(); return operation();
    }, {
      provider, pathProfile: '3.12', signal: options.signal ?? AbortSignal.timeout(30_000),
    }),
  });
  await bootstrap.initialize(); await assertNoLiveDetachedAttempt(root); options.signal?.throwIfAborted();
  const marker = await existing(join(root, '.native-store-clone'));
  if (marker) {
    const mode = await recoverNativeWriterSwitch(root, { provider, signal: options.signal });
    return { mode, candidate };
  }
  if (await existing(candidate)) {
    const mode = await recoverNativeWriterSwitch(root, { provider, signal: options.signal });
    if (mode !== 'python') throw new Error('writer switch state is invalid');
    return { mode, candidate };
  }
  await prepareCanonicalStoreClone(root, candidate, provider, options.now ? options.now() : undefined); options.signal?.throwIfAborted();
  return { mode: 'python', candidate };
}
function readiness(line) {
  try {
    const value = JSON.parse(line), url = new URL(value.url);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && value.origin === url.origin;
  } catch { return false; }
}
function launchSpec(options, root, nativeLock) {
  return () => ({ command: process.execPath, cwd: options.pluginRoot,
    argv: [join(options.pluginRoot, 'apps/companion/launch.mjs'), '--root', root, '--plugin-root', options.pluginRoot,
      '--port', String(options.port), '--writer', 'native-clone', '--native-lock', nativeLock,
      ...(options.dev ? ['--dev'] : [])],
    env: { ...process.env, COMPANION_PROCESS_OWNER: 'process-group-v1' }, ready: readiness, startupTimeoutMilliseconds: 60_000,
  });
}
export async function runSupervisor(options, { signal } = {}) {
  const root = resolveSupervisorRoot(options), nativeLock = options.nativeLock ?? await resolvePackagedNativeLock(options.pluginRoot);
  signal?.throwIfAborted();
  await validateSupervisorRoot(root);
  const provider = loadPosixFlockProvider(nativeLock);
  const exclusion = await acquireAttemptExclusion(root, provider);
  let controller;
  try {
    controller = new ProcessOwnedWriterController({ active: root, provider, createSpec: launchSpec(options, root, nativeLock) });
    const prepared = await controller.prepare(() => prepareNativeDefault(root, provider, { signal }));
    if (prepared.mode === 'python') {
      if (prepared.durablePythonRollback) throw new Error('retired rollback state requires the previous package');
      await assertNoLiveDetachedAttempt(root);
      try { await controller.activateQuiescent({ signal }); }
      catch (error) {
        if (await recoverNativeWriterSwitch(root, { provider }).catch(() => null) === 'native') {
          await writeFile(failedActivationMarker(root), 'native recovery required\n', { mode: 0o600 });
        }
        throw error;
      }
    }
    await controller.start('native', signal);
    const line = controller.startupLine;
    if (!line) throw new Error('Companion startup failed');
    const writerCompletion = controller.completion;
    if (!writerCompletion) throw new Error('Companion startup failed');
    const completion = writerCompletion.then(async () => {
      if (controller.stopping) return;
      await controller.stop(); throw new Error('Companion service stopped unexpectedly');
    });
    return { controller, line, completion };
  } catch (error) { await controller?.stop().catch(() => {}); throw error; }
  finally { await exclusion.release(); }
}

/** Performs the one-time Store switch for ordinary native CLI entry points. */
export async function activateStoreForCli(options, { signal } = {}) {
  const root = resolveSupervisorRoot(options), nativeLock = options.nativeLock ?? await resolvePackagedNativeLock(options.pluginRoot);
  signal?.throwIfAborted(); await validateSupervisorRoot(root);
  const provider = loadPosixFlockProvider(nativeLock);
  if (await existing(join(root, '.native-store-clone'))) {
    if (await recoverNativeWriterSwitch(root, { provider, signal }) !== 'native') throw new Error('native Store is not active');
    return root;
  }
  const exclusion = await acquireAttemptExclusion(root, provider);
  const controller = new ProcessOwnedWriterController({ active: root, provider,
    createSpec: () => { throw new Error('CLI activation does not start a writer'); } });
  try {
    const prepared = await controller.prepare(() => prepareNativeDefault(root, provider, { signal }));
    if (prepared.mode === 'python') {
      if (prepared.durablePythonRollback) throw new Error('native rollback is active');
      try { await controller.activateQuiescent({ signal }); }
      catch (error) {
        if (await recoverNativeWriterSwitch(root, { provider }).catch(() => null) === 'native') {
          await writeFile(failedActivationMarker(root), 'rollback required\n', { mode: 0o600 });
        }
        throw error;
      }
    }
    return root;
  } finally { await controller.stop().catch(() => {}); await exclusion.release(); }
}
export async function superviseMain(args = process.argv.slice(2), app = dirname(fileURLToPath(import.meta.url))) {
  let running;
  const abort = new AbortController(); let stopped = false;
  const stop = code => { stopped = true; abort.abort(); void running?.controller.stop().catch(() => {}); process.exitCode = code; };
  const interrupt = () => stop(0); process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try { running = await runSupervisor(parseSupervisorOptions(args, app), { signal: abort.signal }); process.stdout.write(`${running.line}\n`); }
  catch { process.stderr.write('Companion native supervisor failed\n'); stop(1); }
  try { if (running) await running.completion; }
  catch { if (!stopped) { process.stderr.write('Companion native supervisor failed\n'); process.exitCode = 1; } }
  finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await superviseMain();
