import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { copyFile, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { snapshot } from './workspace_native_claims_support.mjs';

const python = process.env.JOB_APPLY_REFERENCE_PYTHON || 'python3.12';
const timestamp = /^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|\+00:00)$/;
function normalize(value) {
  if (typeof value === 'string') return timestamp.test(value) ? '<timestamp>' : value;
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
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
      source ? 'scripts/job-apply-store.py' : 'runtime/cli/native-jobs.js', '--root', roots[which],
      ...(source ? [] : ['--native-lock', fixture.receipt.artifact]), command, ...args,
    ], { cwd: new URL('../', import.meta.url), encoding: 'utf8', env, timeout: 15_000 });
    assert.ifError(result.error);
    return { status: result.status,
      output: result.stdout.trim() ? normalize(JSON.parse(result.stdout)) : null,
      error: result.stderr.trim().replace(/^job-apply-store:\s*/, '') };
  }
  assert.equal(run('python', 'init').status, 0);
  assert.equal(run('native', 'fixture-init').status, 0);
  // Align initial metadata; compare every later mutation rather than hiding it.
  await copyFile(join(roots.python, 'profile.json'), join(roots.native, 'profile.json'));
  async function input(name, payload) {
    const path = join(home, `${name}.json`);
    await writeFile(path, JSON.stringify(payload), { mode: 0o600 });
    return path;
  }
  async function pair(command, args = [], { unchanged = false } = {}) {
    const before = { python: await snapshot(roots.python), native: await snapshot(roots.native) };
    const source = run('python', command, args), candidate = run('native', command, args);
    assert.deepEqual(candidate, source, `${command} ${args.join(' ')}`);
    const document = async which => normalize(JSON.parse(await readFile(join(roots[which], 'profile.json'))));
    assert.deepEqual(await document('native'), await document('python'), `${command}: durable profile document`);
    const after = { python: await snapshot(roots.python), native: await snapshot(roots.native) };
    for (const which of ['python', 'native']) {
      if (unchanged || source.status !== 0) assert.deepEqual(after[which], before[which], `${command}: ${which} changed state`);
      else {
        const { 'profile.json': _before, ...otherBefore } = before[which];
        const { 'profile.json': _after, ...otherAfter } = after[which];
        assert.deepEqual(otherAfter, otherBefore, `${command}: ${which} changed non-profile state`);
      }
    }
    return source;
  }
  return { input, pair };
}

test('native profile CLI matches Python reads, writes and durable state', { timeout: 60_000 }, async t => {
  const { input, pair } = await context(t);
  const replace = await input('replace', { firstName: 'Ada', contact: { email: 'ada@example.invalid' }, preferences: { remote: true } });
  const patch = await input('patch', { contact: { phone: '555' }, skills: ['TypeScript'] });
  const preferences = await input('preferences', { remote: false, travel: 'occasional' });
  const smaller = await input('smaller', { travel: 'none' });
  await pair('profile-get', [], { unchanged: true });
  await pair('profile-inspect', [], { unchanged: true });
  await pair('preferences-get', [], { unchanged: true });
  await pair('profile-replace', ['--input', replace, '--expected-revision', '1', '--source', 'user']);
  await pair('profile-patch', ['--input', patch, '--expected-revision', '2', '--source', 'resume']);
  await pair('preferences-set', ['--input', preferences, '--expected-revision', '3', '--source', 'user']);
  await pair('preferences-set', ['--input', smaller, '--expected-revision', '4', '--source', 'agent', '--replace']);
  await pair('profile-get', [], { unchanged: true });
  await pair('profile-inspect', [], { unchanged: true });
  await pair('preferences-get', [], { unchanged: true });
});

test('native profile CLI matches Python conflicts, invalid inputs and no-op writes', { timeout: 60_000 }, async t => {
  const { input, pair } = await context(t);
  const patch = await input('patch', { firstName: 'Ada' });
  const empty = await input('empty', {});
  await pair('profile-patch', ['--input', patch, '--expected-revision', '1', '--source', 'user']);
  await pair('profile-patch', ['--input', patch, '--expected-revision', '2', '--source', 'user'], { unchanged: true });
  for (const [command, args] of [
    ['profile-patch', ['--input', patch, '--expected-revision', '1', '--source', 'user']],
    ['profile-replace', ['--input', patch, '--expected-revision', '1', '--source', 'user']],
    ['preferences-set', ['--input', empty, '--expected-revision', '1', '--source', 'user']],
    ['profile-patch', ['--input', empty, '--expected-revision', '2', '--source', 'user']],
  ]) {
    const result = await pair(command, args, { unchanged: true });
    assert.equal(result.status, 2, command);
  }
});
