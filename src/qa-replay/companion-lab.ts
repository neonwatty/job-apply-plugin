import { randomBytes } from 'node:crypto';
import { lstat, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanup, prepare, transition } from './coordinator.js';
import { canonical, readJson, ReplayError } from './contracts.js';
import {
  approveSubmissionBatch, executeSubmissionBatch, previewSubmissionBatch, stopSubmissionBatch, submissionBatchStatus,
} from './submission-batch.js';
import { labApprovalEnabled, requireIsolatedPath, requireLoopbackOrigin, requirePrivateDirectory, runsRoot, submissionFixture,
  submissionMode, submissionScenario, withQaLock } from './submission-boundary.js';
import { submissionJob, submissionJobs } from './submission-jobs.js';

type Run = { runId: string; jobId: string; url: string; reviewed: boolean };
type Selection = { batchId: string; batchRevision: string };
type Session = { runs: Run[]; batch?: Selection };

function fields(input: unknown, keys: string[]): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)
    || Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) {
    throw new ReplayError('Invalid submission lab request.');
  }
  return input as Record<string, unknown>;
}

async function readSession(path: string): Promise<Session | null> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return await readJson(path, 'The submission lab session is unavailable.') as Session;
}

async function saveLabState(path: string, value: Session | boolean): Promise<void> {
  const temporary = `${path}.${randomBytes(16).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, canonical(value), { mode: 0o600, flag: 'wx', flush: true });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function startSession(path: string, input: unknown): Promise<Session> {
  const { jobIds } = fields(input, ['jobIds']);
  if (!Array.isArray(jobIds) || jobIds.length < 1
    || jobIds.length > 3 || new Set(jobIds).size !== jobIds.length || jobIds.some(id => typeof id !== 'string')) {
    throw new ReplayError('Choose one to three distinct fictional jobs.');
  }
  const jobs = jobIds.map(id => submissionJob(id));
  const runs: Run[] = [];
  try {
    for (const job of jobs) {
      const result = await prepare(submissionFixture, submissionScenario, submissionMode, job.jobId, true);
      const url = new URL(String(result.url)).origin;
      requireLoopbackOrigin(url);
      const run = { runId: String(result.runId), jobId: job.jobId, url, reviewed: false };
      runs.push(run);
      await transition(run.runId, 'started');
    }
    const session: Session = { runs };
    await saveLabState(path, session);
    return session;
  } catch (error) {
    await Promise.allSettled(runs.map(run => cleanup(run.runId)));
    throw error;
  }
}

function sessionView(session: Session | null) {
  return session && {
    runs: session.runs.map(run => ({ ...run, ...submissionJob(run.jobId) })),
  };
}

export async function companionLab(action: string, input: unknown): Promise<unknown> {
  const requested = runsRoot();
  if (!process.env.JOB_APPLY_QA_RUNS_ROOT || process.platform === 'win32') throw new ReplayError('The submission lab is unavailable.');
  const root = await realpath(requested);
  if (root !== requested) throw new ReplayError('The submission lab is unavailable.');
  await requireIsolatedPath(root);
  await requirePrivateDirectory(root);
  const path = join(root, 'lab-session.json');

  if (action === 'load') {
    fields(input, []);
    const session = await readSession(path);
    const report = session?.batch ? await submissionBatchStatus(session.batch.batchId) : null;
    return { approvalEnabled: await labApprovalEnabled(root), jobs: submissionJobs(), session: sessionView(session), report };
  }
  if (action === 'execute' || action === 'stop') {
    const { batchId } = fields(input, ['batchId']);
    const session = await readSession(path);
    if (typeof batchId !== 'string' || session?.batch?.batchId !== batchId) {
      throw new ReplayError('The batch selection changed. Refresh the lab.');
    }
    return action === 'execute' && await labApprovalEnabled(root) ? executeSubmissionBatch(batchId) : stopSubmissionBatch(batchId);
  }

  return withQaLock(join(root, '.lab.lock'), async () => {
    const session = await readSession(path);
    if (action === 'set-approval') {
      const { enabled } = fields(input, ['enabled']);
      if (typeof enabled !== 'boolean') throw new ReplayError('Choose on or off for Submit after approval.');
      const report = !enabled && session?.batch ? await stopSubmissionBatch(session.batch.batchId) : null;
      await saveLabState(join(root, 'lab-mode.json'), enabled);
      return { approvalEnabled: enabled, report };
    }
    if (action === 'start') {
      if (session) throw new ReplayError('End the current lab session before starting another.');
      return sessionView(await startSession(path, input));
    }
    if (!session) throw new ReplayError('Start a lab session first.');
    if (action === 'check-reviews') {
      fields(input, []);
      for (const run of session.runs) {
        if (run.reviewed) continue;
        try {
          await transition(run.runId, 'reviewed');
          run.reviewed = true;
        } catch (error) {
          if (!(error instanceof ReplayError) || error.message !== 'replay review event not observed') throw error;
        }
      }
      await saveLabState(path, session);
      return sessionView(session);
    }
    if (action === 'end') {
      fields(input, []);
      if (session.batch) {
        await stopSubmissionBatch(session.batch.batchId);
        await submissionBatchStatus(session.batch.batchId);
      }
      await Promise.all(session.runs.map(run => cleanup(run.runId)));
      await unlink(path);
      return { ended: true };
    }
    if (!await labApprovalEnabled(root)) throw new ReplayError('Submit after approval is off. Applications stay at Review.');
    if (action === 'preview') {
      fields(input, []);
      if (session.runs.some(run => !run.reviewed)) throw new ReplayError('Reach Review on each application, then check the reviews.');
      if (session.batch) {
        const report = await submissionBatchStatus(session.batch.batchId);
        const untouched = report.status === 'stopped' && report.jobs.every(job => job.status === 'stopped');
        if (report.status !== 'awaiting_approval' && !untouched) throw new ReplayError('This session already has a batch outcome.');
      }
      const preview = await previewSubmissionBatch(session.runs.map(run => run.runId), true);
      session.batch = { batchId: preview.batchId, batchRevision: preview.batchRevision };
      await saveLabState(path, session);
      return preview;
    }
    if (action === 'approve') {
      const { batchId, batchRevision, ownerConfirmed } = fields(input, ['batchId', 'batchRevision', 'ownerConfirmed']);
      if (typeof batchId !== 'string' || typeof batchRevision !== 'string' || ownerConfirmed !== true
        || session.batch?.batchId !== batchId || session.batch.batchRevision !== batchRevision) {
        throw new ReplayError('Confirm the exact batch preview to approve it.');
      }
      return approveSubmissionBatch(batchId, batchRevision);
    }
    throw new ReplayError('Unknown submission lab action.');
  });
}
