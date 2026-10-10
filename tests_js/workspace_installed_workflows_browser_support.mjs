import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function installedBrowserHost(state, grant) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./workspace_installed_workflows_browser_host.mjs', import.meta.url)),
    state.plugin, state.root, state.nativeLock], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { PATH: '', HOME: join(state.directory, 'home') } });
  let errors = '', serial = 0;
  child.stderr.on('data', data => { errors += data; });
  child.stdout.resume();
  const done = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const trusted = message => new Promise((resolve, reject) => {
    const id = ++serial;
    const cleanup = () => { clearTimeout(timer); child.off('message', receive); child.off('close', closed); };
    const closed = () => { cleanup(); reject(Error(`Trusted fixture exited during ${message.kind}: ${errors}`)); };
    const timer = setTimeout(() => {
      cleanup(); reject(Error(`Trusted fixture channel timed out (${message.kind}): ${errors}`));
    }, 10000);
    function receive(response) {
      if (response.id !== id) return;
      cleanup();
      if (response.ok) resolve(response.result); else reject(Error('Trusted fixture rejected request'));
    }
    child.on('message', receive); child.once('close', closed);
    child.send({ id, ...message }, error => { if (error) { cleanup(); reject(error); } });
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const result = await done;
    assert.equal(errors, ''); assert.equal(result.code, 0);
  };
  try {
    await trusted({ kind: 'initialize', grant });
    for (let tries = 0; tries < 100; tries++) {
      const pid = await readFile(join(state.root, '.job-apply-attempt.pid'), 'utf8').catch(() => '');
      if (pid.trim() === String(child.pid)) return { trusted, stop };
      if (child.exitCode !== null || child.signalCode !== null) throw Error('Browser fixture exited before ready');
      await delay(20);
    }
    throw Error('Browser fixture did not start');
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await done;
    throw error;
  }
}
