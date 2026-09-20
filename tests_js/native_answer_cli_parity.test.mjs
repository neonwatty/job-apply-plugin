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
  await copyFile(join(roots.python, 'answers.json'), join(roots.native, 'answers.json'));
  async function input(name, payload) {
    const path = join(home, `${name}.json`);
    await writeFile(path, JSON.stringify(payload), { mode: 0o600 });
    return path;
  }
  async function pair(command, args = [], { unchanged = false } = {}) {
    const before = { python: await snapshot(roots.python), native: await snapshot(roots.native) };
    const source = run('python', command, args), candidate = run('native', command, args);
    assert.deepEqual(candidate, source, `${command} ${args.join(' ')}`);
    const document = async which => normalize(JSON.parse(await readFile(join(roots[which], 'answers.json'))));
    assert.deepEqual(await document('native'), await document('python'), `${command}: durable answers document`);
    const after = { python: await snapshot(roots.python), native: await snapshot(roots.native) };
    for (const which of ['python', 'native']) {
      if (unchanged || source.status !== 0) assert.deepEqual(after[which], before[which], `${command}: ${which} changed state`);
      else {
        const { 'answers.json': _before, ...otherBefore } = before[which];
        const { 'answers.json': _after, ...otherAfter } = after[which];
        assert.deepEqual(otherAfter, otherBefore, `${command}: ${which} changed non-answer state`);
      }
    }
    return source;
  }
  return { input, pair };
}

test('native answer CLI matches Python lifecycle and durable state', { timeout: 60_000 }, async t => {
  const { input, pair } = await context(t);
  const question = 'Are you authorized to work?';
  const key = (await pair('answer-key', ['--question', question], { unchanged: true })).output.key;
  const first = await input('answer-first', { question, state: 'confirmed', value: 'Yes', aliases: ['Employment authorization?'] });
  await pair('answer-get', ['--key', key], { unchanged: true });
  await pair('answer-put', ['--input', first]);
  await pair('answer-find', ['--question', question], { unchanged: true });
  await pair('answer-get', ['--key', key], { unchanged: true });
  await pair('answer-list', ['--query', 'authorized'], { unchanged: true });
  const patch = await input('answer-patch', { value: 'Yes, without sponsorship' });
  await pair('answer-update', ['--key', key, '--input', patch, '--expected-revision', '1']);
  await pair('answer-trash', ['--key', key, '--expected-revision', '2']);
  await pair('answer-get', ['--key', key], { unchanged: true });
  await pair('answer-get', ['--key', key, '--include-trashed'], { unchanged: true });
  await pair('answer-list', ['--trashed-only', '--all-review-statuses'], { unchanged: true });
  await pair('answer-restore', ['--key', key, '--expected-revision', '3']);
  await pair('answer-delete', ['--key', key, '--expected-revision', '4']);
  await pair('answer-get', ['--key', key], { unchanged: true });
});

test('native answer CLI matches Python privacy, conflicts and invalid writes', { timeout: 60_000 }, async t => {
  const { input, pair } = await context(t);
  const privateAnswer = await input('answer-private', { question: 'What is your salary?', state: 'sensitive', value: '$100,000', sensitivity: 'high' });
  const denied = await pair('answer-put', ['--input', privateAnswer], { unchanged: true });
  assert.equal(denied.status, 2);
  const accepted = await pair('answer-put', ['--input', privateAnswer, '--remember-sensitive']);
  const key = accepted.output.key;
  const concealed = await pair('answer-get', ['--key', key], { unchanged: true });
  assert.equal(Object.hasOwn(concealed.output, 'value'), false);
  const revealed = await pair('answer-reveal', ['--key', key], { unchanged: true });
  assert.equal(revealed.output.value, '$100,000');
  const stale = await pair('answer-update', ['--key', key, '--input', privateAnswer, '--expected-revision', '2'], { unchanged: true });
  assert.equal(stale.status, 2);
  const invalid = await input('answer-invalid', { question: 'Invalid?', state: 'confirmed' });
  assert.equal((await pair('answer-put', ['--input', invalid], { unchanged: true })).status, 2);
});
