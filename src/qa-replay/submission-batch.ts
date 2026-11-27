import { join } from 'node:path';
import { ReplayError, runIdentifier } from './contracts.js';
import { submissionCommand } from './coordinator.js';
import { withQaLock } from './submission-boundary.js';
import {
  createBatch, isBatchStopped, readBatch, readBatchApproval, readBatchResult, recordBatchApproval,
  recordBatchResult, reviewRevisionPattern, stopBatch, type BatchItem, type BatchResult,
} from './submission-batch-store.js';
import { submissionJob } from './submission-jobs.js';

type Batch = Awaited<ReturnType<typeof readBatch>>;

export async function previewSubmissionBatch(runIds: string[], allowSingle = false) {
  if (runIds.length < (allowSingle ? 1 : 2) || runIds.length > 3 || runIds.some(id => !runIdentifier.test(id))) {
    throw new ReplayError(allowSingle ? 'select one to three reviewed synthetic run IDs' : 'select two or three reviewed synthetic run IDs');
  }
  if (new Set(runIds).size !== runIds.length) throw new ReplayError('batch jobs and runs must be unique');
  const items: BatchItem[] = [];
  const reviews = [];
  for (const runId of runIds) {
    const status = await submissionCommand(runId, 'status');
    if (status.status !== 'awaiting_approval') throw new ReplayError('each batch job must be awaiting approval');
    const preview = await submissionCommand(runId, 'preview');
    const { jobId } = submissionJob(preview.jobId);
    const { reviewRevision } = preview;
    if (typeof reviewRevision !== 'string' || !reviewRevisionPattern.test(reviewRevision)) {
      throw new ReplayError('synthetic batch review is invalid');
    }
    items.push({ runId, jobId, reviewRevision });
    reviews.push({ ...preview, runId });
  }
  const batch = await createBatch(items);
  return { batchId: batch.batchId, batchRevision: batch.batchRevision, status: 'awaiting_approval', jobs: reviews };
}

function batchLock<T>(batch: Batch, operation: () => Promise<T>) {
  return withQaLock(join(batch.root, '.batch.lock'), operation);
}

export async function approveSubmissionBatch(batchId: string, batchRevision: string) {
  const batch = await readBatch(batchId);
  if (batchRevision !== batch.batchRevision) throw new ReplayError('an exact synthetic batch revision is required');
  return batchLock(batch, async () => {
    if (!await readBatchApproval(batch)) {
      for (const item of batch.items) {
        const { status } = await submissionCommand(item.runId, 'status');
        const preview = await submissionCommand(item.runId, 'preview');
        if (status !== 'awaiting_approval' || preview.jobId !== item.jobId || preview.reviewRevision !== item.reviewRevision) {
          throw new ReplayError('synthetic batch review changed; request a new batch preview');
        }
      }
    }
    const approval = await recordBatchApproval(batch);
    return { batchId, batchRevision, status: 'approved', expiresAt: new Date(approval.expiresAt).toISOString() };
  });
}

function confirmed(result: Record<string, unknown>): BatchResult | null {
  if (result.status === 'confirmed_submitted' && typeof result.receiptId === 'string' && /^receipt:[a-f0-9]{64}$/.test(result.receiptId)) {
    return { status: result.status, receiptId: result.receiptId };
  }
  return null;
}

async function reconcile(batch: Batch, item: BatchItem) {
  try {
    return await submissionCommand(item.runId, 'status', item.reviewRevision, batch.batchId);
  } catch {
    return { status: 'submission_uncertain' };
  }
}

async function previewMatches(item: BatchItem): Promise<Extract<BatchResult, { status: 'needs_attention' }> | null> {
  try {
    const preview = await submissionCommand(item.runId, 'preview');
    return preview.jobId === item.jobId && preview.reviewRevision === item.reviewRevision
      ? null : { status: 'needs_attention', reason: 'review_changed' };
  } catch (error) {
    const changed = error instanceof ReplayError && [
      'verified synthetic review is required', 'complete the synthetic browser review first', 'synthetic submission inputs have changed',
    ].includes(error.message);
    return { status: 'needs_attention', reason: changed ? 'review_changed' : 'run_unavailable' };
  }
}

async function executeItem(batch: Batch, item: BatchItem): Promise<void> {
  const prior = await readBatchResult(batch, item);
  if (prior?.status === 'in_progress' || prior?.status === 'submission_uncertain') {
    const outcome = confirmed(await reconcile(batch, item)) ?? { status: 'submission_uncertain' as const };
    await recordBatchResult(batch, item, outcome);
    return;
  }
  if (prior) return;
  const approval = await readBatchApproval(batch);
  if (await isBatchStopped(batch) || !approval || Date.now() >= approval.expiresAt) return;

  const issue = await previewMatches(item);
  if (await isBatchStopped(batch) || Date.now() >= approval.expiresAt) return;
  if (issue) {
    await recordBatchResult(batch, item, issue);
    return;
  }

  await recordBatchResult(batch, item, { status: 'in_progress' });
  let result: BatchResult;
  try {
    const outcome = await submissionCommand(item.runId, 'submit', item.reviewRevision, batch.batchId);
    result = confirmed(outcome) ?? (outcome.status === 'submission_uncertain' ? { status: 'submission_uncertain' }
      : { status: 'needs_attention', reason: 'submission_blocked' });
  } catch (error) {
    const settled = await reconcile(batch, item);
    const knownDenial = error instanceof ReplayError && [
      'synthetic batch permission is unavailable', 'synthetic review changed; request a new preview',
      'complete the synthetic browser review first', 'fixture server identity mismatch', 'verified synthetic review is required',
      'synthetic submission inputs have changed', 'run is terminal',
    ].includes(error.message);
    result = confirmed(settled) ?? (knownDenial && settled.status !== 'submission_uncertain'
      ? { status: 'needs_attention', reason: 'submission_blocked' } : { status: 'submission_uncertain' });
  }
  await recordBatchResult(batch, item, result);
}

async function report(batch: Batch, reconcilePending = false) {
  const approval = await readBatchApproval(batch), stopped = await isBatchStopped(batch);
  const inactive = stopped ? 'stopped' : !approval ? 'awaiting_approval' : Date.now() >= approval.expiresAt ? 'expired' : null;
  const jobs = [];
  for (const item of batch.items) {
    let result = await readBatchResult(batch, item);
    if (reconcilePending && (result?.status === 'in_progress' || result?.status === 'submission_uncertain')) {
      result = confirmed(await reconcile(batch, item)) ?? { status: 'submission_uncertain' };
      await recordBatchResult(batch, item, result);
    }
    jobs.push({ runId: item.runId, ...submissionJob(item.jobId), ...(result ?? { status: inactive ?? 'pending' }) });
  }
  const settled = jobs.every(job => ['confirmed_submitted', 'needs_attention', 'submission_uncertain'].includes(job.status));
  const status = stopped ? 'stopped' : settled ? 'finished' : inactive ?? 'approved';
  return { batchId: batch.batchId, status, jobs };
}

export async function executeSubmissionBatch(batchId: string) {
  const batch = await readBatch(batchId);
  return batchLock(batch, async () => {
    if (!await readBatchApproval(batch) && !await isBatchStopped(batch)) {
      throw new ReplayError('synthetic batch approval is required');
    }
    for (const item of batch.items) await executeItem(batch, item);
    return report(batch);
  });
}

export async function submissionBatchStatus(batchId: string) {
  const batch = await readBatch(batchId);
  return batchLock(batch, () => report(batch, true));
}

export async function stopSubmissionBatch(batchId: string) {
  const batch = await readBatch(batchId);
  const current = await report(batch);
  if (current.status === 'finished') return current;
  await stopBatch(batch);
  return report(batch);
}
