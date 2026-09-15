import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath } from 'node:fs/promises';
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

const values = new Set(['--root', '--plugin-root', '--port', '--native-lock']);
export function parseSupervisorOptions(args, app) {
  const options = { root: undefined, pluginRoot: resolve(app, '../..'), port: 0, nativeLock: undefined, dev: false, rollback: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (seen.has(key)) throw new Error('Duplicate supervisor option');
    seen.add(key);
    if (key === '--dev') { options.dev = true; continue; }
    if (key === '--rollback') { options.rollback = true; continue; }
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
  return resolve(options.root ?? environment.JOB_APPLY_STORE_DIR ?? join(home, '.job-apply'));
}
async function existing(path) { return lstat(path).then(() => true).catch(error => {
  if (error?.code === 'ENOENT') return false; throw error;
}); }
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
export async function prepareNativeDefault(root, provider, options = {}) {
  if (!isAbsolute(root) || root !== resolve(root) || await realpath(dirname(root)).catch(() => null) !== dirname(root)) {
    throw new Error('Companion Store root is invalid');
  }
  await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
  const bootstrap = createNativeStoreBootstrap(root, undefined, process.env, undefined, {
    ...(options.now ? { clock: options.now } : {}),
    locked: operation => withExclusiveFileLock(join(root, '.store.lock'), operation, {
      provider, pathProfile: '3.12', signal: AbortSignal.timeout(30_000),
    }),
  });
  await bootstrap.initialize(); await assertNoLiveDetachedAttempt(root);
  const candidate = `${root}.native-candidate`;
  const marker = await existing(join(root, '.native-store-clone'));
  if (marker) {
    const mode = await recoverNativeWriterSwitch(root, { provider });
    return { mode, candidate };
  }
  if (await existing(candidate)) {
    const mode = await recoverNativeWriterSwitch(root, { provider });
    if (mode !== 'python') throw new Error('writer switch state is invalid');
    return { mode, candidate };
  }
  await prepareCanonicalStoreClone(root, candidate, provider, options.now ? options.now() : undefined);
  return { mode: 'python', candidate };
}
function readiness(line) {
  try {
    const value = JSON.parse(line), url = new URL(value.url);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && value.origin === url.origin;
  } catch { return false; }
}
function launchSpec(options, root, nativeLock) {
  return mode => ({ command: process.execPath, cwd: options.pluginRoot,
    argv: [join(options.pluginRoot, 'apps/companion/launch.mjs'), '--root', root, '--plugin-root', options.pluginRoot,
      '--port', String(options.port), '--writer', mode === 'native' ? 'native-clone' : 'python',
      ...(mode === 'native' ? ['--native-lock', nativeLock] : []), ...(options.dev ? ['--dev'] : [])],
    env: { ...process.env, COMPANION_PROCESS_OWNER: 'process-group-v1' }, ready: readiness, startupTimeoutMilliseconds: 60_000,
  });
}
export async function runSupervisor(options) {
  const root = resolveSupervisorRoot(options), nativeLock = options.nativeLock ?? await resolvePackagedNativeLock(options.pluginRoot);
  const provider = loadPosixFlockProvider(nativeLock);
  await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
  const controller = new ProcessOwnedWriterController({ active: root, provider, createSpec: launchSpec(options, root, nativeLock) });
  try {
    const prepared = await controller.prepare(() => prepareNativeDefault(root, provider));
    if (options.rollback) {
      if (prepared.mode !== 'native') throw new Error('native rollback state is unavailable');
      await controller.start('native'); await assertNoLiveDetachedAttempt(root); await controller.rollback();
    } else {
      await controller.start(prepared.mode);
      if (prepared.mode === 'python') { await assertNoLiveDetachedAttempt(root); await controller.activate(); }
    }
    const line = controller.startupLine;
    if (!line) throw new Error('Companion startup failed');
    return { controller, line };
  } catch (error) { await controller.stop().catch(() => {}); throw error; }
}
async function main() {
  const app = dirname(fileURLToPath(import.meta.url));
  let running;
  const stop = async code => { await running?.controller.stop().catch(() => {}); process.exitCode = code; };
  process.on('SIGINT', () => { void stop(0); }); process.on('SIGTERM', () => { void stop(0); });
  try { running = await runSupervisor(parseSupervisorOptions(process.argv.slice(2), app)); process.stdout.write(`${running.line}\n`); }
  catch { process.stderr.write('Companion native supervisor failed\n'); await stop(1); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
