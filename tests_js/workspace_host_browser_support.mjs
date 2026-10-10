import { ClaimWorkflow } from '../runtime/app/claim-workflow.js';
import { NativeClaimWorkflowTasks } from '../runtime/store/native-claim-workflow-tasks.js';
import { NativeBrowserOperations } from '../runtime/store/native-browser-operations.js';
import { ApplicationAuthorityService } from '../runtime/workspace-core/application-authority.js';
import { fromJSON } from '../runtime/contracts/workspace/values.js';
import { attemptProfile } from '../runtime/workflows/applications/attempt.js';
import { createWorkflowBrowserHost } from '../runtime/integrations/host/workflow-browser-host.js';
import { SyntheticBrowserAdapter } from '../runtime/integrations/browser/synthetic.js';
import { controlFingerprint } from '../runtime/integrations/browser/contract.js';
import { setup, extractAndStartRun, prepareJob, plain, read } from './workspace_combined_workflows_support.mjs';
export { read, snapshot, unchanged, assertUnrelatedPreserved } from './workspace_combined_workflows_support.mjs';
export { event } from './workspace_durable_claims_support.mjs';

export function synthetic(values = new Map([['profile.name', 'UNRELATED PRIVATE PROFILE'], ['resume.source', 'PRIVATE MANAGED RESUME']])) {
  const controls = [{ id: 'contact.name', kind: 'fill', state: 'empty' },
    { id: 'resume.file', kind: 'upload', state: 'empty' }, { id: 'submit', kind: 'final', state: 'empty' }];
  return new SyntheticBrowserAdapter({ evidenceKind: 'synthetic_adapter', observationRevision: '1',
    controls, finalAction: 'untouched', form: { documentId: 'host-document', formId: 'host-form',
      origin: 'https://example.invalid', controlSetFingerprint: controlFingerprint(controls) } },
  values);
}
export async function setupHost(fixture, name) {
  const state = await setup(fixture, name);
  await extractAndStartRun(state);
  await prepareJob(state);
  const now = () => state.clock.now;
  state.authority = new ApplicationAuthorityService(state.repository, now);
  state.authorization = plain(await state.authority.set(fromJSON({ mode: 'autofill_to_review',
    runId: state.run.runId, jobIds: ['job'], sensitiveAnswerRefs: [], durationMinutes: 60 }), 0n));
  const profile = await read(state.root, 'profile.json'), resume = (await read(state.root, 'resumes.json')).resumes.source;
  state.grants = new Map([
    ['profile.name', { kind: 'fill', source: 'profile', field: 'name', profileRevision: String(profile.metadata.revision ?? 1) }],
    ['resume.source', { kind: 'upload', source: 'resume', resumeId: 'source', resumeRevision: String(resume.revision),
      contentRevision: resume.contentRevision }],
  ]);
  state.adapter = synthetic();
  return state;
}
export function host(state, options = {}) {
  const now = () => state.clock.now;
  return createWorkflowBrowserHost({
    createWorkflow: verifier => new ClaimWorkflow(new NativeClaimWorkflowTasks(state.repository, now), state.claims,
      () => ({ enabled: [attemptProfile], authorized: [attemptProfile] }), now, verifier),
    adapter: options.adapter ?? state.adapter, grants: options.grants ?? state.grants,
    controls: options.controls ?? new Map([['contact.name', 'profile.name'], ['resume.file', 'resume.source']]),
    operations: options.operations ?? new NativeBrowserOperations(state.repository),
  });
}
export async function acquire(ports, operationId = 'host-acquire') {
  const event = { kind: 'acquire', operationId, taskId: null, expectedRevision: null, jobId: 'job', jobRevision: '2' };
  const review = await ports.host.review(event);
  ports.host.approvals.approve(review.binding, 300000);
  return (await ports.model.event(event)).receipt.task;
}
export function binding(state, task) {
  return { taskId: task.taskId, taskRevision: task.revision, jobId: task.subject.jobId,
    attemptRevision: task.subject.jobRevision, authorizationRevision: String(state.authorization.revision) };
}
export async function proposal(ports, state, task, overrides = {}) {
  const scope = binding(state, task), observed = await ports.model.observe(scope);
  return { operationId: 'host-fill', kind: 'fill', controlId: 'contact.name', valueRef: 'profile.name',
    scope: { ...scope, form: observed.form, observationRevision: observed.observationRevision }, ...overrides };
}
