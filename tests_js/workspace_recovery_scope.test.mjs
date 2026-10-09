import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, read, write, snapshot, readyPacket, host, event, acquire } from './workspace_durable_claims_support.mjs';
import { installedHost } from './workspace_host_support.mjs';
import { ApplicationRunsService } from '../runtime/workspace-core/application-runs.js';
import { fromJSON } from '../runtime/contracts/workspace/values.js';
const posix = { skip: !['darwin', 'linux'].includes(process.platform) };
const checkpoint = { status: 'active', step: 'questions', handoffChecklist: ['resume_upload'],
  browserHandoff: { state: 'required', reasonCode: 'login-required', revision: 3 } };
async function changeRun(state, revision = 1n, jobIds = ['job']) {
  await new ApplicationRunsService(state.repository, () => state.clock.now)
    .update(state.run.runId, revision, fromJSON({ jobIds }));
}
async function unchanged(state, operation, pattern) {
  const before = await snapshot(state.root);
  await assert.rejects(operation, pattern);
  assert.deepEqual(await snapshot(state.root), before);
}
const review = task => event('handoff', task, { operationId: 'review', status: 'awaiting_review',
  session: { status: 'review', handoffChecklist: [], readinessInput: readyPacket(3) } });

for (const exit of ['handoff', 'cancel']) {
  test(`changed-input recovery preserves original scope through replay and repeated recovery before ${exit}`, posix, async t => {
    const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
    const state = await setup(fixture, `recovery-scope-${exit}`), old = host(state).workflow;
    t.after(() => old.close());
    const acquired = await acquire(state, old);
    const original = (await old.execute(event('progress', acquired, { session: checkpoint }))).receipt.task;
    await changeRun(state);
    const changed = await old.inspect();
    assert.equal(changed.guidance.selection.preflightReady, true, 'Run queue drift must isolate the task-scope guard');
    assert.equal(changed.guidance.selection.inputsCurrent, false);
    await unchanged(state, () => old.execute(review(original)), /stale_revision/);
    const savedSession = await read(state.root, 'sessions/job.json');
    const inputs = await snapshot(state.root), oldHash = (await read(state.root, 'coordinator.json')).claim.tokenHash;
    await old.close(); state.clock.now = '2026-09-10T12:05:00Z';
    const next = host(state).workflow; t.after(() => next.close());
    const recovery = event('recover', original);
    await unchanged(state, () => next.execute(recovery), /user_event_required/);
    const recovered = (await next.execute(recovery, recovery)).receipt.task;
    assert.equal(recovered.subject.inputRevision, original.subject.inputRevision);
    assert.equal(recovered.taskId, original.taskId);
    assert.equal(recovered.revision, '3'); assert.equal(recovered.subject.jobRevision, '3');
    assert.notEqual((await read(state.root, 'coordinator.json')).claim.tokenHash, oldHash);
    assert.deepEqual(await read(state.root, 'sessions/job.json'), savedSession);
    const after = await snapshot(state.root);
    for (const name of Object.keys(inputs).filter(name => !['jobs.json', 'coordinator.json', 'coordinator-journal.json', 'applications.jsonl'].includes(name))) {
      assert.equal(after[name], inputs[name], name);
    }
    const context = await next.inspect();
    assert.equal(context.broker.ownsClaim, true);
    assert.equal(context.guidance.selection.inputsCurrent, false);
    assert.ok(context.guidance.blockers.includes('attempt_inputs_changed'));
    assert.deepEqual(context.guidance.actions.map(action => action.kind), ['handoff', 'cancel']);
    await unchanged(state, () => next.execute(event('progress', original, { operationId: 'old-task-revision' })), /stale_revision/);
    await unchanged(state, () => next.execute(event('progress', recovered, { operationId: 'blocked-progress' })), /stale_revision/);
    await unchanged(state, () => next.execute(review(recovered)), /stale_revision/);
    const replayBefore = await snapshot(state.root);
    assert.equal((await next.execute(recovery, recovery)).replayed, true);
    assert.deepEqual(await snapshot(state.root), replayBefore);
    await next.close();
    const replacement = host(state).workflow; t.after(() => replacement.close());
    assert.equal((await replacement.execute(recovery, recovery)).replayed, true);
    assert.equal((await replacement.inspect()).broker.ownsClaim, false);
    assert.deepEqual(await snapshot(state.root), replayBefore);
    await changeRun(state, 2n, ['job', 'other']);
    state.clock.now = '2026-09-10T12:10:00Z';
    const second = event('recover', recovered, { operationId: 'recover-again' });
    const again = (await replacement.execute(second, second)).receipt.task;
    assert.equal(again.subject.inputRevision, original.subject.inputRevision);
    const current = await replacement.inspect();
    assert.equal(current.guidance.selection.inputsCurrent, false);
    const descriptor = current.guidance.actions.find(action => action.kind === exit);
    const request = { ...descriptor.input, operationId: 'safe-exit' };
    const done = (await replacement.execute(request, request)).receipt.task;
    assert.equal(done.subject.inputRevision, original.subject.inputRevision);
    assert.equal((await read(state.root, 'coordinator.json')).claim, null);
    const finalSession = await read(state.root, 'sessions/job.json');
    assert.deepEqual({ ...finalSession, updatedAt: savedSession.updatedAt }, savedSession);
    const jobs = await read(state.root, 'jobs.json');
    assert.equal(jobs.jobs.job.status, 'needs_info');
    assert.equal(Object.keys(jobs.metadata.agentWorkflows.tasks).length, 1);
    // A genuinely new acquisition binds the new scope instead of inheriting the old task's guard.
    await state.claims.select('job', 4n, true);
    const fresh = event('acquire', null, { operationId: 'fresh-acquire', jobRevision: '5' });
    const newTask = (await replacement.execute(fresh, fresh)).receipt.task;
    assert.notEqual(newTask.taskId, original.taskId);
    assert.notEqual(newTask.subject.inputRevision, original.subject.inputRevision);
    assert.equal((await replacement.inspect()).guidance.selection.inputsCurrent, true);
  });
}

test('unchanged-input recovery still permits progress and fresh review handoff', posix, async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const state = await setup(fixture, 'recovery-current'), old = host(state).workflow;
  t.after(() => old.close());
  const original = await acquire(state, old); await old.close(); state.clock.now = '2026-09-10T12:05:00Z';
  const next = host(state).workflow; t.after(() => next.close());
  const request = event('recover', original), recovered = (await next.execute(request, request)).receipt.task;
  assert.equal(recovered.subject.inputRevision, original.subject.inputRevision);
  assert.equal((await next.inspect()).guidance.selection.inputsCurrent, true);
  const progressed = (await next.execute(event('progress', recovered, { session: checkpoint }))).receipt.task;
  const done = await next.execute(review(progressed));
  assert.equal(done.receipt.outcome, 'awaiting_review');
  assert.equal(done.receipt.task.subject.inputRevision, original.subject.inputRevision);
  assert.equal((await read(state.root, 'coordinator.json')).claim, null);
});

test('installed replacement broker recovers capability without accepting changed inputs', { ...posix, timeout: 60000 }, async t => {
  const { workflow, state, serve } = await installedHost(t);
  await state.claims.select('job', 1n, true);
  const old = await serve(), request = event('acquire');
  const acquired = (await workflow('attempt', 'event', request, ['--host-user-event'])).result.receipt.task;
  const original = (await workflow('attempt', 'event', event('progress', acquired, { session: checkpoint }))).result.receipt.task;
  old.child.kill('SIGKILL'); assert.equal((await old.done).signal, 'SIGKILL');
  await changeRun(state);
  const coordinator = await read(state.root, 'coordinator.json');
  coordinator.claim.expiresAt = '2020-01-01T00:00:00Z'; await write(state.root, 'coordinator.json', coordinator);
  const next = await serve();
  const recovery = event('recover', original);
  const recovered = (await workflow('attempt', 'event', recovery, ['--host-user-event'])).result.receipt.task;
  assert.equal(recovered.subject.inputRevision, original.subject.inputRevision);
  const context = (await workflow('attempt', 'context')).result;
  assert.equal(context.broker.ownsClaim, true); assert.equal(context.guidance.selection.inputsCurrent, false);
  assert.deepEqual(context.guidance.actions.map(action => action.kind), ['handoff', 'cancel']);
  const before = await snapshot(state.root);
  assert.equal((await workflow('attempt', 'event', event('progress', recovered, { operationId: 'forged-progress' }))).ok, false);
  assert.equal((await workflow('attempt', 'event', review(recovered))).ok, false);
  assert.deepEqual(await snapshot(state.root), before);
  const cancel = { ...context.guidance.actions.find(action => action.kind === 'cancel').input, operationId: 'cancel' };
  assert.equal((await workflow('attempt', 'event', cancel, ['--host-user-event'])).result.receipt.outcome, 'cancelled');
  assert.equal((await read(state.root, 'coordinator.json')).claim, null);
  assert.deepEqual((await read(state.root, 'sessions/job.json')).browserHandoff, checkpoint.browserHandoff);
  next.child.kill('SIGTERM'); assert.equal((await next.done).code, 0);
});
