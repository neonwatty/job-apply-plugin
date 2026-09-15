import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, serialize } from '../runtime/contracts/workspace/values.js';
import { SessionService } from '../runtime/workspace-core/store-sessions.js';

const value = input => parse(JSON.stringify(input));
const plain = input => JSON.parse(serialize(input));

class SessionRepository {
  sessions = new Map();
  jobs = new Map();
  answers = value({ schemaVersion: 1, answers: {}, redirects: {}, metadata: {} });
  async sessionTransaction(operation) {
    return operation({
      load: async id => this.sessions.get(id) ?? null,
      list: async () => [...this.sessions.entries()],
      save: async (id, document) => { this.sessions.set(id, document); },
      delete: async id => this.sessions.delete(id),
      canonicalJob: async id => this.jobs.get(id) ?? null,
      answers: async () => this.answers,
      recomputeReadiness: async (_input, attemptRevision) => value({
        status: 'ready', evidenceKind: 'agent_attested_current_attempt', attemptRevision: Number(attemptRevision),
        observationRevision: 1, controlSetFingerprint: `sha256:${'a'.repeat(64)}`, requiredControlCount: 1,
        assertions: { 'observation-current': 'passed', 'adapter-accessible': 'passed',
          'required-controls-complete': 'passed', 'required-uploads-accepted': 'passed',
          'validation-clear': 'passed', 'final-control-available': 'passed', 'final-action-untouched': 'passed' },
        blockerCodes: [], fallbackCode: null,
      }),
    });
  }
}

function pythonSession(input) {
  const root = mkdtempSync(join(tmpdir(), 'session-python-'));
  try {
    const result = spawnSync('python3.12', ['scripts/job-apply-store.py', 'session-save', '--id', 'oracle', '--input', '-'], {
      cwd: process.cwd(), env: { ...process.env, JOB_APPLY_STORE_DIR: root }, input: JSON.stringify(input), encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function pythonSessionResult(input) {
  const root = mkdtempSync(join(tmpdir(), 'session-python-'));
  try {
    const result = spawnSync('python3.12', ['scripts/job-apply-store.py', 'session-save', '--id', 'oracle', '--input', '-'], {
      cwd: process.cwd(), env: { ...process.env, JOB_APPLY_STORE_DIR: root }, input: JSON.stringify(input), encoding: 'utf8',
    });
    return { status: result.status, value: result.stdout ? JSON.parse(result.stdout) : null, error: result.stderr };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('standalone sessions are value-free, stable, ordered, and terminally deletable', async () => {
  const repository = new SessionRepository();
  const service = new SessionService(repository, () => '2026-09-15T12:00:00Z', () => 'pending_fixed');
  const saved = plain(await service.save('z-job', value({
    status: 'review', ats: 'greenhouse', company: 'Private', role: 'Secret', url: 'https://private.invalid',
    step: 'questions', answerKeys: [], pendingFields: [{ question: 'Private question?', state: 'missing' }],
  })));
  assert.match(saved.pendingFields[0].reference, /^pending_[0-9a-f]{32}$/);
  assert.ok(saved.pendingFields[0].questionFingerprint);
  assert.ok(saved.pendingFields[0].scopeFingerprint);
  assert.deepEqual(saved.blockers, [{ type: 'information', code: 'answer-required',
    reference: saved.pendingFields[0].reference, sensitivity: 'none' }]);
  assert.equal(saved.browserHandoff.state, 'ready_for_owner');
  assert.doesNotMatch(JSON.stringify(saved), /Private|Secret|private\.invalid|Private question/);
  await service.save('a-job', value({ status: 'active' }));
  assert.deepEqual(plain(await service.list()).map(item => item.applicationId), ['a-job', 'z-job']);
  assert.deepEqual(plain(await service.delete('missing')), { deleted: false, applicationId: 'missing' });
  assert.deepEqual(plain(await service.delete('z-job')), { deleted: true, applicationId: 'z-job' });
});

test('canonical active jobs deny generic session mutation while terminal deletion remains allowed', async () => {
  const repository = new SessionRepository();
  const service = new SessionService(repository);
  repository.jobs.set('canonical', { status: 'in_progress', deletedAt: null, ats: 'greenhouse' });
  await assert.rejects(service.save('canonical', value({ status: 'active' })), /coordinator operation/);
  repository.sessions.set('canonical', value({ schemaVersion: 1, applicationId: 'canonical', status: 'completed',
    answerKeys: [], pendingFields: [], attemptRevision: null, readiness: null, blockers: [], approvals: [],
    browserHandoff: { state: 'not_required', reasonCode: 'none', revision: 1 }, createdAt: 'x', updatedAt: 'x' }));
  await assert.rejects(service.delete('canonical'), /coordinator operation/);
  repository.jobs.set('canonical', { status: 'applied', deletedAt: null, ats: 'greenhouse' });
  assert.equal(plain(await service.delete('canonical')).deleted, true);
});

test('basic standalone save matches the CPython 3.12 envelope', async () => {
  const expected = pythonSession({ status: 'active' });
  const repository = new SessionRepository();
  const actual = plain(await new SessionService(repository, () => expected.createdAt).save('oracle', value({ status: 'active' })));
  assert.deepEqual(actual, expected);
});

test('save preserves closed agent blockers, browser handoff, and recomputed readiness', async () => {
  const repository = new SessionRepository();
  const saved = plain(await new SessionService(repository).save('bounded', value({
    status: 'active', attemptRevision: 2, readinessInput: { private: 'adapter-input' },
    blockers: [{ type: 'owner_review', code: 'consent-required' }],
    browserHandoff: { state: 'required', reasonCode: 'captcha-required', revision: 3 },
  })));
  assert.equal(saved.readiness.status, 'ready');
  assert.equal(saved.readiness.attemptRevision, 2);
  assert.deepEqual(saved.readiness.blockerCodes, []);
  assert.equal(saved.readiness.fallbackCode, null);
  assert.deepEqual(saved.blockers, [{ type: 'owner_review', code: 'consent-required' }]);
  assert.deepEqual(saved.browserHandoff, { state: 'required', reasonCode: 'captcha-required', revision: 3 });
  assert.doesNotMatch(JSON.stringify(saved), /adapter-input/);
});

test('pending input accepts scope but rejects Store-owned output fields like CPython 3.12', async () => {
  const scoped = { pendingFields: [{ question: 'Q', scope: { ats: 'greenhouse' } }] };
  const expected = pythonSessionResult(scoped);
  assert.equal(expected.status, 0);
  const native = plain(await new SessionService(new SessionRepository(), () => expected.value.createdAt,
    () => expected.value.pendingFields[0].reference).save('oracle', value(scoped)));
  assert.equal(native.pendingFields[0].scopeFingerprint, expected.value.pendingFields[0].scopeFingerprint);
  for (const field of ['reference', 'scopeFingerprint', 'matchAnswerRevision']) {
    const input = { pendingFields: [{ question: 'Q', [field]: field === 'matchAnswerRevision' ? 1 : 'pending_client' }] };
    assert.notEqual(pythonSessionResult(input).status, 0);
    await assert.rejects(new SessionService(new SessionRepository()).save('oracle', value(input)), /pending field contains unsupported fields/);
  }
});

test('closed session validation rejects corrupt writes and reads like CPython', async () => {
  assert.notEqual(pythonSessionResult({ attemptRevision: 0 }).status, 0);
  await assert.rejects(new SessionService(new SessionRepository()).save('oracle', value({ attemptRevision: 0 })), /attempt revision is invalid/);
  const badHandoff = { state: 'not_required', reasonCode: 'captcha-required', revision: 1 };
  assert.notEqual(pythonSessionResult({ browserHandoff: badHandoff }).status, 0);
  await assert.rejects(new SessionService(new SessionRepository()).save('oracle', value({ browserHandoff: badHandoff })), /browser handoff is invalid/);
  const repository = new SessionRepository();
  repository.sessions.set('corrupt', value({ schemaVersion: 99, applicationId: 'corrupt', status: 'bogus',
    answerKeys: [], pendingFields: [], attemptRevision: 0, readiness: null, blockers: [], approvals: [],
    browserHandoff: badHandoff, createdAt: 'x', updatedAt: 'x' }));
  await assert.rejects(new SessionService(repository).load('corrupt'), /schemaVersion|status/);
});

test('equivalent repeat saves retain pending references and current approvals', async () => {
  const repository = new SessionRepository();
  repository.answers = value({ schemaVersion: 1, answers: { answer_1: { key: 'answer_1', question: 'Q',
    state: 'confirmed', value: 'private', sensitivity: 'none', reviewStatus: 'accepted', revision: 1, deletedAt: null } },
    redirects: {}, metadata: {} });
  let sequence = 0;
  const service = new SessionService(repository, () => '2026-09-15T12:00:00Z', () => `pending_${String(++sequence).padStart(32, '0')}`);
  const input = value({ status: 'active', attemptRevision: 2,
    pendingFields: [{ question: 'Q', answerKey: 'answer_1' }] });
  const first = plain(await service.save('stable', input));
  const approval = { reference: first.pendingFields[0].reference, answerKey: 'answer_1', currentUse: true,
    remember: false, policyMode: 'strict', useAuthority: 'per_use', eligible: true,
    confidenceBand: 'exact', reasonCodes: ['match_exact_question'], answerRevision: 1 };
  const stored = plain(repository.sessions.get('stable'));
  stored.approvals = [approval]; repository.sessions.set('stable', value(stored));
  const second = plain(await service.save('stable', input));
  assert.equal(second.pendingFields[0].reference, first.pendingFields[0].reference);
  assert.deepEqual(second.approvals, [approval]);
});

test('blockers are canonically deduplicated before persistence', async () => {
  const blocker = { type: 'owner_review', code: 'consent-required' };
  const expected = pythonSessionResult({ blockers: [blocker, blocker] });
  assert.equal(expected.status, 0); assert.equal(expected.value.blockers.length, 1);
  const actual = plain(await new SessionService(new SessionRepository(), () => expected.value.createdAt)
    .save('oracle', value({ blockers: [blocker, blocker] })));
  assert.deepEqual(actual.blockers, expected.value.blockers);
});

test('legacy pending fields project stable opaque references without rewriting stored bytes', async () => {
  const repository = new SessionRepository();
  const legacy = value({ schemaVersion: 1, applicationId: 'legacy', status: 'active', ats: 'lever',
    company: 'Private', role: 'Secret', url: 'https://private.invalid', answerKeys: [],
    pendingFields: [{ question: 'Private question', state: 'missing' }], createdAt: 'x', updatedAt: 'x' });
  repository.sessions.set('legacy', legacy);
  const service = new SessionService(repository);
  const first = plain(await service.load('legacy'));
  const second = plain(await service.load('legacy'));
  assert.deepEqual(first, second);
  assert.match(first.pendingFields[0].reference, /^pending_[0-9a-f]{32}$/);
  assert.doesNotMatch(JSON.stringify(first), /Private|Secret|private\.invalid/);
  assert.equal(repository.sessions.get('legacy'), legacy);
});
