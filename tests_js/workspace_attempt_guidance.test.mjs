import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, read, write, snapshot, host, event, acquire } from './workspace_durable_claims_support.mjs';
import { get, int, object, parse, string } from '../runtime/contracts/workspace/values.js';
import { ClaimWorkflow } from '../runtime/app/claim-workflow.js';
import { attemptGuidance } from '../runtime/app/attempt-guidance.js';
import { emptyWorkflowLedger, receiptLimit, taskLimit, validateWorkflowLedger } from '../runtime/contracts/workspace/workflow-tasks.js';
import { attemptProfile } from '../runtime/workflows/applications/attempt.js';
const posix = { skip: !['darwin', 'linux'].includes(process.platform) };
const action = (context, kind, operationId, extra = {}) => {
  const descriptor = context.guidance.actions.find(item => item.kind === kind);
  assert.ok(descriptor, kind);
  assert.deepEqual(descriptor.requiredFields, ['operationId']);
  return { ...descriptor.input, operationId, ...extra };
};

test('attempt entry templates drive acquisition, exact progress and fresh cancellation without writes on inspection', posix, async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const state = await setup(fixture, 'guidance-entry'), { workflow } = host(state);
  t.after(() => workflow.close());
  await state.claims.select('job', 1n, true);
  const before = await snapshot(state.root), context = await workflow.inspect();
  assert.deepEqual(await snapshot(state.root), before);
  assert.deepEqual(context.broker, { connected: true, ownsClaim: false });
  assert.equal(context.brokerAvailable, false);
  assert.equal(context.guidance.nextOperation, 'acquire');
  assert.deepEqual(context.guidance.actions[0].args, ['workflow', 'attempt', 'event', '--host-user-event']);
  assert.equal(context.guidance.selection.jobRevision, '2');
  assert.doesNotMatch(JSON.stringify(context), /PRIVATE|tokenHash|claim_[A-Za-z0-9_-]{43}/);
  const request = action(context, 'acquire', 'entry');
  await assert.rejects(workflow.execute(request), /user_event_required/);
  await workflow.execute(request, request);
  const active = await workflow.inspect();
  assert.equal(active.broker.ownsClaim, true);
  const progress = action(active, 'progress', 'checkpoint');
  assert.equal(progress.session.attemptRevision, '3');
  progress.session.step = 'questions'; progress.session.handoffChecklist = ['resume_upload'];
  await workflow.execute(progress);
  const saved = await snapshot(state.root), fresh = await workflow.inspect('job');
  assert.deepEqual(await snapshot(state.root), saved);
  assert.equal(fresh.guidance.checkpoint.step, 'questions');
  const cancel = action(fresh, 'cancel', 'cancel');
  await workflow.execute(cancel, cancel);
  assert.equal((await read(state.root, 'jobs.json')).jobs.job.status, 'needs_info');
  assert.equal((await read(state.root, 'sessions/job.json')).step, 'questions');
  assert.deepEqual((await read(state.root, 'sessions/job.json')).handoffChecklist, ['resume_upload']);
});

test('multiple Ready jobs need an explicit target and active task inspection cannot borrow another job', posix, async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const state = await setup(fixture, 'guidance-scope'), { workflow } = host(state); t.after(() => workflow.close());
  await state.claims.select('job', 1n, true); await state.claims.select('other', 1n, true);
  assert.equal((await workflow.inspect()).guidance.nextOperation, 'choose_job');
  assert.deepEqual((await workflow.inspect()).guidance.actions, []);
  const exact = await workflow.inspect('other'), request = action(exact, 'acquire', 'other');
  assert.equal(request.jobId, 'other'); await workflow.execute(request, request);
  const wrong = await workflow.inspect('job');
  assert.deepEqual(wrong.guidance.actions, []); assert.ok(wrong.guidance.blockers.includes('different_active_job'));
  assert.equal((await workflow.inspect()).guidance.selection.jobId, 'other');
  await assert.rejects(async () => workflow.inspect(''), /invalid_arguments/);
});

test('changed inputs and revoked access remove progress but preserve guarded safe exits', posix, async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const state = await setup(fixture, 'guidance-drift'), { workflow, access } = host(state); t.after(() => workflow.close());
  const task = await acquire(state, workflow);
  const jobs = await read(state.root, 'jobs.json'), run = jobs.metadata.applicationRuns.runs['run-fixture'];
  run.revision++; run.queueVersions.push({ ...run.queueVersions.at(-1), revision: run.revision });
  await write(state.root, 'jobs.json', jobs);
  const before = await snapshot(state.root), context = await workflow.inspect();
  assert.deepEqual(await snapshot(state.root), before);
  assert.equal(context.guidance.selection.preflightReady, true);
  assert.equal(context.guidance.selection.inputsCurrent, false);
  assert.ok(context.guidance.blockers.includes('attempt_inputs_changed'));
  assert.deepEqual(context.guidance.actions.map(item => item.kind), ['handoff', 'cancel']);
  await assert.rejects(workflow.execute(event('progress', task)), /stale_revision/);
  access.authorized = [];
  const revoked = await workflow.inspect(); assert.ok(revoked.guidance.blockers.includes('profile_unavailable'));
  assert.deepEqual(revoked.guidance.actions.map(item => item.kind), ['handoff', 'cancel']);
  const cancel = action(revoked, 'cancel', 'revoked-cancel'); await workflow.execute(cancel, cancel);
});

test('replacement broker reports a live claim without capability, then offers only explicit expired recovery', posix, async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const state = await setup(fixture, 'guidance-loss'), old = host(state).workflow;
  await acquire(state, old); await old.close();
  const next = host(state).workflow; t.after(() => next.close());
  const before = await snapshot(state.root), lost = await next.inspect();
  assert.deepEqual(lost.broker, { connected: true, ownsClaim: false });
  assert.equal(lost.guidance.claim.state, 'live'); assert.deepEqual(lost.guidance.actions, []);
  assert.deepEqual(await snapshot(state.root), before);
  state.clock.now = '2026-09-10T12:05:00Z';
  const expired = await next.inspect();
  assert.equal(expired.guidance.nextOperation, 'recover_only_if_requested');
  assert.deepEqual(expired.guidance.actions.map(item => item.kind), ['recover']);
  const recover = action(expired, 'recover', 'recover');
  await assert.rejects(next.execute(recover), /user_event_required/);
  await next.execute(recover, recover);
  assert.equal((await next.inspect()).broker.ownsClaim, true);
});

test('preflight failures, closed broker and history capacity never advertise acquisition', posix, async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const state = await setup(fixture, 'guidance-unavailable'), { workflow, access } = host(state);
  await state.claims.select('job', 1n, true);
  const profile = await read(state.root, 'profile.json'); profile.profile = {}; await write(state.root, 'profile.json', profile);
  const blocked = await workflow.inspect(); assert.ok(blocked.guidance.blockers.includes('profile_empty'));
  assert.deepEqual(blocked.guidance.actions, []);
  access.authorized = []; assert.ok((await workflow.inspect()).guidance.blockers.includes('profile_unavailable'));
  await workflow.close(); assert.equal((await workflow.inspect()).broker.connected, false);
  assert.deepEqual((await workflow.inspect()).guidance.actions, []);
  await state.repository.claimTransaction(async snapshot => {
    const ledger = emptyWorkflowLedger(); ledger.receipts = Object.fromEntries(Array.from({ length: receiptLimit }, (_, n) => [String(n), {}]));
    const result = await attemptGuidance(snapshot, ledger, null, false, true,
      () => ({ enabled: [attemptProfile], authorized: [attemptProfile] }), () => state.clock.now, 'job');
    assert.deepEqual(result.actions, []); assert.ok(result.blockers.includes('history_capacity_limited'));
  });
});

test('unexpected observation failures are propagated, not described as ordinary unavailable inputs', posix, async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const state = await setup(fixture, 'guidance-errors'); await state.claims.select('job', 1n, true);
  await state.repository.claimTransaction(async snapshot => {
    snapshot.files = { ...snapshot.files, observation: async () => { throw Error('unexpected observer failure'); } };
    const workflow = new ClaimWorkflow({ transaction: callback => callback({ ledger: emptyWorkflowLedger(), domain: { snapshot } }) },
      { heartbeat: async () => {} }, () => ({ enabled: [attemptProfile], authorized: [attemptProfile] }));
    await assert.rejects(workflow.inspect(), /unexpected observer failure/);
  });
});

test('pending questions require an observed packet and unchanged templates cannot clear them', posix, async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const state = await setup(fixture, 'guidance-pending'), { workflow } = host(state); t.after(() => workflow.close());
  const task = await acquire(state, workflow);
  const session = { status: 'active', step: 'questions', handoffChecklist: ['resume_upload'],
    pendingFields: [{ question: 'PRIVATE QUESTION', state: 'missing' }],
    blockers: [{ type: 'browser_handoff', code: 'login-required' }] };
  await workflow.execute(event('progress', task, { session }));
  const before = await snapshot(state.root), context = await workflow.inspect();
  assert.equal(context.guidance.sessionRequiresObservation, true);
  assert.doesNotMatch(JSON.stringify(context), /PRIVATE QUESTION/);
  for (const kind of ['progress', 'handoff', 'cancel']) {
    const template = context.guidance.actions.find(item => item.kind === kind);
    assert.deepEqual(template.requiredFields, ['operationId', 'session']);
    assert.equal(Object.hasOwn(template.input, 'session'), false);
    const request = { ...template.input, operationId: `missing-${kind}` };
    await assert.rejects(async () => workflow.execute(request, request), /invalid_event/);
    assert.deepEqual(await snapshot(state.root), before);
  }
  const template = context.guidance.actions.find(item => item.kind === 'cancel');
  const request = { ...template.input, operationId: 'observed-cancel', session };
  await workflow.execute(request, request);
  const saved = await read(state.root, 'sessions/job.json');
  assert.equal(saved.pendingFields.length, 1);
  assert.equal(saved.pendingFields[0].reference, JSON.parse(before['sessions/job.json']).pendingFields[0].reference);
  assert.ok(saved.blockers.some(item => item.code === 'login-required'));
});

test('simple templates preserve closed agent blockers without copying derived blocker inputs', posix, async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const state = await setup(fixture, 'guidance-blockers'), { workflow } = host(state); t.after(() => workflow.close());
  const task = await acquire(state, workflow);
  await workflow.execute(event('progress', task, { session: { status: 'active', step: 'login',
    blockers: [{ type: 'browser_handoff', code: 'login-required' }] } }));
  const request = action(await workflow.inspect(), 'cancel', 'keep-blocker');
  assert.deepEqual(request.session.blockers, [{ type: 'browser_handoff', code: 'login-required' }]);
  await workflow.execute(request, request);
  assert.equal((await read(state.root, 'sessions/job.json')).browserHandoff.state, 'required');
});

test('task capacity blocks fresh acquisition even when receipt budget remains', posix, async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const state = await setup(fixture, 'guidance-task-limit'); await state.claims.select('job', 1n, true);
  const ledger = emptyWorkflowLedger();
  for (let i = 0; i < taskLimit; i++) {
    const task = { taskId: `prior-${i}`, workflow: { id: 'application.attempt', version: 1 }, revision: '2',
      status: 'cancelled', pending: null, subject: { jobId: 'job', jobRevision: '4', inputRevision: '0'.repeat(64) } };
    ledger.tasks[task.taskId] = task;
    for (const [suffix, outcome] of [['acquire', 'claim_acquired'], ['cancel', 'cancelled']]) {
      const operationId = `${suffix}-${i}`;
      ledger.receipts[operationId] = { fingerprint: '1'.repeat(64), receipt: { operationId, task, outcome } };
    }
  }
  validateWorkflowLedger(ledger);
  const jobs = await read(state.root, 'jobs.json'); jobs.metadata.agentWorkflows = ledger;
  await write(state.root, 'jobs.json', jobs);
  const { workflow } = host(state); t.after(() => workflow.close());
  const before = await snapshot(state.root), context = await workflow.inspect();
  assert.equal(context.guidance.nextOperation, 'inspect_only');
  assert.deepEqual(context.guidance.actions, []);
  assert.ok(context.guidance.blockers.includes('history_capacity_limited'));
  const request = event('acquire'); await assert.rejects(workflow.execute(request, request), /history_full/);
  assert.deepEqual(await snapshot(state.root), before);
});

for (const kind of ['progress', 'handoff', 'cancel']) {
  test(`templates preserve an explicit browser handoff without a matching blocker through ${kind}`, posix, async t => {
    const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
    const state = await setup(fixture, `guidance-explicit-${kind}`), { workflow } = host(state);
    t.after(() => workflow.close());
    const task = await acquire(state, workflow);
    const browserHandoff = { state: 'required', reasonCode: 'captcha-required', revision: '9007199254740993' };
    await workflow.execute(event('progress', task, { session: { status: 'active', browserHandoff } }));
    const before = await snapshot(state.root), context = await workflow.inspect();
    assert.deepEqual(await snapshot(state.root), before);
    assert.deepEqual(context.guidance.checkpoint.browserHandoff, browserHandoff);
    const request = action(context, kind, `preserve-${kind}`);
    assert.deepEqual(request.session.browserHandoff, browserHandoff);
    assert.deepEqual(request.session.blockers, []);
    await workflow.execute(request, request);
    const saved = object(parse((await snapshot(state.root))['sessions/job.json']), 'session');
    const handoff = object(get(saved, 'browserHandoff'), 'handoff');
    assert.equal(string(get(handoff, 'state')), browserHandoff.state);
    assert.equal(string(get(handoff, 'reasonCode')), browserHandoff.reasonCode);
    assert.equal(int(get(handoff, 'revision')).toString(), browserHandoff.revision);
  });
}
