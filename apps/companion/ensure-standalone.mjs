import { spawn } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { standaloneAssembled as assembled } from './standalone-assets.mjs';
import { resolvePackagedNativeLock } from '../../runtime/package/native-lock-artifact.js';
import { loadPosixFlockProvider } from '../../runtime/store/posix-flock.js';
import { ensureWindowsPrivateDirectory, openWindowsStoreFile, withWindowsStore } from '../../runtime/store/windows-store.js';

const windows = process.platform === 'win32';

/** Windows: npm is a .cmd shim, so run its JavaScript entry with this Node instead of a shell. */
export function npmCommand(args, environment = process.env, executable = process.execPath) {
  if (!windows) return { command: 'npm', args };
  const candidates = [environment.npm_execpath, join(dirname(executable), 'node_modules/npm/bin/npm-cli.js')];
  const cli = candidates.find(path => path && /npm-cli\.js$/i.test(path) && existsSync(path));
  if (!cli) throw new Error('npm is required to build the Companion');
  return { command: executable, args: [cli, ...args] };
}

async function run(command, args, cwd, signal) {
  signal.throwIfAborted();
  const selected = command === 'npm' ? npmCommand(args) : { command, args };
  await new Promise((resolve, reject) => {
    const child = spawn(selected.command, selected.args, { cwd, detached: !windows, stdio: 'ignore', windowsHide: true });
    const stop = () => {
      if (child.pid) {
        try { if (windows) child.kill(); else process.kill(-child.pid, 'SIGTERM'); }
        catch (error) { if (error.code !== 'ESRCH') reject(error); }
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

/** POSIX: an owned 0700 directory with an owned 0600 lock file. */
async function posixBuildLock(lockDir, provider) {
  await mkdir(lockDir, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const directory = await lstat(lockDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.()
    || (directory.mode & 0o777) !== 0o700 || await realpath(lockDir) !== lockDir) {
    throw new Error('Companion build lock directory is invalid');
  }
  const handle = await open(join(lockDir, 'lock'), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.getuid?.()
      || (metadata.mode & 0o777) !== 0o600) throw new Error('Companion build lock is invalid');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

async function withBuildLock(lockDir, provider, signal, operation) {
  const handle = windows
    // Windows: the lock directory and file are created with an owner-only ACL by the Store addon.
    ? await (async () => { await ensureWindowsPrivateDirectory(lockDir); return openWindowsStoreFile(join(lockDir, 'lock'), constants.O_RDWR | constants.O_CREAT); })()
    : await posixBuildLock(lockDir, provider);
  let locked = false;
  try {
    while (!locked) {
      signal.throwIfAborted();
      locked = provider.tryLock(handle.fd);
      if (!locked) await delay(100, undefined, { signal });
    }
    return await operation();
  } finally {
    if (locked) provider.unlock(handle.fd);
    await handle.close();
  }
}

/** Build a source-only marketplace installation once, before Store activation. */
export async function ensureStandalone(pluginRoot, { signal = new AbortController().signal,
  provider, runner = run, report = () => {} } = {}) {
  if (windows) pluginRoot = await realpath(pluginRoot);
  const app = join(pluginRoot, 'apps/companion');
  if (await assembled(app)) return false;
  const lockDir = join(app, '.companion-build');
  const build = lockProvider => withBuildLock(lockDir, lockProvider, signal, async () => {
    if (await assembled(app)) return false;
    report('Companion build missing; preparing this local installation.');
    await runner('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], pluginRoot, signal);
    await runner('npm', ['run', 'companion:build'], pluginRoot, signal);
    if (!await assembled(app)) throw new Error('Companion build did not produce standalone assets');
    return true;
  });
  if (windows) return withWindowsStore(lockDir, await resolvePackagedNativeLock(pluginRoot), selected => build(provider ?? selected));
  return build(provider ?? loadPosixFlockProvider(await resolvePackagedNativeLock(pluginRoot)));
}
