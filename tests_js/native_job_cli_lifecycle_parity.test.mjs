import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { copyFile, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { snapshot } from './workspace_native_claims_support.mjs';

const python = process.env.JOB_APPLY_REFERENCE_PYTHON || 'python3.12';
const timestamp = /^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|\+00:00)$/;

function normalized(value) {
  if (typeof value === 'string') return timestamp.test(value) ? '<timestamp>' : value;
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, normalized(item)]));
  return value;
}

async function context(t) {
  const fixture = await nativeFixture();
  t.after(() => fixture.cleanup());
  const home = await realpath(fixture.root);
  const roots = { python: join(home, 'python'), native: join(home, 'native') };
  const env = { ...process.env, HOME: home };
  function run(which, command, args = []) {
    const source = which === 'python';
    const result = spawnSync(source ? python : process.execPath, [
      source ? 'scripts/job-apply-store.py' : 'runtime/cli/native-jobs.js',
      '--root', roots[which], ...(source ? [] : ['--native-lock', fixture.receipt.artifact]),
      command, ...args,
    ], { cwd: new URL('../', import.meta.url), encoding: 'utf8', env, timeout: 15_000 });
    assert.ifError(result.error);
    return { status: result.status,
      output: result.stdout.trim() ? normalized(JSON.parse(result.stdout)) : null,
      error: result.stderr.trim().replace(/^job-apply-store:\s*/, '') };
  }
  assert.equal(run('python', 'init').status, 0);
  assert.equal(run('native', 'fixture-init').status, 0);
  // The two fixture initializers differ in metadata.createdAt. Start every
  // comparison from the same canonical jobs document instead of hiding it.
  await copyFile(join(roots.python, 'jobs.json'), join(roots.native, 'jobs.json'));
  const input = async (name, payload) => {
    const path = join(home, `${name}.json`);
    await writeFile(path, JSON.stringify(payload), { mode: 0o600 });
    return path;
  };
  async function pair(command, args = [], { unchanged = false } = {}) {
    const before = { python: await snapshot(roots.python), native: await snapshot(roots.native) };
    const source = run('python', command, args), candidate = run('native', command, args);
    assert.deepEqual(candidate, source, `${command} ${args.join(' ')}`);
    const sourceJobs = normalized(JSON.parse(await readFile(join(roots.python, 'jobs.json'))));
    const nativeJobs = normalized(JSON.parse(await readFile(join(roots.native, 'jobs.json'))));
    assert.deepEqual(nativeJobs, sourceJobs, `${command}: durable jobs document`);
    const after = { python: await snapshot(roots.python), native: await snapshot(roots.native) };
    for (const which of ['python', 'native']) {
      if (unchanged || source.status !== 0) assert.deepEqual(after[which], before[which], `${command}: ${which} changed state`);
      else {
        const { 'jobs.json': _before, ...otherBefore } = before[which];
        const { 'jobs.json': _after, ...otherAfter } = after[which];
        assert.deepEqual(otherAfter, otherBefore, `${command}: ${which} changed non-job state`);
      }
    }
    return source;
  }
  return { input, pair };
}

test('native job lifecycle CLI matches Python responses and durable state', { timeout: 60_000 }, async t => {
  const { input, pair } = await context(t);
  const create = await input('create', { id: 'job', url: 'https://example.invalid/job', role: 'Engineer', company: 'Example' });
  const update = await input('update', { role: 'Senior Engineer' });
  const id = ['--id', 'job'];
  await pair('job-get', ['--id', 'missing'], { unchanged: true });
  await pair('job-list', [], { unchanged: true });
  await pair('job-create', ['--input', create]);
  await pair('job-get', id, { unchanged: true });
  await pair('job-list', [], { unchanged: true });
  await pair('job-update', [...id, '--input', update, '--expected-revision', '1']);
  await pair('job-transition', [...id, '--status', 'needs_info', '--expected-revision', '2']);
  await pair('job-trash', [...id, '--expected-revision', '3']);
  await pair('job-get', id, { unchanged: true });
  await pair('job-get', [...id, '--include-trashed'], { unchanged: true });
  await pair('job-list', ['--trashed-only'], { unchanged: true });
  await pair('job-restore', [...id, '--expected-revision', '4']);
  await pair('job-trash', [...id, '--expected-revision', '5']);
  await pair('job-delete', [...id, '--expected-revision', '6']);
  await pair('job-list', ['--include-trashed'], { unchanged: true });
});

test('native job CLI rejects conflicts and invalid actions without changing state', { timeout: 60_000 }, async t => {
  const { input, pair } = await context(t);
  const create = await input('create', { id: 'job', url: 'https://example.invalid/job', role: 'Engineer' });
  const update = await input('update', { role: 'Senior Engineer' });
  const id = ['--id', 'job'];
  await pair('job-create', ['--input', create]);
  for (const [command, args] of [
    ['job-create', ['--input', create]],
    ['job-update', [...id, '--input', update, '--expected-revision', '99']],
    ['job-transition', [...id, '--status', 'bogus', '--expected-revision', '1']],
    ['job-transition', [...id, '--status', 'needs_info', '--expected-revision', '99']],
    ['job-trash', [...id, '--expected-revision', '99']],
    ['job-delete', [...id, '--expected-revision', '1']],
  ]) {
    const result = await pair(command, args, { unchanged: true });
    assert.equal(result.status, 2, command);
  }
  await pair('job-restore', [...id, '--expected-revision', '1'], { unchanged: true });
  await pair('job-trash', [...id, '--expected-revision', '1']);
  await pair('job-trash', [...id, '--expected-revision', '2'], { unchanged: true });
  const stale = await pair('job-restore', [...id, '--expected-revision', '1'], { unchanged: true });
  assert.equal(stale.status, 2);
  const staleDelete = await pair('job-delete', [...id, '--expected-revision', '1'], { unchanged: true });
  assert.equal(staleDelete.status, 2);
  await pair('job-delete', [...id, '--expected-revision', '2']);
  await pair('job-delete', [...id, '--expected-revision', '2'], { unchanged: true });
});
