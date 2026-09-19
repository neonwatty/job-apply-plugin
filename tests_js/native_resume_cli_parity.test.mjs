import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { snapshot } from './workspace_native_claims_support.mjs';

const python = process.env.JOB_APPLY_REFERENCE_PYTHON || 'python3.12';
const timestamp = /^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|\+00:00)$/;
const contentRevision = /^content_[A-Za-z0-9_-]{32,128}$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function normalized(value, roots) {
  if (typeof value === 'string') {
    if (timestamp.test(value)) return '<timestamp>';
    if (contentRevision.test(value)) return '<content-revision>';
    for (const root of Object.values(roots)) if (value.startsWith(root + '/')) return '<store>' + value.slice(root.length);
    return value;
  }
  if (Array.isArray(value)) return value.map(item => normalized(item, roots));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, normalized(item, roots)]));
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
      output: result.stdout.trim() ? normalized(JSON.parse(result.stdout), roots) : null,
      error: result.stderr.trim().replace(/^job-apply-store:\s*/, '') };
  }
  assert.equal(run('python', 'init').status, 0);
  assert.equal(run('native', 'fixture-init').status, 0);
  await copyFile(join(roots.python, 'resumes.json'), join(roots.native, 'resumes.json'));
  async function input(name, payload) {
    const path = join(home, `${name}.json`);
    await writeFile(path, JSON.stringify(payload), { mode: 0o600 });
    return path;
  }
  async function privateFiles(which) {
    const directory = join(roots[which], 'resume-files');
    const names = (await readdir(directory)).sort();
    return Object.fromEntries(await Promise.all(names.map(async name => {
      const path = join(directory, name), metadata = await stat(path);
      return [name, { digest: sha256(await readFile(path)), mode: metadata.mode & 0o777 }];
    })));
  }
  async function pair(command, args = [], { unchanged = false } = {}) {
    const before = { python: await snapshot(roots.python), native: await snapshot(roots.native) };
    const filesBefore = { python: await privateFiles('python'), native: await privateFiles('native') };
    const source = run('python', command, args), candidate = run('native', command, args);
    assert.deepEqual(candidate, source, `${command} ${args.join(' ')}`);
    const document = async which => normalized(JSON.parse(await readFile(join(roots[which], 'resumes.json'))), roots);
    assert.deepEqual(await document('native'), await document('python'), `${command}: durable resumes document`);
    assert.deepEqual(await privateFiles('native'), await privateFiles('python'), `${command}: private managed bytes and modes`);
    for (const which of ['python', 'native']) {
      const after = await snapshot(roots[which]);
      if (unchanged || source.status !== 0) {
        assert.deepEqual(after, before[which], `${command}: ${which} changed state`);
        assert.deepEqual(await privateFiles(which), filesBefore[which], `${command}: ${which} changed private files`);
      } else {
        const { 'resumes.json': _before, ...otherBefore } = before[which];
        const { 'resumes.json': _after, ...otherAfter } = after;
        assert.deepEqual(otherAfter, otherBefore, `${command}: ${which} changed unrelated state`);
      }
    }
    return source;
  }
  return { home, input, pair, roots };
}

test('native resume CLI matches Python lifecycle, private bytes and durable state', { timeout: 90_000 }, async t => {
  const { home, input, pair } = await context(t);
  const source = join(home, 'source.txt');
  await writeFile(source, 'Synthetic private resume content\n', { mode: 0o600 });
  const create = await input('resume-create', { id: 'resume-one', label: 'First resume', path: source, tags: ['typescript'] });
  const patch = await input('resume-patch', { label: 'Updated resume', tags: ['typescript', 'python'] });
  const id = ['--id', 'resume-one'];
  await pair('resume-get', ['--id', 'missing'], { unchanged: true });
  await pair('resume-list', [], { unchanged: true });
  const created = await pair('resume-create', ['--input', create]);
  assert.equal(JSON.stringify(created.output).includes(source), false, 'source path leaked');
  await pair('resume-get', id, { unchanged: true });
  await pair('resume-list', [], { unchanged: true });
  await pair('resume-check', id, { unchanged: true });
  await pair('resume-resolve', [], { unchanged: true });
  await pair('resume-update', [...id, '--input', patch, '--expected-revision', '1']);
  await pair('resume-set-default', [...id, '--expected-revision', '2'], { unchanged: true });
  await pair('resume-trash', [...id, '--expected-revision', '2']);
  await pair('resume-get', id, { unchanged: true });
  await pair('resume-get', [...id, '--include-trashed'], { unchanged: true });
  await pair('resume-list', ['--trashed-only'], { unchanged: true });
  await pair('resume-restore', [...id, '--expected-revision', '3']);
  await pair('resume-trash', [...id, '--expected-revision', '4']);
  await pair('resume-delete', [...id, '--expected-revision', '5']);
  await pair('resume-list', ['--include-trashed'], { unchanged: true });
});

test('native resume CLI rejects conflicts and invalid inputs without side effects', { timeout: 90_000 }, async t => {
  const { home, input, pair } = await context(t);
  const source = join(home, 'source.txt');
  await writeFile(source, 'Synthetic private resume content\n', { mode: 0o600 });
  const create = await input('resume-create', { id: 'resume-one', label: 'First resume', path: source });
  const bad = await input('resume-invalid', { path: source, unexpected: true });
  const patch = await input('resume-patch', { label: 'Changed' });
  const id = ['--id', 'resume-one'];
  await pair('resume-create', ['--input', create]);
  for (const [command, args] of [
    ['resume-create', ['--input', create]],
    ['resume-create', ['--input', bad]],
    ['resume-update', [...id, '--input', patch, '--expected-revision', '99']],
    ['resume-update', [...id, '--input', bad, '--expected-revision', '1']],
    ['resume-trash', [...id, '--expected-revision', '99']],
    ['resume-delete', [...id, '--expected-revision', '1']],
  ]) {
    const result = await pair(command, args, { unchanged: true });
    assert.equal(result.status, 2, command);
  }
  await pair('resume-restore', [...id, '--expected-revision', '1'], { unchanged: true });
  await pair('resume-trash', [...id, '--expected-revision', '1']);
  await pair('resume-trash', [...id, '--expected-revision', '2'], { unchanged: true });
  await pair('resume-restore', [...id, '--expected-revision', '1'], { unchanged: true });
});

test('native resume CLI rejects unknown create fields with Python diagnostic', { timeout: 60_000 }, async t => {
  const { input, pair } = await context(t);
  const malformed = await input('resume-unknown-field', { unexpected: true });
  const result = await pair('resume-create', ['--input', malformed], { unchanged: true });
  assert.equal(result.status, 2);
});
