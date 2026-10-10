import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { ApplicationAuthorityService } from '../runtime/workspace-core/application-authority.js';
import { NativeCampaignWorkflowTasks } from '../runtime/store/native-campaign-workflow-tasks.js';
import { SequentialCampaignWorkflow } from '../runtime/app/sequential-campaign-workflow.js';
import { attemptProfile } from '../runtime/workflows/applications/attempt.js';
import { fromJSON } from '../runtime/contracts/workspace/values.js';
import { setup, extractAndStartRun, prepareJob, assertUnrelatedPreserved, read, plain,
  snapshot, unchanged, event, pending } from './workspace_combined_workflows_support.mjs';

function campaign(state) {
  const now = () => state.clock.now;
  const authority = new ApplicationAuthorityService(state.repository, now);
  const access = { enabled: [attemptProfile], authorized: [attemptProfile] };
  const workflow = new SequentialCampaignWorkflow(new NativeCampaignWorkflowTasks(state.repository, now),
    state.claims, authority, () => access, now);
  return { workflow, authority };
}
async function grant(state, authority) {
  const current = plain(await authority.status());
  return plain(await authority.set(fromJSON({ mode: 'campaign_to_review', runId: state.run.runId,
    jobIds: ['job', 'other'], sensitiveAnswerRefs: [], durationMinutes: 60 }), BigInt(current.revision)));
}

test('native two-job campaign resumes its exact queue after interruption and pause', { timeout: 90000 }, async () => {
  const fixture = await nativeFixture();
  let live;
  try {
    const state = await setup(fixture, 'combined-campaign');
    await extractAndStartRun(state);
    await prepareJob(state);
    await prepareJob(state, 'other');
    live = campaign(state);
    await grant(state, live.authority);
    assert.deepEqual((await live.workflow.inspect()).campaign.nextJob, { jobId: 'job', jobRevision: '2' });
    const second = event('acquire', null, { operationId: 'campaign-second', jobId: 'other', jobRevision: '2' });
    await unchanged(state, () => live.workflow.execute(second, second), /action_unavailable/);
    const acquire = event('acquire', null, { operationId: 'campaign-first' });
    const task = (await live.workflow.execute(acquire, acquire)).receipt.task;
    await live.workflow.close();
    live = campaign(state);
    assert.equal((await live.workflow.inspect()).brokerAvailable, false);
    assert.equal((await live.workflow.inspect()).campaign.nextJob, null);
    await unchanged(state, () => live.workflow.execute(second, second), /task_conflict/);
    const recover = event('recover', task, { operationId: 'campaign-recovery' });
    state.clock.now = '2026-10-10T12:05:00Z';
    const recovered = (await live.workflow.execute(recover, recover)).receipt.task;
    const handoff = event('handoff', recovered, { operationId: 'campaign-first-handoff', session: pending });
    const completed = await live.workflow.execute(handoff);
    assert.equal(completed.receipt.outcome, 'needs_info');
    assert.deepEqual((await live.workflow.inspect()).campaign.nextJob, { jobId: 'other', jobRevision: '2' });
    const revision = String(plain(await live.authority.status()).revision);
    await live.workflow.control('pause', revision, { action: 'pause', expectedRevision: revision });
    await live.workflow.close();
    live = campaign(state);
    assert.equal(plain(await live.authority.status()).status, 'paused');
    assert.equal((await live.workflow.inspect()).campaign.nextJob, null);
    await unchanged(state, () => live.workflow.execute(second, second), /action_unavailable/);
    const paused = String(plain(await live.authority.status()).revision);
    await unchanged(state, () => live.workflow.control('resume', revision,
      { action: 'resume', expectedRevision: revision }), /revision/);
    await live.workflow.control('resume', paused, { action: 'resume', expectedRevision: paused });
    assert.deepEqual((await live.workflow.inspect()).campaign.nextJob, { jobId: 'other', jobRevision: '2' });
    const secondTask = (await live.workflow.execute(second, second)).receipt.task;
    assert.equal(secondTask.subject.jobId, 'other');
    const before = await snapshot(state.root);
    assert.deepEqual(await live.workflow.execute(handoff), { receipt: completed.receipt, replayed: true });
    assert.deepEqual(await snapshot(state.root), before);
    assert.equal((await live.workflow.inspect()).brokerAvailable, true);
    const active = plain(await live.authority.status());
    await live.authority.revoke(BigInt(active.revision));
    await unchanged(state, () => live.workflow.execute(event('progress', secondTask,
      { operationId: 'revoked-campaign-progress', jobId: 'other' })), /action_unavailable/);
    const safe = event('handoff', secondTask, { operationId: 'campaign-safe-stop', jobId: 'other', session: pending });
    assert.equal((await live.workflow.execute(safe)).receipt.outcome, 'needs_info');
    assert.equal((await read(state.root, 'coordinator.json')).claim, null);
    assert.equal((await read(state.root, 'jobs.json')).jobs.job.status, 'needs_info');
    assert.equal((await read(state.root, 'jobs.json')).jobs.other.status, 'needs_info');
    await assertUnrelatedPreserved(state);
  } finally {
    await live?.workflow.close();
    await fixture.cleanup();
  }
});
