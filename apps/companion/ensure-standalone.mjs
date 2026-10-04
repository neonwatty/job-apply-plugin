import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolvePackagedNativeLock } from '../../runtime/package/native-lock-artifact.js';
import { loadPosixFlockProvider } from '../../runtime/store/posix-flock.js';

async function assembled(app) {
  const server = await lstat(join(app, '.next/standalone/apps/companion/server.js')).catch(() => null);
  const staticAssets = await lstat(join(app, '.next/standalone/apps/companion/.next/static')).catch(() => null);
  return server?.isFile() && !server.isSymbolicLink()
    && staticAssets?.isDirectory() && !staticAssets.isSymbolicLink();
}

async function run(command, args, cwd, signal) {
  signal.throwIfAborted();
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, detached: true, stdio: 'ignore' });
    const stop = () => {
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') reject(error); }
      }
    };
    signal.addEventListener('abort', stop, { once: true });
    child.once('error', error => { signal.removeEventListener('abort', stop); reject(error); });
    child.once('exit', code => {
      signal.removeEventListener('abort', stop);
      if (signal.aborted) reject(signal.reason);
      else if (code === 0) resolve();
      else reject(new Error(`${command} ${args[0]} failed`));
    });
  });
}

/** Build a source-only marketplace installation once, before Store activation. */
export async function ensureStandalone(pluginRoot, { signal = new AbortController().signal,
  provider, runner = run, report = () => {} } = {}) {
  const app = join(pluginRoot, 'apps/companion');
  if (await assembled(app)) return false;
  const lockProvider = provider ?? loadPosixFlockProvider(await resolvePackagedNativeLock(pluginRoot));
  const lockDir = join(app, '.companion-build');
  await mkdir(lockDir, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const directory = await lstat(lockDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.()
    || (directory.mode & 0o777) !== 0o700 || await realpath(lockDir) !== lockDir) {
    throw new Error('Companion build lock directory is invalid');
  }
  const handle = await open(join(lockDir, 'lock'), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  let locked = false;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.getuid?.()
      || (metadata.mode & 0o777) !== 0o600) throw new Error('Companion build lock is invalid');
    while (!locked) {
      signal.throwIfAborted();
      locked = lockProvider.tryLock(handle.fd);
      if (!locked) await delay(100, undefined, { signal });
    }
    if (await assembled(app)) return false;
    report('Companion build missing; preparing this local installation.');
    await runner('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], pluginRoot, signal);
    await runner('npm', ['run', 'companion:build'], pluginRoot, signal);
    if (!await assembled(app)) throw new Error('Companion build did not produce standalone assets');
    return true;
  } finally {
    if (locked) lockProvider.unlock(handle.fd);
    await handle.close();
  }
}
