import assert from 'node:assert/strict';
import test from 'node:test';
import { checkpoint, comparisonArms, gradeState, continuationPrerequisite } from '../evals/attempt/scenarios.mjs';
function states() {
  const job = { id: 'job', status: 'ready', revision: 2, notes: 'keep' };
  const initial = { job, otherJobs: {}, metadata: {}, activeRun: { runId: 'run' }, claim: null, sessions: [], history: [],
    hashes: { 'jobs.json': 'ready', 'resume-facts.json': 'confirmed', 'resumes.json': 'resume' }, preflightReady: true };
  const task = { taskId: 'task', workflow: { id: 'application.attempt', version: 1 }, status: 'active', subject: { jobId: 'job', jobRevision: '3' } };
  const first = { ...structuredClone(initial), job: { ...job, status: 'in_progress', revision: 3 }, claim: { jobId: 'job', claimId: 'claim' },
    sessions: [{ applicationId: 'job', ...checkpoint, attemptRevision: 3 }], history: [{ event: 'job-started' }],
    hashes: { ...initial.hashes, 'jobs.json': 'active', 'sessions/job.json': 'checkpoint' },
    metadata: { agentWorkflows: { activeTaskId: 'task', tasks: { task }, receipts: {} } } };
  const last = { ...structuredClone(first), job: { ...job, status: 'needs_info', revision: 4 }, claim: null,
    hashes: { ...first.hashes, 'jobs.json': 'cancelled' },
    metadata: { agentWorkflows: { activeTaskId: null, tasks: { task: { ...task, status: 'cancelled' } }, receipts: {} } } };
  return { initial, first, last };
}
test('attempt grades reject lost checkpoints, replacement jobs, rewritten inputs and fabricated terminal state', () => {
  const { initial, first, last } = states();
  const grade = value => gradeState('fresh-cancel', [first, value], initial, first, 'candidate').statePassed;
  assert.equal(grade(last), true);
  for (const mutate of [s => s.sessions[0].handoffChecklist = [], s => s.sessions[0].step = 'restarted',
    s => s.claim = first.claim, s => s.job.status = 'awaiting_review', s => s.job.notes = 'overwritten',
    s => s.otherJobs.extra = { id: 'extra' }, s => s.activeRun.runId = 'replacement',
    s => s.metadata.extra = 'unauthorized', s => s.hashes['resume-facts.json'] = 'reconfirmed',
    s => s.hashes['new-input.json'] = 'unexpected', s => s.history.push({ event: 'job-started' }),
    s => s.metadata.agentWorkflows.tasks.extra = { taskId: 'extra' }, s => s.metadata.agentWorkflows.activeTaskId = 'task']) {
    const changed = structuredClone(last); mutate(changed); assert.equal(grade(changed), false);
  }
});
test('broker-loss requires byte-identical preservation and stale-input handling requires blocked readiness', () => {
  const { initial, first, last } = states();
  assert.equal(gradeState('broker-loss', [first, first], initial, first, 'candidate').statePassed, true);
  const changed = structuredClone(first); changed.claim.claimId = 'new';
  assert.equal(gradeState('broker-loss', [first, changed], initial, first, 'candidate').statePassed, false);
  const before = { ...first, preflightReady: false, hashes: { ...first.hashes, 'resume-facts.json': 'draft' } };
  const blocked = { ...last, preflightReady: false, hashes: { ...last.hashes, 'resume-facts.json': 'draft' } };
  assert.equal(gradeState('stale-inputs', [first, blocked], initial, before, 'candidate').statePassed, true);
  assert.equal(gradeState('stale-inputs', [first, { ...blocked, preflightReady: true }], initial, before, 'candidate').statePassed, false);
});
test('expired recovery is candidate-only and must preserve the same task and canonical job revision', () => {
  const { initial, first, last } = states();
  last.history.push({ event: 'claim-recovered' });
  last.metadata.agentWorkflows.receipts.recovery = { receipt: { outcome: 'claim_recovered', task: first.metadata.agentWorkflows.tasks.task } };
  assert.equal(gradeState('expired-recovery', [first, last], initial, first, 'candidate').statePassed, true);
  last.metadata.agentWorkflows.receipts.recovery.receipt.task = { ...first.metadata.agentWorkflows.tasks.task, taskId: 'wrong' };
  assert.equal(gradeState('expired-recovery', [first, last], initial, first, 'candidate').statePassed, false);
  assert.deepEqual(comparisonArms('expired-recovery', 2), ['candidate']);
  assert.deepEqual(comparisonArms('fresh-cancel', 1), ['baseline', 'candidate']);
  assert.deepEqual(comparisonArms('fresh-cancel', 2), ['candidate', 'baseline']);
  assert.throws(() => gradeState('expired-recovery', [first, last], initial, first, 'baseline'));
});

test('attempt host validation rejects broader filesystem, different profiles and changed model context', async () => {
  const { validateAttemptContext, attemptArguments } = await import('../evals/attempt/host.mjs');
  const context = { count: 1, cwd: '/fixture', model: 'model', effort: 'medium', approvalPolicy: 'never',
    sandbox: { type: 'workspace-write', network_access: true }, profile: { id: 'attempt_eval', extends: ':workspace' },
    filesystem: { kind: 'restricted', entries: [{ path: { type: 'special', value: { kind: 'root' } }, access: 'read' },
      ...['slash_tmp', 'tmpdir'].map(kind => ({ path: { type: 'special', value: { kind } }, access: 'write' })),
      { path: { type: 'path', path: '/fixture' }, access: 'write' }] } };
  const expected = { workspace: '/fixture', model: 'model', turn: 1 };
  validateAttemptContext(context, expected);
  for (const mutate of [s => s.filesystem.entries.push({ path: { type: 'path', path: '/owner' }, access: 'write' }),
    s => s.filesystem.entries[0].access = 'write', s => s.filesystem.kind = 'unrestricted',
    s => s.profile.id = ':danger-full-access', s => s.profile.extends = ':read-only', s => s.approvalPolicy = 'on-request',
    s => s.sandbox.network_access = false, s => s.count = 2, s => s.model = 'other', s => s.cwd = '/owner']) {
    const changed = structuredClone(context); mutate(changed); assert.throws(() => validateAttemptContext(changed, expected));
  }
  const args = attemptArguments({ ...expected, socket: '/fixture/one.sock' });
  assert.ok(args.includes('permissions.attempt_eval={extends=":workspace",network={enabled=true,domains={},unix_sockets={"/fixture/one.sock"="allow"}}}'));
  assert.ok(!args.some(value => value.includes('sandbox_mode=')));
});

test('continuation interventions require a real exact acquisition and checkpoint', () => {
  const { initial, first } = states();
  assert.equal(continuationPrerequisite(first, initial, 'candidate'), true);
  assert.equal(continuationPrerequisite(initial, initial, 'candidate'), false);
  for (const mutate of [s => s.claim = null, s => s.claim.jobId = 'other', s => s.job.revision++,
    s => s.sessions = [], s => s.sessions[0].step = 'wrong', s => s.sessions[0].attemptRevision++,
    s => s.metadata.agentWorkflows.tasks.task.status = 'cancelled']) {
    const changed = structuredClone(first); mutate(changed);
    assert.equal(continuationPrerequisite(changed, initial, 'candidate'), false);
  }
  const ordinary = structuredClone(first); ordinary.metadata = {};
  assert.equal(continuationPrerequisite(ordinary, initial, 'baseline'), true);
});

test('baseline acquisition window reserves model timeout plus shutdown margin', async () => {
  const { requireAcquisitionWindow, baselineIdleMilliseconds, modelTurnTimeout } = await import('../evals/attempt/timing.mjs');
  const startedAt = 1_000_000, latest = startedAt + baselineIdleMilliseconds - modelTurnTimeout - 10_000;
  requireAcquisitionWindow(startedAt, startedAt);
  requireAcquisitionWindow(startedAt, latest - 1);
  for (const now of [latest, latest + 1, startedAt - 1, NaN]) assert.throws(() => requireAcquisitionWindow(startedAt, now));
});
