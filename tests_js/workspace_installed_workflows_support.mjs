import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
const execute = promisify(execFile);

/** A copied executable installation, with no imports or links back to source runtime. */
export async function installedFixture() {
  const fixture = await nativeFixture();
  const directory = await realpath(fixture.root), plugin = join(directory, 'plugin');
  const root = join(directory, 'store'), home = join(directory, 'home');
  const calls = [], brokers = new Set();
  let serial = 0;
  try {
    await cp(new URL('../runtime/', import.meta.url), join(plugin, 'runtime'), { recursive: true });
    await mkdir(join(plugin, 'apps/companion'), { recursive: true });
    for (const name of await readdir(new URL('../apps/companion/', import.meta.url))) {
      if (name.endsWith('.mjs')) await cp(new URL(`../apps/companion/${name}`, import.meta.url), join(plugin, 'apps/companion', name));
    }
    await writeFile(join(plugin, 'package.json'), '{"type":"module"}');
    await mkdir(home, { mode: 0o700 });
    const env = { PATH: '', HOME: home }, scope = ['--root', root, '--native-lock', fixture.receipt.artifact];
    const launcher = join(plugin, 'apps/companion/command.mjs');
    async function call(surface, commands, payload, extra = [], options = {}) {
      const script = options.direct ? join(plugin, 'runtime/cli/native-jobs.js') : launcher;
      const args = [...(options.direct ? [] : [surface]), ...commands, ...scope, ...extra];
      if (payload !== undefined) {
        const input = join(directory, `input-${++serial}.json`);
        await writeFile(input, JSON.stringify(payload), { mode: 0o600 }); args.push('--input', input);
      }
      const start = performance.now();
      let result;
      try { result = { ...await execute(process.execPath, [script, ...args], { cwd: plugin, env, timeout: 15000 }), code: 0 }; }
      catch (error) { if (typeof error.code !== 'number') throw error; result = error; }
      calls.push({ surface, command: commands.join(' '), code: result.code, elapsedMs: performance.now() - start });
      assert.ok([0, 2].includes(result.code));
      if (options.reject) { assert.equal(result.code, 2); return null; }
      assert.equal(result.stderr, '', result.stderr);
      const response = JSON.parse(result.stdout);
      if (surface === 'workflow') assert.doesNotMatch(result.stdout, /tokenHash|claim_[A-Za-z0-9_-]{43}/);
      if (!options.failure) {
        assert.equal(result.code, 0, result.stdout);
        if (surface === 'workflow') assert.equal(response.ok, true, result.stdout);
      }
      return surface === 'workflow' && response.ok ? response.result : response;
    }
    async function stopBroker(broker) {
      if (!brokers.has(broker)) return;
      if (broker.child.exitCode === null && broker.child.signalCode === null) broker.child.kill('SIGTERM');
      await broker.exited; brokers.delete(broker);
      assert.equal(broker.errors, '');
    }
    async function startBroker() {
      const child = spawn(process.execPath, [launcher, 'workflow', 'campaign', 'serve', ...scope], { cwd: plugin, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const broker = { child, errors: '', exited: null };
      child.stderr.on('data', data => { broker.errors += data; });
      child.stdout.resume();
      broker.exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      brokers.add(broker);
      for (let tries = 0; tries < 100; tries++) {
        const pid = await readFile(join(root, '.job-apply-attempt.pid'), 'utf8').catch(() => '');
        if (pid.trim() === String(child.pid)) return broker;
        if (child.exitCode !== null || child.signalCode !== null) throw Error('Fixture broker exited before ready');
        await delay(20);
      }
      throw Error('Fixture broker did not become ready');
    }
    const cleanup = async () => {
      for (const broker of [...brokers]) await stopBroker(broker);
      try { assert.deepEqual(await readdir(home), []); } finally { await fixture.cleanup(); }
    };
    await call('store', ['fixture-init'], undefined, [], { direct: true });
    return { root, plugin, directory, nativeLock: fixture.receipt.artifact, calls, call, startBroker, stopBroker, cleanup };
  } catch (error) { await fixture.cleanup(); throw error; }
}

/** Includes archived records and managed files; broker PID/lock bookkeeping is excluded. */
export async function durableSnapshot(root) {
  const result = {};
  async function visit(path, relative = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = relative + entry.name;
      if (entry.isDirectory()) await visit(join(path, entry.name), name + '/');
      else if (entry.isFile() && !entry.name.startsWith('.')) result[name] = (await readFile(join(path, entry.name))).toString('base64');
    }
  }
  await visit(root);
  return result;
}
export const readDocument = async (root, name) => JSON.parse(await readFile(join(root, name), 'utf8'));
