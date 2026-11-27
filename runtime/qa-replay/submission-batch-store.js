import { randomBytes } from 'node:crypto';
import { lstat, mkdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { canonical, readJson, ReplayError, runIdentifier } from './contracts.js';
import { requireIsolatedPath, requirePrivateDirectory, revision, runsRoot, withQaLock } from './submission-boundary.js';
import { submissionJob } from './submission-jobs.js';
const batchIdentifier = /^qa-batch-[a-f0-9]{32}$/;
export const reviewRevisionPattern = /^sha256:[a-f0-9]{64}$/;
const receiptIdentifier = /^receipt:[a-f0-9]{64}$/;
export const batchApprovalDuration = 300_000;
async function present(path) {
    try {
        if (!(await lstat(path)).isFile())
            throw new ReplayError('invalid synthetic batch file');
        return true;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
}
async function writeJson(path, value) {
    const temporary = join(dirname(path), `.batch-${randomBytes(16).toString('hex')}.tmp`);
    try {
        await writeFile(temporary, canonical(value), { mode: 0o600, flag: 'wx', flush: true });
        await rename(temporary, path);
    }
    finally {
        await unlink(temporary).catch(() => { });
    }
}
function validateItems(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
        throw new ReplayError('select one to three reviewed synthetic jobs');
    }
    const runs = new Set(), jobs = new Set();
    for (const item of value) {
        if (!item || typeof item.runId !== 'string' || !runIdentifier.test(item.runId)
            || typeof item.reviewRevision !== 'string' || !reviewRevisionPattern.test(item.reviewRevision)
            || typeof item.jobId !== 'string' || Object.keys(item).length !== 3) {
            throw new ReplayError('invalid synthetic batch item');
        }
        const { jobId } = submissionJob(item.jobId);
        if (runs.has(item.runId) || jobs.has(jobId))
            throw new ReplayError('batch jobs and runs must be unique');
        runs.add(item.runId);
        jobs.add(jobId);
    }
    return value;
}
export async function createBatch(items) {
    validateItems(items);
    const batchId = `qa-batch-${randomBytes(16).toString('hex')}`;
    const root = join(await realpath(runsRoot()), batchId);
    await requireIsolatedPath(root);
    await mkdir(root, { mode: 0o700 });
    const manifest = { batchId, items };
    try {
        await writeJson(join(root, 'manifest.json'), manifest);
    }
    catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
    }
    return { ...manifest, root, batchRevision: revision(manifest) };
}
export async function readBatch(batchId, parent) {
    if (!batchIdentifier.test(batchId))
        throw new ReplayError('invalid synthetic batch identifier');
    const root = join(parent ?? await realpath(runsRoot()), batchId);
    await requirePrivateDirectory(root);
    await requireIsolatedPath(root);
    const value = await readJson(join(root, 'manifest.json'), 'invalid synthetic batch');
    if (value?.batchId !== batchId || Object.keys(value).length !== 2)
        throw new ReplayError('invalid synthetic batch');
    const manifest = { batchId, items: validateItems(value.items) };
    return { ...manifest, root, batchRevision: revision(manifest) };
}
export const isBatchStopped = (batch) => present(join(batch.root, 'stopped'));
export async function stopBatch(batch) {
    try {
        await writeFile(join(batch.root, 'stopped'), '', { flag: 'wx', mode: 0o600, flush: true });
    }
    catch (error) {
        if (error.code !== 'EEXIST' || !await isBatchStopped(batch))
            throw error;
    }
}
export async function readBatchApproval(batch) {
    const path = join(batch.root, 'approval.json');
    if (!await present(path))
        return null;
    const value = await readJson(path, 'invalid synthetic batch approval');
    if (value?.batchRevision !== batch.batchRevision || Object.keys(value).length !== 3
        || !Number.isSafeInteger(value.issuedAt) || value.issuedAt > Date.now()
        || value.expiresAt !== value.issuedAt + batchApprovalDuration) {
        throw new ReplayError('invalid synthetic batch approval');
    }
    return value;
}
export async function recordBatchApproval(batch) {
    if (await isBatchStopped(batch))
        throw new ReplayError('synthetic batch is stopped');
    const existing = await readBatchApproval(batch);
    if (existing) {
        if (Date.now() >= existing.expiresAt)
            throw new ReplayError('synthetic batch approval expired');
        return existing;
    }
    const issuedAt = Date.now();
    const approval = { batchRevision: batch.batchRevision, issuedAt, expiresAt: issuedAt + batchApprovalDuration };
    await writeJson(join(batch.root, 'approval.json'), approval);
    return approval;
}
export async function requireBatchPermission(batchId, runRoot, jobId, reviewRevision) {
    const batch = await readBatch(batchId, dirname(runRoot));
    const item = batch.items.find(candidate => candidate.runId === basename(runRoot));
    const approval = await readBatchApproval(batch);
    if (item?.jobId !== jobId || item.reviewRevision !== reviewRevision || !approval
        || (await readBatchResult(batch, item))?.status !== 'in_progress'
        || await isBatchStopped(batch) || Date.now() >= approval.expiresAt) {
        throw new ReplayError('synthetic batch permission is unavailable');
    }
}
export async function withBatchAction(batchId, runRoot, operation) {
    const batch = await readBatch(batchId, dirname(runRoot));
    return withQaLock(join(batch.root, '.batch-action.lock'), operation);
}
export const batchFormRevision = (batchId, reviewRevision) => revision({ batchId, reviewRevision });
const resultPath = (batch, item) => join(batch.root, `${item.runId}.json`);
export async function readBatchResult(batch, item) {
    const path = resultPath(batch, item);
    if (!await present(path))
        return null;
    const value = await readJson(path, 'invalid synthetic batch result');
    if (value?.status === 'confirmed_submitted' && Object.keys(value).length === 2 && receiptIdentifier.test(value.receiptId))
        return value;
    if (value?.status === 'needs_attention' && Object.keys(value).length === 2
        && ['review_changed', 'submission_blocked', 'run_unavailable'].includes(value.reason))
        return value;
    if ((value?.status === 'submission_uncertain' || value?.status === 'in_progress') && Object.keys(value).length === 1)
        return value;
    throw new ReplayError('invalid synthetic batch result');
}
export const recordBatchResult = (batch, item, result) => writeJson(resultPath(batch, item), result);
