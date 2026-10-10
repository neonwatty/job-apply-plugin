import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { cp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup } from './workspace_native_claims_support.mjs';

export async function installedHost(t) {
  const fixture = await nativeFixture();
  const brokers = [];
  t.after(async () => {
    try {
      for (const { child, done } of brokers) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await done;
      }
    } finally { await fixture.cleanup(); }
  });
  const state = await setup(fixture, 'host-store');
  const plugin = join(fixture.root, 'plugin'), home = join(fixture.root, 'home');
  await mkdir(home, { mode: 0o700 });
  await mkdir(join(plugin, 'apps/companion'), { recursive: true });
  // Assemble the actual command/runtime/skill files without source or dependencies.
  for (const tree of ['runtime', 'skills']) {
    await cp(new URL(`../${tree}/`, import.meta.url), join(plugin, tree), { recursive: true });
  }
  for (const file of await readdir(new URL('../apps/companion/', import.meta.url))) {
    if (file.endsWith('.mjs')) await cp(new URL(`../apps/companion/${file}`, import.meta.url), join(plugin, 'apps/companion', file));
  }
  await writeFile(join(plugin, 'package.json'), '{"type":"module"}');
  const command = join(plugin, 'apps/companion/command.mjs');
  const env = { HOME: home, PATH: '', JOB_APPLY_STORE_DIR: join(home, 'configured-owner-store') };
  const common = ['--root', state.root, '--native-lock', fixture.receipt.artifact];
  let serial = 0;
  async function invoke(args) {
    let result;
    try { result = { ...await promisify(execFile)(process.execPath, [command, ...args], { cwd: plugin, env, timeout: 10000 }), code: 0 }; }
    catch (error) { if (typeof error.code !== 'number') throw error; result = error; }
    assert.equal(result.stderr, '');
    assert.ok([0, 2].includes(result.code), result.stdout);
    const response = JSON.parse(result.stdout);
    assert.equal(result.code, response.ok ? 0 : 2);
    return response;
  }
  async function workflow(phase, operation, payload, extra = [], scope = common) {
    const args = ['workflow', phase, operation, ...scope, ...extra];
    if (payload !== undefined) {
      const input = join(fixture.root, `proposal-${++serial}.json`);
      await writeFile(input, typeof payload === 'string' ? payload : JSON.stringify(payload), { mode: 0o600 });
      args.push('--input', input);
    }
    const response = await invoke(args);
    assert.doesNotMatch(JSON.stringify(response), /PRIVATE|tokenHash|claim_[A-Za-z0-9_-]{43}|configured-owner-store/);
    return response;
  }
  async function serve(trusted = false) {
    const args = trusted ? [fileURLToPath(new URL('./workspace_host_approval_process_support.mjs', import.meta.url)), plugin, ...common]
      : [command, 'workflow', 'attempt', 'serve', ...common];
    const child = spawn(process.execPath, args, { cwd: plugin, env,
      stdio: trusted ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    brokers.push({ child, done });
    let ready;
    for (let index = 0; index < 100; index++) {
      ready = await workflow('attempt', 'context');
      if (ready.ok) break;
      await delay(25);
    }
    assert.equal(ready.ok, true, stderr);
    return { child, done };
  }
  return { fixture, state, plugin, home, command, common, invoke, workflow, serve };
}
