import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fromJSON } from '../runtime/contracts/workspace/values.js';
import { NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { atomicWritePointJson, createNativePointAtomicWriteIO } from '../runtime/store/point-persistence.js';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { TaskIntakeService } from '../runtime/workspace-core/task-intake.js';
import { assertRejections, assertSuccess, cliStore } from './native_cli_contract_support.mjs';
import { snapshotFiles } from './legacy_store_migration_support.mjs';

function fromStdin(argumentsForStore, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argumentsForStore, {
      cwd: new URL('../', import.meta.url), env: { PATH: '' },
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      if (signal) reject(Error('Task intake child was interrupted: ' + signal));
      else resolve({ status, stdout, stderr });
    });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(JSON.stringify(payload));
  });
}

test('Store task intake defaults to agent, accepts large stdin, and preserves private data and no-op bytes', async t => {
  const store = await cliStore(t);
  const payload = { url: 'https://example.invalid/intake', role: 'CLI role', description: 'PRIVATE ' + 'x'.repeat(81920) };
  const args = [...store.args, 'task-intake', '--input', '-'];
  const result = assertSuccess(await fromStdin(args, payload), 'task-intake');
  assert.equal(result.action, 'create');
  assert.equal(result.job.role, 'CLI role');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|https:|description|provenance/);
  const saved = await store.call('job-get', ['--id', result.job.id]);
  assert.equal(saved.description, payload.description);
  assert.equal(saved.provenance['/role'].origin, 'agent');

  const input = join(store.home, 'intake.json');
  await writeFile(input, JSON.stringify(payload), { mode: 0o600 });
  const before = await snapshotFiles(store.root);
  const repeated = await store.call('task-intake', ['--input', input]);
  assert.deepEqual(repeated, { action: 'noop', job: result.job });
  assert.deepEqual(await snapshotFiles(store.root), before);

  await assertRejections(store, [
    ['task-intake', [], /input/],
    ['task-intake', ['--input', input, '--origin', 'migration'], /origin must be human or agent/],
    ['task-intake', ['--input', input, '--unknown', 'x'], /unsupported/],
  ]);
  const malformed = await fromStdin(args, { url: 'PRIVATE INVALID URL' });
  assert.equal(malformed.status, 2);
  assert.equal(malformed.stdout, '');
  assert.match(malformed.stderr, /task intake invalid/);
  assert.doesNotMatch(malformed.stderr, /PRIVATE INVALID URL/);
  assert.deepEqual(await snapshotFiles(store.root), before);

  await writeFile(input, JSON.stringify({ ...payload, role: 'Human role' }), { mode: 0o600 });
  assert.equal((await store.call('task-intake', ['--input', input, '--origin', 'agent', '--origin', 'human'])).action, 'update');
  await writeFile(input, JSON.stringify({ ...payload, role: 'Ignored agent role' }), { mode: 0o600 });
  assert.equal((await store.call('task-intake', ['--input', input])).job.role, 'Human role');
});

test('Task intake preserves canonical bytes after write, sync, and replacement failures and permits retry', async t => {
  const store = await cliStore(t);
  const provider = loadPosixFlockProvider(store.lock);
  const payload = { url: 'https://example.invalid/intake-write-failure', role: 'Synthetic Engineer' };
  const before = await snapshotFiles(store.root);
  for (const stage of ['write', 'sync', 'replace']) {
    await t.test(stage, async () => {
      const fail = async () => { throw Error('injected intake write failure'); };
      const repository = new NativeJobsRepository(store.root, provider, async (path, value, options) => {
        const io = createNativePointAtomicWriteIO(options.pathProfile);
        if (stage === 'replace') {
          io.replace = fail;
        } else {
          const original = io.createTemporary;
          io.createTemporary = async (...args) => {
            const handle = await original(...args);
            handle[stage] = fail;
            return handle;
          };
        }
        await atomicWritePointJson(path, value, options, io);
      });
      await assert.rejects(new TaskIntakeService(repository).intake(fromJSON(payload)), /injected intake write failure/);
      assert.deepEqual(await snapshotFiles(store.root), before);
      assert.equal((await readdir(store.root)).some(name => name.endsWith('.tmp')), false);
    });
  }
  const args = [...store.args, 'task-intake', '--input', '-'];
  const retried = assertSuccess(await fromStdin(args, payload), 'task-intake retry');
  assert.equal(retried.action, 'create');
  assert.equal((await store.call('job-get', ['--id', retried.job.id])).revision, 1);
});
