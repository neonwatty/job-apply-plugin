import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, writeFile, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { initializeJobsFixture } from '../runtime/store/native-jobs.js';

async function installed(t) {
  const fixture = await nativeFixture();
  t.after(fixture.cleanup);
  const plugin = join(fixture.root, 'plugin');
  await cp(new URL('../runtime/', import.meta.url), join(plugin, 'runtime'), { recursive: true });
  await mkdir(join(plugin, 'native', 'posix'), { recursive: true });
  await cp(new URL('../native/posix/flock.c', import.meta.url), join(plugin, 'native/posix/flock.c'));
  const platform = `${process.platform}-${process.arch}-napi8`;
  const lock = join(plugin, 'native', 'packaged-lock', platform);
  await mkdir(lock, { recursive: true });
  await cp(fixture.receipt.artifact, join(lock, 'flock.node'));
  const { schemaVersion, arch, platform: receiptPlatform, nodeApiVersion, sourceSha256, artifactSha256 } = fixture.receipt;
  await writeFile(join(lock, 'receipt.json'), JSON.stringify({ schemaVersion, arch, platform: receiptPlatform, nodeApiVersion, sourceSha256, artifactSha256 }));
  await writeFile(join(plugin, 'package.json'), '{"type":"module"}');
  const root = join(fixture.root, '.job-apply');
  await initializeJobsFixture(root);
  return { plugin, root };
}

function run(plugin, command, args = [], environment = {}) {
  return spawnSync(process.execPath, [join(plugin, 'runtime/cli', command), ...args], {
    cwd: plugin,
    encoding: 'utf8',
    env: { HOME: plugin.slice(0, plugin.lastIndexOf('/plugin')), PATH: '', ...environment },
  });
}

test('assembled prepared native Jobs CLI resolves the default root and packaged lock without Python', async t => {
  const { plugin } = await installed(t);
  const result = run(plugin, 'native-jobs.js', ['profile-get']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {});
});

test('assembled prepared native task CLI resolves the default root and packaged lock without Python', async t => {
  const { plugin } = await installed(t);
  const result = run(plugin, 'native-task.js', ['snapshot']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).ok, true);
});

for (const command of ['native-jobs.js', 'native-task.js']) {
  test(`prepared native ${command} expands a home-relative configured Store`, async t => {
    const { plugin } = await installed(t);
    const result = run(plugin, command, [command === 'native-jobs.js' ? 'profile-get' : 'snapshot'],
      { JOB_APPLY_STORE_DIR: '~/.job-apply' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, '');
  });
  test(`prepared native ${command} keeps an absolute configured Store independent of HOME`, async t => {
    const { plugin, root } = await installed(t);
    const result = run(plugin, command, [command === 'native-jobs.js' ? 'profile-get' : 'snapshot'],
      { JOB_APPLY_STORE_DIR: await realpath(root), HOME: join(plugin, 'missing-home') });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}

test('fresh public router completes resume setup and review handoff with Companion closed', { timeout: 60_000 }, async t => {
  const { plugin } = await installed(t);
  const work = await realpath(join(plugin, '..'));
  const store = join(work, 'headless-store');
  const app = join(plugin, 'apps/companion');
  await mkdir(app, { recursive: true });
  for (const name of ['command.mjs', 'supervise.mjs', 'writer-route.mjs', 'ensure-standalone.mjs', 'standalone-assets.mjs']) {
    await cp(new URL(`../apps/companion/${name}`, import.meta.url), join(app, name));
  }
  await mkdir(join(plugin, 'qa/fixtures'), { recursive: true });
  await cp(new URL('../qa/fixtures/greenhouse-form-readiness-v1/', import.meta.url),
    join(plugin, 'qa/fixtures/greenhouse-form-readiness-v1'), { recursive: true });
  const { readyPacket } = await import('./workspace_native_claims_support.mjs');
  const { killAttempt } = await import('./native_attempt_support.mjs');

  function call(surface, command, args = [], expectedStatus = 0) {
    const result = spawnSync(process.execPath, [join(app, 'command.mjs'), surface, '--root', store, command, ...args],
      { cwd: work, env: { HOME: work, PATH: '' }, encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, expectedStatus, result.error?.message ?? result.stderr);
    return result.stdout ? JSON.parse(result.stdout) : null;
  }
  async function input(name, value) {
    const path = join(work, `${name}.json`);
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    return ['--input', path];
  }
  try {
    call('store', 'init', ['--legacy-profile', join(work, 'absent-legacy.json')]);
    assert.deepEqual(call('store', 'resume-extraction-request-list', ['--status', 'requested']), []);
    const path = join(work, 'resume.txt');
    await writeFile(path, 'Synthetic candidate with TypeScript experience', { mode: 0o600 });
    const resume = call('store', 'resume-import', await input('resume', { id: 'resume', label: 'Synthetic', path }));
    call('store', 'profile-patch', ['--expected-revision', '1', '--source', 'user', ...await input('profile', { name: 'Global only' })]);
    const overview = call('task', 'snapshot').snapshot.overview;
    assert.equal(overview.setup.hasProfileFacts, false);
    assert.equal(overview.targetWorkspace, 'resumes');
    const request = call('store', 'resume-extraction-request-create',
      ['--resume-id', resume.id, '--expected-resume-revision', String(resume.revision), '--scope', 'resume']);
    const draft = call('store', 'resume-extraction-request-complete-scoped', ['--id', request.requestId,
      '--expected-request-revision', String(request.revision), ...await input('facts', { skills: ['TypeScript'] })]);
    assert.equal(call('store', 'resume-facts-get', ['--resume-id', resume.id]).revision, draft.revision);
    const { job } = call('task', 'intake', await input('job', {
      url: 'https://boards.greenhouse.io/example/jobs/1234567', role: 'Synthetic engineer', company: 'Synthetic', ats: 'greenhouse',
    }));
    const run = ['--resume-id', resume.id, '--expected-resume-revision', String(resume.revision),
      '--owner-confirmed', ...await input('queue', { jobIds: [job.id] })];
    call('store', 'application-run-start', [...run, '--expected-fact-revision', String(draft.revision)], 2);
    const confirmed = call('store', 'resume-facts-confirm', ['--resume-id', resume.id,
      '--expected-fact-revision', String(draft.revision), '--expected-content-revision', draft.contentRevision]);
    call('store', 'application-run-start', [...run, '--expected-fact-revision', String(confirmed.revision)]);
    const selected = call('task', 'select', ['--id', job.id, '--expected-revision', String(job.revision), '--owner-confirmed']);
    const acquired = call('attempt', 'start', ['--id', job.id, '--owner', 'synthetic', '--expected-revision', String(selected.job.revision)]);
    assert.equal(acquired.event, 'acquired');
    call('attempt', 'progress', await input('progress', { status: 'active' }));
    const sessionPath = join(store, 'sessions', `${job.id}.json`);
    const session = await readFile(sessionPath);
    const revision = acquired.attempt.job.revision;
    const reset = ['--id', job.id, '--expected-revision', String(revision), '--owner-confirmed-not-submitted'];
    call('store', 'claim-reset-expired', reset, 2);
    await killAttempt(store);
    const coordinatorPath = join(store, 'coordinator.json');
    const coordinator = JSON.parse(await readFile(coordinatorPath, 'utf8'));
    coordinator.claim.expiresAt = '2000-01-01T00:00:00Z';
    await writeFile(coordinatorPath, JSON.stringify(coordinator));
    call('store', 'claim-reset-expired', reset.slice(0, -1), 2);
    call('store', 'claim-reset-expired', ['--id', job.id, '--expected-revision', String(revision - 1),
      '--owner-confirmed-not-submitted'], 2);
    const released = call('store', 'claim-reset-expired', reset);
    assert.equal(released.claim, null);
    assert.equal(released.job.status, 'needs_info');
    assert.deepEqual(await readFile(sessionPath), session);
    const ready = call('task', 'select', ['--id', job.id, '--expected-revision', String(released.job.revision), '--owner-confirmed']);
    const restarted = call('attempt', 'start', ['--id', job.id, '--owner', 'synthetic', '--expected-revision', String(ready.job.revision)]);
    assert.equal(restarted.event, 'acquired');
    const handoff = call('attempt', 'handoff', ['--status', 'awaiting_review', ...await input('review', {
      status: 'review', readinessInput: readyPacket(restarted.attempt.job.revision),
    })]);
    assert.equal(handoff.event, 'handed_off');
    assert.equal(call('store', 'claim-status').claim, null);
    assert.equal(call('store', 'job-get', ['--id', job.id]).status, 'awaiting_review');
    assert.ok(!(await readdir(app)).includes('.next'));
    assert.ok(!(await readdir(plugin)).includes('node_modules'));
  } finally { await killAttempt(store); }
});

test('installed Store preserves root, literal options, UTF-8 and migration command contracts', { timeout: 60_000 }, async t => {
  const { plugin, root } = await installed(t);
  const work = await realpath(join(plugin, '..'));
  const call = (args, status = 0) => {
    const result = run(plugin, 'native-jobs.js', args);
    assert.equal(result.status, status, result.stderr);
    return result.stdout ? JSON.parse(result.stdout) : null;
  };
  assert.deepEqual(call(['--root', '../.job-apply', 'profile-get']), {});
  assert.deepEqual(call(['--root', '~/.job-apply', 'profile-get']), {});

  const input = join(work, 'input.json');
  await writeFile(input, '{"status":"active"}', { mode: 0o600 });
  call(['session-save', '--id', 'true', '--input', input]);
  assert.equal(call(['session-load', '--id', 'true']).applicationId, 'true');
  await writeFile(input, Buffer.concat([Buffer.from('{"name":"'), Buffer.from([255]), Buffer.from('"}')]));
  call(['profile-patch', '--input', input, '--source', 'user', '--expected-revision', '1'], 2);
  assert.deepEqual(call(['profile-get']), {});

  const reports = join(work, '.claude-job-searches');
  await mkdir(reports);
  const { report } = await import('./workspace_native_legacy_jobs_support.mjs');
  await writeFile(join(reports, 'search-synthetic.md'), report, { mode: 0o600 });
  const item = call(['legacy-jobs-preview']).items[0].itemId;
  const preview = call(['legacy-jobs-preview', '--select', item]);
  assert.equal(call(['legacy-jobs-commit', '--select', item, '--confirm', preview.token]).committed, true);

  const path = join(work, 'legacy.txt');
  await writeFile(path, 'Synthetic legacy resume', { mode: 0o600 });
  const registryPath = join(root, 'resumes.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const at = '2026-01-01T00:00:00Z';
  registry.resumes.legacy = { id: 'legacy', label: 'Synthetic legacy', path, tags: [], default: true,
    revision: 1, createdAt: at, updatedAt: at, deletedAt: null };
  await writeFile(registryPath, JSON.stringify(registry));
  const adopted = call(['resume-adopt', '--id', 'legacy', '--expected-revision', '1']);
  assert.equal(adopted.id, 'legacy');
  assert.equal(adopted.revision, 2);
  assert.equal(adopted.storageKind, 'managed');
  assert.equal(await readFile(join(root, 'resume-files/legacy.txt'), 'utf8'), 'Synthetic legacy resume');
});
