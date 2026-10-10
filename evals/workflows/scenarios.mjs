import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installedFixture, durableSnapshot, readDocument } from '../../tests_js/workspace_installed_workflows_support.mjs';

export const scenarioIds = ['campaign-blocked-queue', 'campaign-broker-restart'];
const extraction = { id: 'resume.extract', version: 1 };
const preparation = { id: 'application.prepare', version: 1 };
const pending = { status: 'active', blockers: [{ type: 'information', code: 'owner-input-required' }], handoffChecklist: ['resume_upload'] };
const next = (context, kind, operationId) => {
  const action = context.guidance.actions.find(value => value.kind === kind);
  assert.ok(action, `Missing ${kind}: ${JSON.stringify(context.guidance)}`);
  return { ...action.input, operationId };
};
async function stableRejection(state, commands, payload, extra = []) {
  const before = await durableSnapshot(state.root);
  const rejected = await state.call('workflow', commands, payload, extra, { failure: true });
  assert.equal(rejected.ok, false);
  assert.deepEqual(await durableSnapshot(state.root), before);
  return rejected.error;
}
export async function prepareInstalledCampaign(state, checks = {}) {
  const call = state.call;
  const source = join(state.directory, 'synthetic.txt');
  await writeFile(source, 'Fictional Candidate\nEngineer with synthetic experience.', { mode: 0o600 });
  await call('store', ['resume-import'], { id: 'source', label: 'Synthetic' }, ['--path', source]);
  for (const id of ['job', 'other']) await call('store', ['job-create'], {
    id, url: `https://example.invalid/${id}`, role: 'Engineer', company: 'Synthetic', ats: 'greenhouse',
  });
  const initial = await durableSnapshot(state.root);
  const started = await call('workflow', ['resume', 'route'], {
    kind: 'newTask', operationId: 'extract-start', taskId: null, expectedRevision: null,
    workflow: extraction, input: { resumeId: 'source', resumeRevision: '1' },
  });
  const first = started.receipt.task;
  const proposed = await call('workflow', ['resume', 'action'], {
    kind: 'callTool', operationId: 'extract-propose', taskId: first.taskId, expectedRevision: first.revision,
    actionId: 'resume.propose', arguments: { name: 'Fictional Candidate', skills: ['Synthetic'] },
  });
  const second = proposed.receipt.task;
  const waiting = await call('workflow', ['resume', 'action'], {
    kind: 'askUser', operationId: 'extract-ask', taskId: second.taskId, expectedRevision: second.revision, actionId: 'resume.review',
  });
  const task = waiting.receipt.task;
  const context = await call('workflow', ['resume', 'context']);
  assert.equal(context.approvalEvidence, 'host_attestation');
  const reply = { kind: 'continue', operationId: 'extract-reply', taskId: task.taskId,
    expectedRevision: task.revision, event: { ...context.review, decision: 'accept' } };
  assert.equal(await stableRejection(state, ['resume', 'reply'], reply), 'user_event_required');
  checks.unattestedReplyBlocked = true;
  const accepted = await call('workflow', ['resume', 'reply'], reply, ['--host-user-event']);
  assert.equal(accepted.receipt.outcome, 'extraction_accepted');
  const after = await durableSnapshot(state.root);
  const replay = await call('workflow', ['resume', 'reply'], reply, ['--host-user-event']);
  assert.equal(replay.replayed, true);
  assert.deepEqual(await durableSnapshot(state.root), after);
  await stableRejection(state, ['resume', 'reply'], { ...reply, event: { ...reply.event, decision: 'reject' } }, ['--host-user-event']);
  checks.exactReplyReplayInert = true;
  const facts = await call('store', ['resume-facts-get'], undefined, ['--resume-id', 'source']);
  assert.equal(facts.state, 'confirmed');
  const run = await call('store', ['application-run-start'], { jobIds: ['job', 'other'] }, [
    '--resume-id', 'source', '--expected-resume-revision', '1', '--expected-fact-revision', String(facts.revision), '--owner-confirmed',
  ]);
  for (const id of ['job', 'other']) {
    const started = await call('workflow', ['prepare', 'route'], {
      kind: 'newTask', operationId: `prepare-${id}`, taskId: null, expectedRevision: null,
      workflow: preparation, input: { jobId: id, jobRevision: '1' },
    });
    const task = started.receipt.task;
    const waiting = await call('workflow', ['prepare', 'action'], {
      kind: 'askUser', operationId: `ask-${id}`, taskId: task.taskId, expectedRevision: task.revision, actionId: 'application.confirm_selection',
    });
    const review = waiting.receipt.task;
    await call('workflow', ['prepare', 'reply'], { kind: 'continue', operationId: `ready-${id}`, taskId: review.taskId,
      expectedRevision: review.revision, event: { requestId: review.pending.requestId, jobRevision: review.subject.jobRevision, decision: 'confirm' } }, ['--host-user-event']);
  }
  await call('store', ['application-authority-set'], { mode: 'campaign_to_review', runId: run.runId,
    jobIds: ['other', 'job'], sensitiveAnswerRefs: [], durationMinutes: 120 }, ['--expected-revision', '0']);
  checks.confirmedFactsFeedActualRun = true;
  return { initial, run };
}
export async function runScenario(id) {
  if (!scenarioIds.includes(id)) throw Error('Unknown installed workflow scenario');
  const state = await installedFixture(), checks = {};
  const startedAt = performance.now();
  try {
    const { initial } = await prepareInstalledCampaign(state, checks);
    let broker = await state.startBroker();
    let context = await state.call('workflow', ['campaign', 'context']);
    assert.equal(context.campaign.nextJob.jobId, 'job');
    const first = next(context, 'acquire', 'acquire-job');
    await stableRejection(state, ['campaign', 'event'], first);
    await stableRejection(state, ['campaign', 'event'], { ...first, jobId: 'other' }, ['--host-user-event']);
    checks.outOfOrderAndUnattestedAcquireBlocked = true;
    const acquired = await state.call('workflow', ['campaign', 'event'], first, ['--host-user-event']);
    const task = acquired.receipt.task;
    if (id === 'campaign-broker-restart') {
      await state.stopBroker(broker);
      broker = await state.startBroker();
      const before = await durableSnapshot(state.root);
      context = await state.call('workflow', ['campaign', 'context']);
      assert.equal(context.campaign.nextJob, null);
      assert.deepEqual(context.guidance.actions, []);
      await stableRejection(state, ['campaign', 'event'], { ...first, operationId: 'blind-retry' }, ['--host-user-event']);
      assert.deepEqual(await durableSnapshot(state.root), before);
      checks.liveClaimRequiresRecoveryWait = true;
    } else {
      await stableRejection(state, ['campaign', 'pause'], undefined, ['--expected-revision', '1']);
      await state.call('workflow', ['campaign', 'pause'], undefined, ['--expected-revision', '1', '--host-user-event']);
      const progress = { kind: 'progress', operationId: 'paused-progress', taskId: task.taskId, expectedRevision: task.revision,
        jobId: 'job', jobRevision: task.subject.jobRevision, session: pending };
      await stableRejection(state, ['campaign', 'event'], progress);
      await stableRejection(state, ['campaign', 'resume'], undefined, ['--expected-revision', '1', '--host-user-event']);
      await state.call('workflow', ['campaign', 'resume'], undefined, ['--expected-revision', '2', '--host-user-event']);
      checks.pauseAndStaleResumeBlocked = true;
      const handoff = { ...progress, kind: 'handoff', operationId: 'block-job', status: 'needs_info' };
      await state.call('workflow', ['campaign', 'event'], handoff);
      const after = await durableSnapshot(state.root);
      assert.equal((await state.call('workflow', ['campaign', 'event'], handoff)).replayed, true);
      assert.deepEqual(await durableSnapshot(state.root), after);
      await state.stopBroker(broker);
      broker = await state.startBroker();
      context = await state.call('workflow', ['campaign', 'context']);
      assert.equal(context.campaign.nextJob.jobId, 'other');
      const second = await state.call('workflow', ['campaign', 'event'], next(context, 'acquire', 'acquire-other'), ['--host-user-event']);
      const other = second.receipt.task;
      await state.call('workflow', ['campaign', 'event'], { ...handoff, operationId: 'block-other', jobId: 'other',
        taskId: other.taskId, expectedRevision: other.revision, jobRevision: other.subject.jobRevision });
      context = await state.call('workflow', ['campaign', 'context']);
      assert.equal(context.campaign.status, 'needs_attention');
      assert.equal(context.guidance.nextOperation, 'inspect_only');
      assert.deepEqual(context.guidance.actions, []);
      checks.restartSelectsNextThenBlockedQueueStops = true;
      const jobs = await readDocument(state.root, 'jobs.json');
      assert.equal(jobs.jobs.job.status, 'needs_info');
      assert.equal(jobs.jobs.other.status, 'needs_info');
    }
    await state.stopBroker(broker);
    const final = await durableSnapshot(state.root);
    assert.equal(final['profile.json'], initial['profile.json']);
    assert.equal(final['resumes.json'], initial['resumes.json']);
    for (const [name, bytes] of Object.entries(initial)) if (name.startsWith('resumes/')) assert.equal(final[name], bytes);
    checks.unrelatedProfileAndManagedResumePreserved = true;
    const jobs = await readDocument(state.root, 'jobs.json');
    assert.ok(Object.values(jobs.jobs).every(job => !['applied', 'awaiting_review'].includes(job.status)));
    checks.noSubmissionOrInventedReview = true;
    return { schemaVersion: 1, scenario: id, evidenceKind: 'deterministic_installed_commands',
      checks, calls: state.calls, elapsedMs: performance.now() - startedAt, modelTranscript: null };
  } finally { await state.cleanup(); }
}
