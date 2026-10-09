import { spawn } from 'node:child_process';
import { readFile, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { execute } from '../preparation/support.mjs';

/** Own every broker child through shutdown, including replacement after simulated loss. */
export async function startBroker(pluginRoot, fixture, arm) {
  const command = join(pluginRoot, 'apps/companion/command.mjs');
  const args = arm === 'candidate' ? [command, 'workflow', 'attempt', 'serve', '--root', fixture.storeRoot,
    '--native-lock', fixture.nativeLock] : [fileURLToPath(new URL('./baseline-broker.mjs', import.meta.url)),
    pluginRoot, fixture.storeRoot, fixture.nativeLock];
  const startedAt = Date.now();
  const child = spawn(process.execPath, args, { cwd: pluginRoot, env: { PATH: '', HOME: fixture.workspace },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', ended = false;
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { ended = true; resolve({ code, signal, stdout, stderr }); });
  });
  // Observe the PID published by this exact owned child; never infer ownership from an arbitrary file.
  const { nativeAttemptPidName } = await import(pathToFileURL(join(pluginRoot, 'runtime/store/native-store-layout.js')).href);
  const broker = { pid: child.pid, startedAt, done, async stop(signal = 'SIGTERM') {
    if (!ended) child.kill(signal);
    const escalation = setTimeout(() => { if (!ended) child.kill('SIGKILL'); }, 5000);
    try { return await done; } finally { clearTimeout(escalation); }
  } };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (ended) throw Error(`Owned broker exited during startup: ${stderr}`);
      try { ready = (await readFile(join(fixture.storeRoot, nativeAttemptPidName), 'utf8')).trim() === String(child.pid); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (ready) break;
      await delay(25);
    }
    if (!ready) throw Error('Owned broker did not publish its PID');
    if (arm === 'candidate') {
      const response = await execute(process.execPath, [command, 'workflow', 'attempt', 'context',
        '--root', fixture.storeRoot, '--native-lock', fixture.nativeLock], { cwd: pluginRoot, env: { PATH: '' } });
      if (response.code !== 0 || response.failure || JSON.parse(response.stdout).ok !== true) throw Error('Candidate broker not ready');
    }
    return broker;
  } catch (error) { await broker.stop(); throw error; }
}

export async function cleanupBrokerArtifacts(pluginRoot, fixture) {
  const { assertNoLiveDetachedAttempt } = await import(pathToFileURL(join(pluginRoot, 'apps/companion/supervise.mjs')).href);
  await assertNoLiveDetachedAttempt(fixture.storeRoot);
  const { attemptSocketPath } = await import(pathToFileURL(join(pluginRoot, 'runtime/cli/attempt-protocol.js')).href);
  const socket = attemptSocketPath(fixture.storeRoot, process.getuid());
  const removed = [];
  // Caller must stop/await all owned children before removing their unique fixture paths.
  for (const path of [socket, `${socket}.lock`]) {
    let stat;
    try { stat = await lstat(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.uid !== process.getuid() || stat.isSymbolicLink() || (stat.mode & 0o077)
      || !(path === socket ? stat.isSocket() : stat.isFile() && stat.nlink === 1)) throw Error('Unexpected broker artifact');
    await unlink(path); removed.push(path);
  }
  return removed;
}
