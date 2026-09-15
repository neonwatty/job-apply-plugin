import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { nativeFixture } from './exclusive_file_lock_support.mjs';

export async function spawnOwnedCompanion(pluginRoot, store, writerArgs, options = {}) {
  const canonicalPluginRoot = await realpath(pluginRoot);
  const fixture = options.leaseArtifact ? null : await nativeFixture();
  const provider = loadPosixFlockProvider(options.leaseArtifact ?? fixture.receipt.artifact);
  const lease = await open(join(dirname(store), `.${basename(store)}.workspace-test-owner.lock`),
    constants.O_RDWR | constants.O_CREAT, 0o600);
  await lease.chmod(0o600);
  if (!provider.tryLock(lease.fd)) {
    await lease.close();
    await fixture?.cleanup();
    throw new Error('Workspace test writer ownership is unavailable');
  }

  let child;
  try {
    child = spawn(process.execPath, [join(canonicalPluginRoot, 'apps/companion/launch.mjs'),
      '--root', store, '--plugin-root', canonicalPluginRoot, ...writerArgs,
      ...(options.args ?? [])], {
      cwd: canonicalPluginRoot,
      env: { ...process.env, ...options.env, COMPANION_PROCESS_OWNER: 'process-group-v1' },
      detached: process.platform !== 'win32',
      // fd 3 carries the exclusive writer lease; fd 4 detects test-owner death.
      stdio: ['ignore', 'pipe', 'pipe', lease.fd, 'pipe'],
    });
  } catch (error) {
    provider.unlock(lease.fd);
    await lease.close();
    await fixture?.cleanup();
    throw error;
  }

  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve));
  let finalized;
  async function finalize() {
    if (finalized) return finalized;
    finalized = (async () => {
      provider.unlock(lease.fd);
      await lease.close();
      await fixture?.cleanup();
    })();
    return finalized;
  }
  function signalGroup(signal) {
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  async function stop() {
    child.stdio[4]?.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      signalGroup('SIGTERM');
      const graceful = await Promise.race([
        exited.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 1000)),
      ]);
      if (!graceful) signalGroup('SIGKILL');
      await exited;
    }
    await finalize();
  }
  child.once('exit', () => { void finalize(); });
  return { child, stop, release: stop };
}

export function spawnOwnedPythonCompanion(pluginRoot, store, options = {}) {
  return spawnOwnedCompanion(pluginRoot, store, ['--writer', 'python'], options);
}
