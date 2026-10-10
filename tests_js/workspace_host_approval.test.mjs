import assert from 'node:assert/strict';
import test from 'node:test';
import { createUserEventAuthority } from '../runtime/harness/user-events.js';
import { ClaimWorkflow } from '../runtime/app/claim-workflow.js';
import { NativeClaimWorkflowTasks } from '../runtime/store/native-claim-workflow-tasks.js';
import { TrashService } from '../runtime/workspace-core/trash.js';
import { ApplicationRunsService } from '../runtime/workspace-core/application-runs.js';
import { fromJSON } from '../runtime/contracts/workspace/values.js';
import { attemptProfile } from '../runtime/workflows/applications/attempt.js';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, event, snapshot, read, write } from './workspace_durable_claims_support.mjs';

const access = () => ({ enabled: [attemptProfile], authorized: [attemptProfile] });
const binding = { eventFingerprint: 'a'.repeat(64), inputRevision: 'b'.repeat(64) };
const rejection = /user_event_required/;
async function unchanged(state, operation, pattern = rejection) {
  const before = await snapshot(state.root);
  await assert.rejects(async () => operation(), pattern);
  assert.deepEqual(await snapshot(state.root), before);
}
function trusted(state, store = new NativeClaimWorkflowTasks(state.repository, () => state.clock.now)) {
  const time = { now: 0 }, ports = createUserEventAuthority(() => time.now);
  const workflow = new ClaimWorkflow(store, state.claims, access, () => state.clock.now, ports.verifier);
  const approve = async request => ports.approvals.approve((await workflow.reviewUserEvent(request)).binding, 1000);
  return { workflow, time, ...ports, approve };
}

test('host approval ports bind exact hashes, copy input, expire, revoke and close', () => {
  let now = 10;
  const { approvals, verifier } = createUserEventAuthority(() => now);
  assert.equal('approve' in verifier, false);
  const input = { ...binding }, id = approvals.approve(input, 100);
  input.eventFingerprint = 'c'.repeat(64);
  assert.throws(() => verifier.require(input), rejection);
  verifier.require(binding); verifier.require(binding); // Exact retry, not a second operation.
  assert.throws(() => verifier.require({ ...binding, inputRevision: 'c'.repeat(64) }), rejection);
  approvals.revoke(id); assert.throws(() => verifier.require(binding), rejection);
  approvals.approve(binding, 100); now = 110;
  assert.throws(() => verifier.require(binding), rejection);
  approvals.approve(binding, 1); now = 109;
  assert.throws(() => verifier.require(binding), rejection);
  now = 111; assert.throws(() => approvals.approve(binding, 100), rejection, 'clock rollback closes authority');
  const next = createUserEventAuthority(); next.approvals.approve(binding, 1000); next.verifier.close();
  assert.throws(() => next.verifier.require(binding), rejection);
});

test('approval lifetime, schema and capacity are bounded without evicting active grants', () => {
  let now = 0;
  const { approvals, verifier } = createUserEventAuthority(() => now);
  for (const lifetime of [0, -1, 0.5, 300001, Infinity, NaN]) assert.throws(() => approvals.approve(binding, lifetime));
  for (const value of [{ ...binding, extra: true }, { ...binding, inputRevision: 'bad' },
    { ...binding, eventFingerprint: 1 }, { get eventFingerprint() { throw Error('getter'); }, inputRevision: binding.inputRevision }]) {
    assert.throws(() => approvals.approve(value, 100));
  }
  for (let n = 0; n < 64; n++) approvals.approve({ ...binding, eventFingerprint: n.toString(16).padStart(64, '0') }, 100);
  assert.throws(() => approvals.approve(binding, 100), rejection);
  verifier.require({ ...binding, eventFingerprint: '0'.repeat(64) });
  now = 100; approvals.approve(binding, 100); verifier.require(binding);
});

test('trusted workflow ignores model attestation, preserves exact replay, and cannot borrow another host grant', async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const state = await setup(fixture, 'trusted-events'); await state.claims.select('job', 1n, true);
  const host = trusted(state), other = trusted(state); t.after(() => host.workflow.close()); t.after(() => other.workflow.close());
  const request = event('acquire'), before = await snapshot(state.root);
  const review = await host.workflow.reviewUserEvent(request);
  assert.deepEqual(await snapshot(state.root), before);
  const context = await host.workflow.inspect();
  assert.equal(context.userEventSource, 'trusted_host');
  assert.ok(context.guidance.actions[0].requiresExplicitUserEvent);
  assert.ok(!context.guidance.actions[0].args.includes('--host-user-event'));
  await unchanged(state, () => host.workflow.execute(request, request));
  host.approvals.approve(review.binding, 1000);
  await unchanged(state, () => other.workflow.execute(request, request));
  await unchanged(state, () => host.workflow.execute({ ...request, operationId: 'another' }, request));
  const acquired = await host.workflow.execute(request);
  const bytes = await snapshot(state.root);
  assert.equal((await host.workflow.execute(request, request)).replayed, true);
  assert.deepEqual(await snapshot(state.root), bytes);
  host.time.now = 1000;
  await unchanged(state, () => host.workflow.execute(request, request));
  await host.approve(request);
  assert.equal((await host.workflow.execute(request)).replayed, true);
  const progress = await host.workflow.execute(event('progress', acquired.receipt.task));
  const cancel = event('cancel', progress.receipt.task);
  await unchanged(state, () => host.workflow.execute(cancel, cancel));
  const grant = await host.approve(cancel);
  await unchanged(state, () => host.workflow.execute({ ...cancel, session: { status: 'active', step: 'changed' } }, cancel));
  host.approvals.revoke(grant);
  await unchanged(state, () => host.workflow.execute(cancel, cancel));
  await host.approve(cancel);
  assert.equal((await host.workflow.execute(cancel)).receipt.outcome, 'cancelled');
  assert.equal((await read(state.root, 'coordinator.json')).claim, null);
  assert.doesNotMatch(JSON.stringify((await read(state.root, 'jobs.json')).metadata.agentWorkflows), /expires|eventFingerprint|PRIVATE|claim_[A-Za-z0-9_-]{43}/);
});

test('approval for acquisition cannot silently rebind changed preparation inputs', async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const state = await setup(fixture, 'trusted-inputs'); await state.claims.select('job', 1n, true);
  const host = trusted(state); t.after(() => host.workflow.close());
  const request = event('acquire'); await host.approve(request);
  const jobs = await read(state.root, 'jobs.json'), run = jobs.metadata.applicationRuns.runs['run-fixture'];
  run.revision++; run.queueVersions.push({ ...run.queueVersions.at(-1), revision: run.revision });
  await write(state.root, 'jobs.json', jobs);
  await unchanged(state, () => host.workflow.execute(request, request));
  await host.approve(request);
  const acquired = await host.workflow.execute(request);
  await host.workflow.execute(event('handoff', acquired.receipt.task));
});

test('revocation during staged execution is checked before canonical commit', async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const state = await setup(fixture, 'trusted-revoke'); await state.claims.select('job', 1n, true);
  const native = new NativeClaimWorkflowTasks(state.repository, () => state.clock.now);
  let revoke = () => {};
  const store = { transaction: callback => native.transaction(tx => callback({ ...tx, domain: { ...tx.domain,
    execute: async (...args) => { const result = await tx.domain.execute(...args); revoke(); return result; },
  } })) };
  const host = trusted(state, store); t.after(() => host.workflow.close());
  const request = event('acquire'), grant = await host.approve(request);
  revoke = () => host.approvals.revoke(grant);
  await unchanged(state, () => host.workflow.execute(request, request));
  assert.equal((await host.workflow.inspect()).broker.ownsClaim, false);
  revoke = () => {}; await host.approve(request);
  const acquired = await host.workflow.execute(request);
  await host.workflow.execute(event('handoff', acquired.receipt.task));
});

test('replacement authority needs a new approval and recovery preserves original input scope', async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const state = await setup(fixture, 'trusted-recover'); await state.claims.select('job', 1n, true);
  const old = trusted(state), request = event('acquire'); await old.approve(request);
  const task = (await old.workflow.execute(request)).receipt.task;
  await old.workflow.execute(event('progress', task));
  const savedTask = (await old.workflow.inspect()).task;
  await old.workflow.close();
  const next = trusted(state); t.after(() => next.workflow.close());
  state.clock.now = '2026-09-10T12:05:00Z';
  const jobs = await read(state.root, 'jobs.json'), run = jobs.metadata.applicationRuns.runs['run-fixture'];
  run.revision++; run.queueVersions.push({ ...run.queueVersions.at(-1), revision: run.revision });
  await write(state.root, 'jobs.json', jobs);
  const recover = event('recover', savedTask);
  await unchanged(state, () => next.workflow.execute(recover, recover));
  const review = await next.workflow.reviewUserEvent(recover);
  assert.equal(review.binding.inputRevision, task.subject.inputRevision);
  next.approvals.approve(review.binding, 1000);
  const recovered = (await next.workflow.execute(recover)).receipt.task;
  assert.equal(recovered.subject.inputRevision, task.subject.inputRevision);
  next.approvals.close();
  await next.workflow.execute(event('handoff', recovered)); // Safe handoff needs no user-event grant.
  assert.equal((await read(state.root, 'coordinator.json')).claim, null);
});


test('historical review and renewed approval replay a trashed job without resurrecting it', async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const state = await setup(fixture, 'trusted-history'); await state.claims.select('job', 1n, true);
  const old = trusted(state), request = event('acquire'); await old.approve(request);
  const acquired = (await old.workflow.execute(request)).receipt.task;
  const cancel = event('cancel', acquired); await old.approve(cancel);
  await old.workflow.execute(cancel); await old.workflow.close();
  await new ApplicationRunsService(state.repository, () => state.clock.now)
    .update('run-fixture', 1n, fromJSON({ jobIds: ['other'] }));
  await new TrashService(state.repository, () => state.clock.now).trashJob('job', 4n);
  const next = trusted(state); t.after(() => next.workflow.close());
  const before = await snapshot(state.root);
  const review = await next.workflow.reviewUserEvent(cancel);
  assert.equal(review.binding.inputRevision, acquired.subject.inputRevision);
  next.approvals.approve(review.binding, 1000);
  assert.equal((await next.workflow.execute(cancel)).replayed, true);
  assert.equal((await next.workflow.inspect()).broker.ownsClaim, false);
  await assert.rejects(next.workflow.reviewUserEvent({ ...cancel, session: { status: 'active', step: 'changed' } }), /operation_conflict/);
  await assert.rejects(next.workflow.reviewUserEvent({ ...cancel, operationId: 'new-cancel' }), /task_conflict/);
  assert.deepEqual(await snapshot(state.root), before);
});
