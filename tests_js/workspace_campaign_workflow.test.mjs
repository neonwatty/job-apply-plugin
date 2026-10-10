import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, snapshot, read, write, event, readyPacket } from './workspace_durable_claims_support.mjs';
import { NativeCampaignWorkflowTasks } from '../runtime/store/native-campaign-workflow-tasks.js';
import { SequentialCampaignWorkflow } from '../runtime/app/sequential-campaign-workflow.js';
import { ApplicationAuthorityService } from '../runtime/workspace-core/application-authority.js';
import { ApplicationRunsService } from '../runtime/workspace-core/application-runs.js';
import { ProfileService } from '../runtime/workspace-core/profile.js';
import { attemptProfile } from '../runtime/workflows/applications/attempt.js';
import { fromJSON } from '../runtime/contracts/workspace/values.js';

const posix = {skip: !['darwin', 'linux'].includes(process.platform)};
const input = {mode: 'campaign_to_review', runId: 'run-fixture', jobIds: ['other', 'job'],
  sensitiveAnswerRefs: [], durationMinutes: 120};
const next = (context, operationId) => {
  const action = context.guidance.actions.find(item => item.kind === 'acquire');
  assert.ok(action, JSON.stringify(context));
  return {...action.input, operationId};
};
function host(state) {
  const now = () => state.clock.now;
  return new SequentialCampaignWorkflow(new NativeCampaignWorkflowTasks(state.repository, now), state.claims,
    new ApplicationAuthorityService(state.repository, now), () => ({enabled: [attemptProfile], authorized: [attemptProfile]}), now);
}
async function fixtureState(t, name) {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const state = await setup(fixture, name);
  await state.claims.select('job', 1n, true); await state.claims.select('other', 1n, true);
  state.authority = new ApplicationAuthorityService(state.repository, () => state.clock.now);
  await state.authority.set(fromJSON(input), 0n);
  const workflow = host(state); t.after(() => workflow.close());
  return {...state, workflow, fixture};
}

test('campaign chooses ordered jobs, commits exact replay and resumes between jobs after broker restart', posix, async t => {
  const state = await fixtureState(t, 'campaign-order'), {workflow} = state;
  const before = await snapshot(state.root), context = await workflow.inspect();
  assert.deepEqual(await snapshot(state.root), before);
  assert.deepEqual(context.campaign.queue.map(job => job.jobId), ['job', 'other']);
  assert.equal(context.campaign.nextJob.jobId, 'job');
  assert.equal(context.guidance.actions[0].args[1], 'campaign');
  const wrong = event('acquire', null, {jobId: 'other'});
  await assert.rejects(workflow.execute(wrong, wrong), /action_unavailable/);
  assert.deepEqual(await snapshot(state.root), before);
  const request = next(context, 'first');
  await assert.rejects(workflow.execute(request), /user_event_required/);
  const acquired = await workflow.execute(request, request), task = acquired.receipt.task;
  assert.equal((await workflow.inspect()).campaign.nextJob, null);
  const handoff = event('handoff', task, {status: 'awaiting_review', session: {status: 'review', readinessInput: readyPacket(3)}});
  await workflow.execute(handoff);
  const committed = await snapshot(state.root);
  assert.equal((await workflow.execute(request, request)).replayed, true);
  assert.deepEqual(await snapshot(state.root), committed);
  await workflow.close();
  const resumed = host(state); t.after(() => resumed.close());
  const second = next(await resumed.inspect(), 'second');
  assert.equal(second.jobId, 'other');
  await resumed.execute(second, second);
  const stored = await read(state.root, 'jobs.json');
  assert.equal(stored.jobs.job.status, 'awaiting_review');
  assert.equal(stored.jobs.other.status, 'in_progress');
  assert.equal(Object.values(stored.metadata.agentWorkflows.tasks).filter(task => task.status === 'active').length, 1);
});

test('pause resume stop require exact control events and safe exits survive revocation', posix, async t => {
  const state = await fixtureState(t, 'campaign-control'), {workflow} = state;
  const first = next(await workflow.inspect(), 'first');
  const task = (await workflow.execute(first, first)).receipt.task;
  const before = await snapshot(state.root);
  assert.throws(() => workflow.control('pause', '1'), /user_event_required/);
  assert.throws(() => workflow.control('pause', '1', {action: 'stop', expectedRevision: '1'}), /user_event_required/);
  assert.deepEqual(await snapshot(state.root), before);
  await workflow.control('pause', '1', {action: 'pause', expectedRevision: '1'});
  assert.equal((await workflow.inspect()).campaign.status, 'paused');
  const paused = await snapshot(state.root);
  await assert.rejects(workflow.execute(event('progress', task)), /action_unavailable/);
  assert.deepEqual(await snapshot(state.root), paused);
  await assert.rejects(workflow.control('resume', '1', {action: 'resume', expectedRevision: '1'}), /revision conflict/);
  await workflow.control('resume', '2', {action: 'resume', expectedRevision: '2'});
  await workflow.control('stop', '3', {action: 'stop', expectedRevision: '3'});
  assert.equal((await workflow.inspect()).campaign.status, 'unavailable');
  await workflow.execute(event('handoff', task));
  const stopped = await snapshot(state.root), second = event('acquire', null, {operationId: 'second', jobId: 'other'});
  await assert.rejects(workflow.execute(second, second), /action_unavailable/);
  assert.deepEqual(await snapshot(state.root), stopped);
  assert.equal((await read(state.root, 'coordinator.json')).claim, null);
});

test('live or expired lost capability blocks another job and explicit recovery stays on the same task', posix, async t => {
  const state = await fixtureState(t, 'campaign-loss'), {workflow} = state;
  const first = next(await workflow.inspect(), 'first'), task = (await workflow.execute(first, first)).receipt.task;
  await workflow.close();
  const replacement = host(state); t.after(() => replacement.close());
  assert.deepEqual((await replacement.inspect()).guidance.actions, []);
  assert.equal((await replacement.inspect()).campaign.nextJob, null);
  state.clock.now = '2026-09-10T12:05:00Z';
  const recover = event('recover', task);
  await assert.rejects(replacement.execute(recover), /user_event_required/);
  const resumed = await replacement.execute(recover, recover);
  assert.equal(resumed.receipt.task.taskId, task.taskId);
  await replacement.execute(event('handoff', resumed.receipt.task));
  assert.equal((await replacement.inspect()).campaign.nextJob.jobId, 'other');
});

for (const change of ['run', 'profile', 'resume', 'expired', 'revoke']) {
  test(`campaign rejects ${change} authority drift before acquisition without mutation`, posix, async t => {
    const state = await fixtureState(t, `campaign-${change}`), {workflow} = state;
    const request = next(await workflow.inspect(), 'first');
    if (change === 'run') await new ApplicationRunsService(state.repository).update('run-fixture', 1n, fromJSON({jobIds: ['other', 'job']}));
    if (change === 'profile') await new ProfileService(state.repository).patch(fromJSON({name: 'Changed'}), 1n, 'user');
    if (change === 'resume') {
      const resumes = await read(state.root, 'resumes.json'); resumes.resumes.resume.revision++;
      await write(state.root, 'resumes.json', resumes);
    }
    if (change === 'expired') state.clock.now = '2026-09-10T14:00:00Z';
    if (change === 'revoke') await state.authority.revoke(1n);
    const before = await snapshot(state.root);
    await assert.rejects(workflow.execute(request, request), /action_unavailable|stale_revision/);
    assert.deepEqual(await snapshot(state.root), before);
    assert.deepEqual((await workflow.inspect()).guidance.actions, []);
  });
}

test('revoked campaign can recover only its expired existing claim for safe exit', posix, async t => {
  const state = await fixtureState(t, 'campaign-revoked-recovery'), {workflow} = state;
  const first = next(await workflow.inspect(), 'first'), task = (await workflow.execute(first, first)).receipt.task;
  await workflow.close(); await state.authority.revoke(1n);
  state.clock.now = '2026-09-10T12:05:00Z';
  const replacement = host(state); t.after(() => replacement.close());
  assert.deepEqual((await replacement.inspect()).guidance.actions.map(action => action.kind), ['recover']);
  const request = event('recover', task), recovered = (await replacement.execute(request, request)).receipt.task;
  const before = await snapshot(state.root);
  await assert.rejects(replacement.execute(event('progress', recovered)), /action_unavailable/);
  await assert.rejects(replacement.execute(event('handoff', recovered, {status: 'awaiting_review',
    session: {status: 'review', readinessInput: readyPacket(3)}})), /action_unavailable/);
  assert.deepEqual(await snapshot(state.root), before);
  await replacement.execute(event('handoff', recovered));
  assert.equal((await read(state.root, 'coordinator.json')).claim, null);
  assert.deepEqual((await replacement.inspect()).guidance.actions, []);
});

test('campaign and ordinary attempt brokers reject each other command envelopes', async () => {
  const {campaignBroker} = await import('../runtime/cli/experimental-campaign-workflow.js');
  const {WorkflowBroker} = await import('../runtime/integrations/host/claim-broker.js');
  let calls = 0;
  const workflow = {inspect: async () => { calls++; return {}; }, execute: async () => { calls++; return {}; },
    heartbeat: async () => {}, close: async () => {}};
  const campaign = campaignBroker(workflow, () => {}), attempt = new WorkflowBroker(workflow, () => {});
  assert.throws(() => campaign.dispatch(fromJSON({command: 'context'})), /campaign request required/);
  await assert.rejects(attempt.dispatch(fromJSON({command: 'campaign_context'})), /invalid_proposal/);
  assert.equal(calls, 0);
  await campaign.dispatch(fromJSON({command: 'campaign_context'}));
  assert.equal(calls, 1);
});

test('public experimental host routes campaign controls with a stable response envelope', posix, async t => {
  const {experimentalHost} = await import('../runtime/cli/experimental-host.js');
  const state = await fixtureState(t, 'campaign-route');
  state.clock.now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  await state.authority.set(fromJSON(input), 1n);
  const args = ['campaign', 'pause', '--root', state.root, '--native-lock', state.fixture.receipt.artifact,
    '--expected-revision', '2'];
  const before = await snapshot(state.root);
  assert.deepEqual(await experimentalHost(args), {ok: false, error: 'workflow_failed'});
  assert.deepEqual(await snapshot(state.root), before);
  const result = await experimentalHost([...args, '--host-user-event']);
  assert.equal(result.ok, true);
  assert.equal(result.result.status, 'paused');
  assert.equal(result.result.revision, 3);
  assert.deepEqual(await experimentalHost([...args, '--host-user-event']), {ok: false, error: 'workflow_failed'});
});

test('blocked queues need attention and a model cannot fabricate a fresh recovery task', posix, async t => {
  const state = await fixtureState(t, 'campaign-needs-attention'), {workflow} = state;
  const before = await snapshot(state.root), recovery = event('recover');
  await assert.rejects(async () => workflow.execute(recovery, recovery), /invalid_event/);
  assert.deepEqual(await snapshot(state.root), before);
  for (const jobId of ['job', 'other']) {
    const request = next(await workflow.inspect(), `start-${jobId}`);
    const task = (await workflow.execute(request, request)).receipt.task;
    await workflow.execute(event('handoff', task, {operationId: `block-${jobId}`, jobId}));
  }
  const context = await workflow.inspect();
  assert.equal(context.campaign.status, 'needs_attention');
  assert.equal(context.campaign.reason, 'campaign_jobs_need_attention');
  assert.equal(context.guidance.nextOperation, 'inspect_only');
  assert.deepEqual(context.guidance.actions, []);
  // Explicit owner reselection can retry a Needs Info job without a hidden cursor reset.
  await state.claims.select('job', 4n, true);
  assert.equal((await workflow.inspect()).campaign.nextJob.jobId, 'job');
});
