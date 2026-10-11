import { createHash } from 'node:crypto';
import { installedFixture, durableSnapshot, readDocument } from '../../tests_js/workspace_installed_workflows_support.mjs';
import { installedBrowserHost } from '../../tests_js/workspace_installed_workflows_browser_support.mjs';
import { prepareInstalledCampaign } from './scenarios.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pending = { status: 'active', handoffChecklist: ['resume_upload'] };

/** Hash the managed bytes as well as their canonical identity and applicant profile. */
export function immutableInputsDigest(snapshot) {
  return digest(Object.fromEntries(Object.entries(snapshot).filter(([name]) =>
    ['profile.json', 'resumes.json'].includes(name) || name.startsWith('resume-files/'))));
}

/** Trusted fixture owner. Only `model` is dispatched; none of these closures are model tools. */
export async function createInstalledModelFixture() {
  const state = await installedFixture();
  let host;
  try {
    await prepareInstalledCampaign(state);
    const resume = await state.call('store', ['resume-get'], undefined, ['--id', 'source']);
    host = await installedBrowserHost(state, { source: 'resume', kind: 'upload', resumeId: 'source',
      resumeRevision: String(resume.revision), contentRevision: String(resume.contentRevision) });
    const context = await state.call('workflow', ['browser', 'context'], undefined, ['--job-id', 'job']);
    const acquire = { ...context.guidance.actions.find(action => action.kind === 'acquire').input,
      operationId: 'model-fixture-acquire' };
    // Synthetic operator input, owned by the fixture controller before inference.
    const challenge = await host.trusted({ kind: 'operator-challenge', event: acquire, lifetime: 300000 });
    await host.trusted({ kind: 'operator-decide', challengeId: challenge.challengeId, decision: 'approve' });
    const task = (await state.call('workflow', ['browser', 'event'], acquire)).receipt.task;
    await host.trusted({ kind: 'operator-revoke', challengeId: challenge.challengeId });
    const binding = { taskId: task.taskId, taskRevision: task.revision, jobId: 'job',
      attemptRevision: task.subject.jobRevision, authorizationRevision: '1' };
    const publicCall = (command, input, extra = []) => state.call('workflow', ['browser', command], input, extra, { failure: true });
    const model = Object.freeze({
      context: jobId => publicCall('context', undefined, jobId ? ['--job-id', jobId] : []),
      event: input => publicCall('event', input),
      observe: input => publicCall('observe', input),
      execute: input => publicCall('execute', input),
      reconcile: (current, operationId) => publicCall('reconcile', { binding: current, operationId }),
    });
    const handoff = { kind: 'handoff', operationId: 'model-fixture-handoff', taskId: task.taskId,
      expectedRevision: task.revision, jobId: 'job', jobRevision: task.subject.jobRevision, status: 'needs_info', session: pending };
    return Object.freeze({
      model,
      prompt: `Work only on this fictional installed workflow. The trusted fixture has already acquired the exact claim. `
        + `Observe the form, upload valueRef selected-resume to control resume.file with operationId conversation-upload. `
        + `Replay that same operation once to verify recovery without a second write. `
        + `Do not submit or claim final-review readiness. Finish by saving this Needs Info handoff: ${JSON.stringify(handoff)}. `
        + `Current binding: ${JSON.stringify(binding)}. Return closed JSON proposals; use a new call ID per proposal.`,
      async readCanonical() {
        const jobs = await readDocument(state.root, 'jobs.json');
        const coordinator = await readDocument(state.root, 'coordinator.json');
        const snapshot = await durableSnapshot(state.root);
        const observation = await model.observe(binding);
        return { job: jobs.jobs.job, otherJob: jobs.jobs.other,
          operations: jobs.metadata.durableBrowserOperations?.operations ?? {},
          claimActive: coordinator.claim !== null,
          immutableDigest: immutableInputsDigest(snapshot), observation, stats: await host.trusted({ kind: 'stats' }) };
      },
      gradeCanonical: gradeInstalledModelFixture,
      async cleanup() {
        // Do not remove the fixture if host shutdown cannot be established.
        await host.stop();
        await state.cleanup();
      },
    });
  } catch (error) {
    if (host) await host.stop();
    await state.cleanup();
    throw error;
  }
}

/** Actual committed state plus trusted adapter observations, never assistant completion prose. */
export function gradeInstalledModelFixture(before, after) {
  const operation = after.operations['conversation-upload'];
  return {
    exactlyOneCanonicalUpload: Object.keys(before.operations).length === 0 && Object.keys(after.operations).length === 1
      && operation?.state === 'verified' && operation?.request.kind === 'upload'
      && operation?.request.controlId === 'resume.file' && operation?.request.valueRef === 'selected-resume'
      && operation?.request.scope.jobId === 'job',
    exactlyOneBrowserWrite: after.stats.writes === before.stats.writes + 1,
    observedUploadComplete: after.observation.controls?.find(control => control.id === 'resume.file')?.state === 'complete',
    finalActionUntouched: before.observation.finalAction === 'untouched' && after.observation.finalAction === 'untouched',
    needsInfoHandoffReleasedClaim: before.claimActive && !after.claimActive && after.job.status === 'needs_info',
    unrelatedJobPreserved: digest(before.otherJob) === digest(after.otherJob),
    profileAndManagedResumePreserved: before.immutableDigest === after.immutableDigest,
    noInventedFinalReview: !['applied', 'awaiting_review'].includes(after.job.status),
  };
}
