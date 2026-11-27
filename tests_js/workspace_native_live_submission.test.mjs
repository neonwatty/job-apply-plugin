import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, plain, readyPacket, read } from './workspace_native_claims_support.mjs';
import { fromJSON, int, get, text } from '../runtime/contracts/workspace/values.js';
import { ApplicationRunsService } from '../runtime/workspace-core/application-runs.js';
import { ResumeFactsService } from '../runtime/workspace-core/resume-facts.js';
import { ResumeService } from '../runtime/workspace-core/resumes.js';
import { SessionService } from '../runtime/workspace-core/store-sessions.js';
import { TrashService } from '../runtime/workspace-core/trash.js';
import { ProfileService } from '../runtime/workspace-core/profile.js';
import { LiveSubmissionService } from '../runtime/workspace-core/live-submission.js';
import { NativeLiveSubmissionLedger } from '../runtime/store/native-live-submission-ledger.js';

const digest = character => 'sha256:' + character.repeat(64);

async function review(claims, id) {
  const selected = plain(await claims.select(id, 1n, true)).job;
  const { job, token } = plain(await claims.acquire(id, text('Synthetic owner'), BigInt(selected.revision)));
  const handoff = plain(await claims.handoff(id, text(token), 'awaiting_review', fromJSON({
    status: 'review', readinessInput: readyPacket(job.revision),
  }), BigInt(job.revision)));
  return { jobId: id, jobRevision: String(handoff.job.revision), reviewFingerprint: digest(id === 'job' ? 'a' : 'b') };
}

test('global submission preference governs exact approvals, one-use claims, and durable outcomes', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture();
  try {
    const { root, claims, repository, run: activeRun } = await setup(fixture, 'live-submission');
    const first = await review(claims, 'job'), second = await review(claims, 'other');
    const both = { jobs: [first, second] };
    const profile = new ProfileService(repository);
    const setMode = async (enabled, source = 'user') => profile.patch(fromJSON({
      applicationPreferences: { submitAfterApproval: enabled },
    }), int(get(await profile.inspect(), 'revision')), source);
    const ledger = new NativeLiveSubmissionLedger(root);
    let clock = Date.now();
    const makeService = () => new LiveSubmissionService(repository, ledger, () => clock);
    const service = makeService();
    assert.deepEqual(await service.status(), { enabled: false });
    await assert.rejects(service.preview(both), /is off/);
    await setMode(true, 'agent');
    assert.deepEqual(await service.status(), { enabled: false });
    const adopted = await setMode(true);
    assert.equal(plain(adopted).factProvenance['/applicationPreferences/submitAfterApproval'].source, 'user');
    assert.equal(plain(await setMode(true)).revision, plain(adopted).revision);
    assert.deepEqual(await service.status(), { enabled: true });
    await assert.rejects(service.claim('a'.repeat(64), first), /approval expired/);

    const initial = await service.preview(both);
    await assert.rejects(service.preview({ jobs: [second, first] }, initial.previewId), /preview changed/);
    const inputFile = join(fixture.root, 'selection.json');
    await writeFile(inputFile, JSON.stringify(both), { mode: 0o600 });
    const command = ['apps/companion/command.mjs', 'submission', '--root', root];
    const run = promisify(execFile);
    const { stdout } = await run(process.execPath, [...command, 'preview', '--input', inputFile]);
    assert.equal(JSON.parse(stdout).previewId, initial.previewId);
    await assert.rejects(run(process.execPath, [...command, 'approve', '--input', inputFile, '--preview', initial.previewId]),
      /invalid submission command arguments/);
    const expired = await service.preview(both, initial.previewId);
    clock += 300_000;
    await assert.rejects(service.claim(expired.approvalId, first), /approval expired/);
    const nearingExpiry = await service.preview(both, initial.previewId);
    const expiry = Date.parse(nearingExpiry.expiresAt);
    clock = expiry - 1;
    const lateValidation = new LiveSubmissionService(repository, {
      read: async key => {
        if (key.startsWith('job-')) clock = expiry;
        return ledger.read(key);
      },
      write: (key, record) => ledger.write(key, record),
    }, () => clock);
    await assert.rejects(lateValidation.claim(nearingExpiry.approvalId, first), /approval expired/);
    assert.deepEqual(await service.inspect(first.jobId), { status: 'no_agent_attempt' });
    clock = expiry - 1;
    const lateWrite = new LiveSubmissionService(repository, {
      read: key => ledger.read(key),
      write: async (key, record) => {
        await ledger.write(key, record);
        clock = expiry;
      },
    }, () => clock);
    await assert.rejects(lateWrite.claim(nearingExpiry.approvalId, first), /expired before the attempt/);
    assert.deepEqual(await service.inspect(first.jobId), { status: 'no_agent_attempt' });
    const approval = await service.preview(both, initial.previewId);
    await setMode(false);
    await assert.rejects(service.claim(approval.approvalId, first), /is off/);
    await setMode(true);
    await assert.rejects(service.claim(approval.approvalId, first), /saved setting changed/);

    const next = await service.preview(both);
    const exact = await service.preview(both, next.previewId);
    await assert.rejects(service.claim(exact.approvalId, { ...first, reviewFingerprint: digest('c') }), /changed after approval/);
    const contenders = await Promise.allSettled([service.claim(exact.approvalId, first), makeService().claim(exact.approvalId, first)]);
    const won = contenders.filter(result => result.status === 'fulfilled');
    assert.equal(won.length, 1);
    await assert.rejects(service.claim(exact.approvalId, second), /previous application outcome/);
    assert.deepEqual(await makeService().inspect(first.jobId), { status: 'verify_submission_status' });
    await service.outcome({ jobId: first.jobId, claimId: won[0].value.claimId, status: 'uncertain', confirmation: null });
    await assert.rejects(service.claim(exact.approvalId, first), /verify submission status/);
    const secondClaim = await service.claim(exact.approvalId, second);
    assert.equal(secondClaim.status, 'claimed');
    const outcome = { jobId: second.jobId, claimId: secondClaim.claimId, status: 'confirmed', confirmation: digest('d') };
    const receipt = await service.outcome(outcome);
    assert.deepEqual(await makeService().outcome(outcome), receipt);
    assert.deepEqual(await makeService().outcome({ ...outcome, status: 'uncertain', confirmation: null }), receipt);
    await assert.rejects(makeService().outcome({ ...outcome, confirmation: digest('e') }), /receipt cannot change/);
    assert.deepEqual(await makeService().inspect(second.jobId), receipt);
    assert.equal(receipt.evidence, 'agent_observed_portal_confirmation');
    assert.equal(receipt.storeUpdated, true);
    const { jobs } = await read(root, 'jobs.json');
    assert.equal(jobs.job.status, 'awaiting_review');
    assert.equal(jobs.other.status, 'applied');
    await new ApplicationRunsService(repository).complete(activeRun.runId, BigInt(activeRun.revision));
    const trash = new TrashService(repository);
    const trashed = await trash.trashJob(second.jobId, BigInt(jobs.other.revision));
    const detachedReceipt = { ...receipt, storeUpdated: false };
    assert.deepEqual(await service.inspect(second.jobId), detachedReceipt);
    await new SessionService(repository).delete(second.jobId);
    await trash.deleteJob(second.jobId, int(get(trashed, 'revision')));
    assert.deepEqual(await makeService().outcome(outcome), detachedReceipt);
    assert.deepEqual(await makeService().inspect(second.jobId), detachedReceipt);
    assert.doesNotMatch(await readFile(join(root, 'live-submissions.json'), 'utf8'), /PRIVATE|example\.invalid/);
  } finally { await fixture.cleanup(); }
});


test('a different managed résumé cannot authorize an unchanged review handoff', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture();
  try {
    const { root, claims, repository, run } = await setup(fixture, 'reviewed-inputs');
    const first = await review(claims, 'job');
    const profile = new ProfileService(repository);
    await profile.patch(fromJSON({ applicationPreferences: { submitAfterApproval: true } }),
      int(get(await profile.inspect(), 'revision')), 'user');
    const service = new LiveSubmissionService(repository, new NativeLiveSubmissionLedger(root));
    assert.equal((await service.preview({ jobs: [first] })).status, 'awaiting_approval');
    const runs = new ApplicationRunsService(repository);
    await runs.complete(run.runId, BigInt(run.revision));
    const resume = plain(await new ResumeService(repository).import(
      fromJSON({ id: 'different-resume', label: 'Different résumé' }), 'resume.txt', Buffer.from('different content')));
    const facts = new ResumeFactsService(repository);
    const draft = plain(await facts.createDraft(resume.id, fromJSON({ name: 'Synthetic Owner' }), BigInt(resume.revision), null));
    const confirmed = plain(await facts.confirm(resume.id, BigInt(draft.revision), draft.contentRevision));
    await runs.start(resume.id, BigInt(resume.revision), BigInt(confirmed.revision), true, fromJSON({ jobIds: ['job'] }));
    await assert.rejects(service.preview({ jobs: [first] }), /reviewed résumé or confirmed facts/);
  } finally { await fixture.cleanup(); }
});
