import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { packageNativeLock } from '../scripts/smoke/package_native_lock.mjs';
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
  function invocation(which, command, args = []) {
    const source = which === 'python';
    return { executable: source ? python : process.execPath, args: [
      source ? 'scripts/job-apply-store.py' : 'runtime/cli/native-jobs.js',
      '--root', roots[which], ...(source ? [] : ['--native-lock', fixture.receipt.artifact]),
      command, ...args,
    ] };
  }
  const resultOf = (status, stdout, stderr) => ({ status,
    output: stdout.trim() ? normalized(JSON.parse(stdout)) : null,
    error: stderr.trim().replace(/^job-apply-store:\s*/, '') });
  function run(which, command, args = []) {
    const call = invocation(which, command, args);
    const result = spawnSync(call.executable, call.args,
      { cwd: new URL('../', import.meta.url), encoding: 'utf8', env, timeout: 15_000 });
    assert.ifError(result.error);
    return resultOf(result.status, result.stdout, result.stderr);
  }
  function runConcurrent(which, command, args = []) {
    const call = invocation(which, command, args);
    return new Promise((resolve, reject) => {
      const child = spawn(call.executable, call.args,
        { cwd: new URL('../', import.meta.url), env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('close', (status, signal) => {
        clearTimeout(timeout);
        if (signal) reject(Error(`${which} ${command} exited with ${signal}: ${stderr}`));
        else {
          try { resolve(resultOf(status, stdout, stderr)); } catch (error) { reject(error); }
        }
      });
    });
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
  async function parallelPair(command, args, count = 4) {
    const before = { python: await snapshot(roots.python), native: await snapshot(roots.native) };
    const [source, candidate] = await Promise.all(['python', 'native'].map(which =>
      Promise.all(Array.from({ length: count }, () => runConcurrent(which, command, args)))));
    const ordered = values => values.slice().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    assert.deepEqual(ordered(candidate), ordered(source), `${command}: concurrent outcomes`);
    assert.equal(source.filter(item => item.status === 0).length, 1, `${command}: exactly one writer`);
    assert.equal(source.filter(item => item.status === 2).length, count - 1, `${command}: rejected competitors`);
    assert.deepEqual(normalized(JSON.parse(await readFile(join(roots.native, 'jobs.json')))),
      normalized(JSON.parse(await readFile(join(roots.python, 'jobs.json')))), `${command}: durable jobs`);
    for (const which of ['python', 'native']) {
      const after = await snapshot(roots[which]);
      const { 'jobs.json': _before, ...otherBefore } = before[which];
      const { 'jobs.json': _after, ...otherAfter } = after;
      assert.deepEqual(otherAfter, otherBefore, `${command}: ${which} changed non-job state`);
    }
    return source;
  }
  return { input, pair, parallelPair, roots, run };
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

test('concurrent job CLI creates converge to one Python-equivalent writer', { timeout: 60_000 }, async t => {
  const { input, pair, parallelPair } = await context(t);
  const create = await input('create', { id: 'job', url: 'https://example.invalid/job', role: 'Engineer' });
  await parallelPair('job-create', ['--input', create]);
  const saved = await pair('job-get', ['--id', 'job'], { unchanged: true });
  assert.equal(saved.output.revision, 1);
});

test('concurrent job CLI updates and trash serialize revision checks like Python', { timeout: 60_000 }, async t => {
  const { input, pair, parallelPair } = await context(t);
  const create = await input('create', { id: 'job', url: 'https://example.invalid/job', role: 'Engineer' });
  const update = await input('update', { role: 'Senior Engineer' });
  await pair('job-create', ['--input', create]);
  await parallelPair('job-update', ['--id', 'job', '--input', update, '--expected-revision', '1']);
  await parallelPair('job-trash', ['--id', 'job', '--expected-revision', '2']);
  const saved = await pair('job-get', ['--id', 'job', '--include-trashed'], { unchanged: true });
  assert.equal(saved.output.revision, 3);
  assert.equal(saved.output.role, 'Senior Engineer');
  assert.notEqual(saved.output.deletedAt, null);
});

test('job CLI read completes a torn-tail coordinator recovery exactly once like Python', { timeout: 60_000 }, async t => {
  const { roots, run } = await context(t);
  const at = '2026-09-15T18:00:00Z';
  const claim = { claimId: 'claim-one', jobId: 'job-one', ownerLabel: 'Owner',
    tokenHash: createHash('sha256').update('token').digest('hex'), acquiredAt: at,
    heartbeatAt: at, expiresAt: '2026-09-15T18:05:00Z' };
  const event = { schemaVersion: 1, eventId: 'event-one', applicationId: 'job-one',
    event: 'claim-recovered', company: null, role: null, ats: null, status: 'in_progress', answerKeys: [], at };
  const journal = { schemaVersion: 1, operation: { kind: 'recover', operationId: 'recover-one',
    jobId: 'job-one', at, historyEvent: event, resultClaim: claim } };
  for (const root of Object.values(roots)) {
    await writeFile(join(root, 'coordinator-journal.json'), JSON.stringify(journal), { mode: 0o600 });
    await writeFile(join(root, 'applications.jsonl'), '{"torn"', { mode: 0o600 });
  }
  const command = ['job-get', ['--id', 'job-one']];
  assert.deepEqual(run('native', ...command), run('python', ...command));
  for (const file of ['jobs.json', 'coordinator.json', 'coordinator-journal.json']) {
    assert.deepEqual(JSON.parse(await readFile(join(roots.native, file))),
      JSON.parse(await readFile(join(roots.python, file))), file);
  }
  assert.equal(await readFile(join(roots.native, 'applications.jsonl'), 'utf8'),
    await readFile(join(roots.python, 'applications.jsonl'), 'utf8'));
  assert.deepEqual(JSON.parse(await readFile(join(roots.native, 'coordinator-journal.json'))).operation, null);
  const before = { python: await snapshot(roots.python), native: await snapshot(roots.native) };
  assert.deepEqual(run('native', ...command), run('python', ...command));
  assert.deepEqual(await snapshot(roots.python), before.python, 'Python second read changed recovery state');
  assert.deepEqual(await snapshot(roots.native), before.native, 'native second read changed recovery state');
});

test('installed Store router preserves Python job CLI behavior and rollback bytes', { timeout: 60_000 }, async t => {
  const fixture = await nativeFixture();
  t.after(() => fixture.cleanup());
  const home = await realpath(fixture.root);
  const plugin = join(home, 'plugin'), pythonRoot = join(home, 'python'), nativeRoot = join(home, 'installed');
  await mkdir(plugin);
  for (const path of ['apps/companion', 'runtime', 'native', 'package.json']) {
    await cp(new URL(`../${path}`, import.meta.url), join(plugin, path), { recursive: true });
  }
  await packageNativeLock(plugin);
  const env = { ...process.env, HOME: home };
  const command = join(plugin, 'apps/companion/command.mjs');
  function invoke(which, name, args = []) {
    const source = which === 'python';
    const result = spawnSync(source ? python : process.execPath, source
      ? ['scripts/job-apply-store.py', '--root', pythonRoot, name, ...args]
      : [command, 'store', '--root', nativeRoot, name, ...args],
    { cwd: source ? new URL('../', import.meta.url) : plugin, encoding: 'utf8',
      env: source ? env : { ...env, PATH: '' }, timeout: 15_000 });
    assert.ifError(result.error);
    return { status: result.status,
      output: result.stdout.trim() ? normalized(JSON.parse(result.stdout)) : null,
      error: result.stderr.trim().replace(/^job-apply-store:\s*/, '') };
  }
  assert.equal(invoke('python', 'init').status, 0);
  await cp(pythonRoot, nativeRoot, { recursive: true });
  const rollbackJobs = await readFile(join(pythonRoot, 'jobs.json'));
  const create = join(home, 'create.json'), update = join(home, 'update.json');
  await writeFile(create, JSON.stringify({ id: 'job', url: 'https://example.invalid/job', role: 'Engineer' }), { mode: 0o600 });
  await writeFile(update, JSON.stringify({ role: 'Senior Engineer' }), { mode: 0o600 });
  for (const [name, args] of [
    ['job-create', ['--input', create]], ['job-get', ['--id', 'job']], ['job-list', []],
    ['job-update', ['--id', 'job', '--input', update, '--expected-revision', '1']],
    ['job-transition', ['--id', 'job', '--status', 'needs_info', '--expected-revision', '2']],
    ['job-trash', ['--id', 'job', '--expected-revision', '3']],
    ['job-restore', ['--id', 'job', '--expected-revision', '4']],
    ['job-trash', ['--id', 'job', '--expected-revision', '5']],
    ['job-delete', ['--id', 'job', '--expected-revision', '6']],
  ]) {
    assert.deepEqual(invoke('native', name, args), invoke('python', name, args), name);
    assert.deepEqual(normalized(JSON.parse(await readFile(join(nativeRoot, 'jobs.json')))),
      normalized(JSON.parse(await readFile(join(pythonRoot, 'jobs.json')))), `${name}: installed durable jobs`);
    assert.deepEqual(await readFile(join(`${nativeRoot}.python-rollback`, 'jobs.json')), rollbackJobs,
      `${name}: original Python rollback changed`);
  }
});
