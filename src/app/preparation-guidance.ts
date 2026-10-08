import { activeApplicationRun, currentRunJobIds } from '../contracts/workspace/application-runs.js';
import { applicationPreflight } from '../contracts/workspace/application-policy.js';
import { inspectRunInputs, latestRunFacts } from '../contracts/workspace/application-run-inputs.js';
import type { PreparationDomain } from '../contracts/workspace/preparation-domain.js';
import type { WorkflowTask } from '../contracts/workspace/workflow-tasks.js';
import { get, int, object, string, JobsError } from '../contracts/workspace/values.js';
import type { Value } from '../contracts/workspace/values.js';
import type { ProfileAccess } from '../harness/contracts.js';
import { preparationIdentity, preparationRegistry, selectionConfirmation } from '../workflows/applications/prepare.js';
import { inspectExplicitSelection } from './preparation-selection.js';

/** Advisory metadata from one locked snapshot; contains no applicant facts, paths or authority. */
export async function preparationGuidance(domain: PreparationDomain, task: WorkflowTask | null,
  currentAccess: () => ProfileAccess, requestedJobId?: string) {
  const enabled = () => preparationRegistry().eligible(currentAccess()).some(item => item.id === preparationIdentity.id);
  const unavailable = { guidance: { nextOperation: 'profile_unavailable', blockers: ['profile_unavailable'] } };
  if (!enabled()) return { ...unavailable, ...(requestedJobId === undefined ? {} : {
    selection: await inspectExplicitSelection(domain, requestedJobId, task?.taskId ?? null, currentAccess()) }) };
  const snapshot = domain.snapshot, run = activeApplicationRun(snapshot.jobs);
  const records = object(get(snapshot.jobs, 'jobs'), 'jobs').entries().map(([, value]) => object(value, 'job'))
    .filter(job => get(job, 'deletedAt') === null);
  const queuedIds = run === null ? [] : currentRunJobIds(run);
  const jobs = records.filter(job => run === null || queuedIds.includes(string(get(job, 'id'))!))
    .map(job => ({ jobId: string(get(job, 'id'))!, jobRevision: int(get(job, 'revision'))!.toString(),
      status: string(get(job, 'status')), role: string(get(job, 'role')), company: string(get(job, 'company')) }));
  // Discovery never infers a new choice: only one already-Ready job in the current run can resume implicitly.
  const selected = run === null ? [] : jobs.filter(job => job.status === 'ready');
  const implicitId = task?.subject.jobId ?? (selected.length === 1 ? selected[0]!.jobId : undefined);
  const jobId = requestedJobId ?? implicitId;
  const job = jobId === undefined ? undefined : records.find(item => string(get(item, 'id')) === jobId);
  if (!job && requestedJobId === undefined) return { guidance: {
    nextOperation: task ? 'job_unavailable' : 'choose_job', blockers: task ? ['job_unavailable'] : [], jobs } };
  const selection = await inspectExplicitSelection(domain, jobId!, task?.taskId ?? null, currentAccess());
  const preflight = await applicationPreflight(snapshot, job!);
  const blockers = (get(preflight, 'errors') as Value[]).map(value => string(value)!);
  let nextOperation = selection.ready ? 'report_ready' : selection.allowedActions.includes('select') ? 'select' : 'resolve_blockers';
  let resumeChoices: Array<unknown> = [];
  const taskMatches = task?.subject.jobId === selection.jobId;
  const pendingCurrent = taskMatches && task?.pending && task.subject.jobRevision === selection.jobRevision
    && task.subject.inputRevision === selection.inputRevision && get(preflight, 'ready') === true;
  if (task && !taskMatches) {
    nextOperation = 'continue_task';
    blockers.push('different_active_preparation');
  } else if (task) nextOperation = task.pending
    ? pendingCurrent ? 'await_reply_or_cancel' : 'cancel_stale_preparation' : 'continue_task';
  else if (get(snapshot.coordinator, 'claim') !== null) nextOperation = 'claim_requires_handoff';
  else if (run === null) {
    nextOperation = 'choose_resume_then_start_run';
    for (const [, value] of object(get(snapshot.resumes, 'resumes'), 'resumes').entries()) {
      const resume = object(value, 'resume');
      if (get(resume, 'deletedAt') !== null || string(get(resume, 'storageKind')) !== 'managed') continue;
      const resumeId = string(get(resume, 'id'))!, resumeRevision = int(get(resume, 'revision'))!;
      const facts = latestRunFacts(snapshot, resumeId), factRevision = facts === null ? null : int(get(facts, 'revision'));
      let available = false;
      const inputBlockers: string[] = [];
      if (factRevision !== null) {
        try { await inspectRunInputs(snapshot, resumeId, resumeRevision, factRevision); available = true; }
        catch (error) {
          if (!(error instanceof JobsError)) throw error;
          if (error.message === 'resume file changed') inputBlockers.push('resume_file_changed');
          else if (error.message === 'confirmed resume facts are unavailable or stale') inputBlockers.push('resume_facts_unconfirmed');
          else if (['managed resume content is unavailable', 'resume file exceeds the 10 MiB limit',
            'resume source changed during import'].includes(error.message)) inputBlockers.push('resume_file_unavailable');
          else throw error;
        }
      } else inputBlockers.push('resume_facts_missing');
      resumeChoices.push({ resumeId, label: string(get(resume, 'label')), resumeRevision: resumeRevision.toString(),
        factRevision: factRevision?.toString() ?? null, factState: facts === null ? 'missing' : string(get(facts, 'state')),
        available, blockers: inputBlockers, runStart: available ? {
          args: ['store', 'application-run-start', '--resume-id', resumeId, '--expected-resume-revision', resumeRevision.toString(),
            '--expected-fact-revision', factRevision!.toString(), '--owner-confirmed'],
          input: { jobIds: [jobId] }, requiresExplicitInputConfirmation: true,
        } : null });
    }
  }
  if (!enabled()) return unavailable;
  return { selection, guidance: { nextOperation, blockers, jobs,
    run: run === null ? null : { runId: string(get(run, 'runId')), revision: int(get(run, 'revision'))!.toString(),
      resumeId: string(get(object(get(run, 'selection'), 'run selection'), 'resumeId')) },
    resumeChoices, confirmation: pendingCurrent && task?.pending ? { ...selectionConfirmation, requestId: task.pending.requestId } : null } };
}
