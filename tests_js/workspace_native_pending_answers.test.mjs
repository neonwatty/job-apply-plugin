import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, readdir, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { initializeJobsFixture, NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { AnswersService } from '../runtime/workspace-core/answers.js';
import { JobsService } from '../runtime/workspace-core/jobs.js';
import { ResumeService } from '../runtime/workspace-core/resumes.js';
import { jobsHttp } from '../runtime/workspace-core/jobs-http.js';
import { PendingAnswersService } from '../runtime/workspace-core/pending-answers.js';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';

const at = '2026-09-09T12:00:00Z';
const reference = `pending_${'a'.repeat(32)}`;
const secondReference = `pending_${'b'.repeat(32)}`;
const plain = value => JSON.parse(serialize(value));
const read = async (root, name) => JSON.parse(await readFile(join(root, name), 'utf8'));
const write = (root, name, value) => writeFile(join(root, name), JSON.stringify(value), { mode: 0o600 });
async function snapshot(root) {
  const paths = (await readdir(root)).filter(path => path.endsWith('.json') || path.endsWith('.jsonl'));
  paths.push(...(await readdir(join(root, 'sessions'))).map(path => `sessions/${path}`));
  return Object.fromEntries(await Promise.all(paths.map(async path => [path, await readFile(join(root, path), 'utf8')])));
}
async function setup(fixture, name, { extraPending = false, blocker = false, ready = false } = {}) {
  const root = join(await realpath(fixture.root), name);
  await initializeJobsFixture(root);
  const provider = loadPosixFlockProvider(fixture.receipt.artifact);
  const repository = new NativeJobsRepository(root, provider);
  await new JobsService(repository, () => at).create(fromJSON({ id: 'job', url: 'https://example.invalid/job', role: 'Engineer', company: 'Fixture' }));
  const jobs = await read(root, 'jobs.json');
  jobs.jobs.job.status = 'needs_info';
  await write(root, 'jobs.json', jobs);
  const answers = new AnswersService(repository, () => at);
  await answers.put(fromJSON({ key: 'answer', question: 'Preferred city?', state: 'confirmed', value: 'PRIVATE-ANSWER' }));
  await answers.put(fromJSON({ key: 'sensitive', question: 'Private name?', state: 'confirmed', value: 'PRIVATE-SENSITIVE', sensitivity: 'personal' }), true);
  const session = { schemaVersion: 1, applicationId: 'job', status: 'active', updatedAt: at,
    pendingFields: [{ reference, question: 'Preferred city?', answerKey: 'answer', state: 'missing' }],
    blockers: [{ reference, type: 'information', code: 'answer-required' }], answerKeys: [] };
  if (extraPending) session.pendingFields.push({ reference: secondReference, answerKey: 'answer', question: 'Other?', state: 'missing' });
  if (blocker) session.blockers.push({ type: 'validation', code: 'validation-error-present' });
  await write(root, 'sessions/job.json', session);
  let resume;
  if (ready) {
    const profile = await read(root, 'profile.json');
    profile.profile.name = 'PRIVATE-PROFILE';
    await write(root, 'profile.json', profile);
    resume = plain(await new ResumeService(repository, () => at).import(fromJSON({ id: 'resume', label: 'Fixture', default: true }), 'fixture.txt', Buffer.from('PRIVATE-RESUME')));
  }
  const service = new PendingAnswersService(repository, () => at);
  return { root, provider, repository, service, answers, resume };
}
async function current(service) {
  const group = plain(await service.list()).jobs[0];
  return { group, field: group.pendingInformation[0] };
}
async function resolve(service, overrides = {}) {
  const { group, field } = await current(service);
  const args = { jobId: group.id, reference: field.reference, jobRevision: BigInt(group.jobRevision),
    sessionRevision: BigInt(group.sessionRevision), answerRevision: BigInt(field.answerRevision), confirmed: true, ...overrides };
  return service.resolve(args.jobId, args.reference, args.jobRevision, args.sessionRevision, args.answerRevision, args.confirmed);
}

test('pending listing is readonly and value-free; resolution persists across reopen without touching answers/history', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture();
  try {
    const { root, provider, service } = await setup(fixture, 'durable', { extraPending: true, ready: true });
    const before = await snapshot(root);
    const readonly = new PendingAnswersService(new NativeJobsRepository(root, provider, async () => { throw Error('listing attempted a write'); }));
    const listing = plain(await readonly.list());
    assert.equal(listing.mutated, false);
    assert.equal(listing.jobs[0].pendingInformation.length, 2);
    assert.equal(listing.jobs[0].pendingInformation[0].resolutionEligible, true);
    assert.doesNotMatch(JSON.stringify(listing), /PRIVATE-|rememberedWithConsentAt/);
    assert.deepEqual(await snapshot(root), before);
    const first = plain(await resolve(service));
    assert.equal(first.ready, false);
    assert.equal(first.job.revision, 2);
    assert.equal(first.session.pendingInformation[0].reference, secondReference);
    assert.doesNotMatch(JSON.stringify(first), /PRIVATE-/);
    const reopened = new PendingAnswersService(new NativeJobsRepository(root, provider), () => at);
    assert.equal((await current(reopened)).group.jobRevision, 2);
    const final = plain(await resolve(reopened));
    assert.equal(final.ready, true);
    assert.equal(final.job.status, 'ready');
    assert.equal(final.job.revision, 3);
    assert.deepEqual(plain(await reopened.list()), { jobs: [], mutated: false });
    const persisted = await read(root, 'sessions/job.json');
    assert.deepEqual(persisted.answerKeys, ['answer']);
    assert.deepEqual(persisted.pendingFields, []);
    assert.deepEqual(persisted.blockers, []);
    assert.equal((await read(root, 'jobs.json')).jobs.job.status, 'ready');
    assert.equal((await read(root, 'coordinator-journal.json')).operation, null);
    for (const name of ['answers.json', 'applications.jsonl', 'profile.json', 'resumes.json', 'coordinator.json']) {
      assert.equal(await readFile(join(root, name), 'utf8'), before[name], name);
    }
  } finally { await fixture.cleanup(); }
});

test('stale revisions, references, owner denial and sensitive answers preserve all canonical bytes', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture();
  try {
    const { root, service } = await setup(fixture, 'denials', { ready: true });
    const before = await snapshot(root);
    for (const [override, error] of [
      [{ confirmed: false }, /explicit owner confirmation/],
      [{ jobRevision: 99n }, /job revision conflict/],
      [{ sessionRevision: 99n }, /session revision conflict/],
      [{ answerRevision: 99n }, /answer revision conflict/],
      [{ reference: secondReference }, /reference is stale/],
      [{ reference: 'invalid' }, /reference is invalid/],
    ]) {
      await assert.rejects(resolve(service, override), error);
      assert.deepEqual(await snapshot(root), before);
    }
    const session = await read(root, 'sessions/job.json');
    session.pendingFields[0].answerKey = 'sensitive';
    await write(root, 'sessions/job.json', session);
    const sensitiveBefore = await snapshot(root);
    assert.equal((await current(service)).field.resolutionEligible, false);
    await assert.rejects(resolve(service), /sensitive pending answers require reconfirmation/);
    assert.deepEqual(await snapshot(root), sensitiveBefore);
  } finally { await fixture.cleanup(); }
});

test('only the final unobstructed field needs preflight; missing profile and changed or missing managed resumes deny writes', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture();
  try {
    const blocked = await setup(fixture, 'blocker', { blocker: true });
    const result = plain(await resolve(blocked.service));
    assert.equal(result.ready, false);
    assert.equal(result.job.status, 'needs_info');
    assert.equal((await read(blocked.root, 'sessions/job.json')).blockers.length, 1);
    const empty = await setup(fixture, 'empty');
    const before = await snapshot(empty.root);
    await assert.rejects(resolve(empty.service), /job preflight failed/);
    assert.deepEqual(await snapshot(empty.root), before);
    const managed = await setup(fixture, 'managed', { ready: true });
    const file = join(managed.root, 'resume-files', managed.resume.managedFile);
    await writeFile(file, 'ALTERED-RESUME');
    const changedBefore = await snapshot(managed.root);
    await assert.rejects(resolve(managed.service), /job preflight failed/);
    assert.deepEqual(await snapshot(managed.root), changedBefore);
    await unlink(file);
    await assert.rejects(resolve(managed.service), /job preflight failed/);
    assert.deepEqual(await snapshot(managed.root), changedBefore);
  } finally { await fixture.cleanup(); }
});

test('HTTP and Python-free CLI preserve pending resolution contracts and reject malformed or stale writes', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture();
  try {
    for (const transport of ['http', 'cli']) {
      const { root, repository, service } = await setup(fixture, transport, { ready: true });
      const jobs = new JobsService(repository);
      const cli = args => spawnSync(process.execPath, ['runtime/cli/native-jobs.js', '--root', root,
        '--native-lock', fixture.receipt.artifact, ...args], { encoding: 'utf8', env: { PATH: '' } });
      const before = await snapshot(root);
      const listing = await jobsHttp(jobs, repository, 'GET', '/api/pending-answers', '');
      assert.equal(listing.status, 200, listing.body);
      const listed = cli(['pending-answer-list']);
      assert.equal(listed.status, 0, listed.stderr);
      assert.deepEqual(JSON.parse(listed.stdout), JSON.parse(listing.body));
      assert.doesNotMatch(listed.stdout, /PRIVATE-/);
      assert.deepEqual(await snapshot(root), before);
      const { group, field } = await current(service);
      const body = { reference: field.reference, expectedJobRevision: group.jobRevision,
        expectedSessionRevision: group.sessionRevision, expectedAnswerRevision: field.answerRevision, ownerConfirmed: true };
      const path = '/api/jobs/job/resolve-pending-answer';
      const missing = { ...body };
      delete missing.expectedAnswerRevision;
      for (const invalid of [missing, { ...body, extra: 'PRIVATE-BAD' }, { ...body, ownerConfirmed: 'true' },
        { ...body, ownerConfirmed: false }, { ...body, expectedAnswerRevision: true }, { ...body, expectedJobRevision: 1.5 }]) {
        const result = await jobsHttp(jobs, repository, 'POST', path, JSON.stringify(invalid));
        assert.equal(result.status, 400, result.body);
        assert.doesNotMatch(result.body, /PRIVATE-/);
        assert.deepEqual(await snapshot(root), before);
      }
      const args = ['resolve-pending-answer', '--id', 'job', '--reference', field.reference,
        '--expected-job-revision', String(group.jobRevision), '--expected-session-revision', String(group.sessionRevision),
        '--expected-answer-revision', String(field.answerRevision)];
      for (const invalid of [args, [...args, '--owner-confirmed', '--unexpected', 'PRIVATE-BAD'],
        [...args.slice(0, -2), '--owner-confirmed'], [...args.slice(0, -1), 'true', '--owner-confirmed']]) {
        const result = cli(invalid);
        assert.notEqual(result.status, 0);
        assert.deepEqual(await snapshot(root), before);
      }
      if (transport === 'http') {
        const result = await jobsHttp(jobs, repository, 'POST', path, JSON.stringify(body));
        assert.equal(result.status, 200, result.body);
        assert.equal(JSON.parse(result.body).ready, true);
      } else {
        const result = cli([...args, '--owner-confirmed']);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).ready, true);
        assert.doesNotMatch(result.stdout, /PRIVATE-/);
      }
      assert.equal((await read(root, 'jobs.json')).jobs.job.revision, group.jobRevision + 1);
      const after = await snapshot(root);
      const replay = await jobsHttp(jobs, repository, 'POST', path, JSON.stringify(body));
      assert.equal(replay.status, 409, replay.body);
      assert.equal(JSON.parse(replay.body).error.code, 'revision_conflict');
      assert.deepEqual(await snapshot(root), after);
    }
  } finally { await fixture.cleanup(); }
});
