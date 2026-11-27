import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, plain, readyPacket, read, write } from './workspace_native_claims_support.mjs';
import { fromJSON, int, get, text } from '../runtime/contracts/workspace/values.js';
import { ApplicationRunsService } from '../runtime/workspace-core/application-runs.js';
import { ResumeFactsService } from '../runtime/workspace-core/resume-facts.js';
import { ResumeService } from '../runtime/workspace-core/resumes.js';
import { SessionService } from '../runtime/workspace-core/store-sessions.js';
import { TrashService } from '../runtime/workspace-core/trash.js';
import { ProfileService } from '../runtime/workspace-core/profile.js';
import { JobsService } from '../runtime/workspace-core/jobs.js';
import { JobTransitionsService } from '../runtime/workspace-core/job-transitions.js';
import { WorkspaceProjectionsService } from '../runtime/workspace-core/workspace-projections.js';
import { LiveSubmissionService, liveSubmissionJobKey } from '../runtime/workspace-core/live-submission.js';
import { NativeLiveSubmissionLedger } from '../runtime/store/native-live-submission-ledger.js';
import { prepareCanonicalStoreClone } from '../runtime/store/native-store-clone.js';
import { activateNativeWriter } from '../runtime/store/native-writer-switch.js';

const digest = character => 'sha256:' + character.repeat(64);

async function review(claims, id) {
  const selected = plain(await claims.select(id, 1n, true)).job;
  const { job, token } = plain(await claims.acquire(id, text('Synthetic owner'), BigInt(selected.revision)));
  const handoff = plain(await claims.handoff(id, text(token), 'awaiting_review', fromJSON({
    status: 'review', readinessInput: readyPacket(job.revision),
  }), BigInt(job.revision)));
  return { jobId: id, jobRevision: String(handoff.job.revision) };
}

const observation = (id, phone = 'PRIVATE-PHONE') => ({
  complete: true, destination: `https://example.invalid/${id}`, jobIdentity: 'Synthetic Engineer',
  finalControl: { id: 'submit', label: 'Submit application', enabled: true },
  controls: [{ id: 'phone', kind: 'text', value: phone }, { id: 'attachment', kind: 'file', value: ['synthetic.txt'] },
    { id: 'optional', kind: 'text', value: '' }],
});
const bindBrowser = async (service, item, form = observation(item.jobId)) => ({
  ...item, ...await service.fingerprint({ ...item, observation: form }),
});
async function enable(repository) {
  const profile = new ProfileService(repository);
  return profile.patch(fromJSON({ applicationPreferences: { submitAfterApproval: true } }),
    int(get(await profile.inspect(), 'revision')), 'user');
}

test('global submission preference governs exact approvals, one-use claims, and durable outcomes', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture();
  try {
    const { root, claims, repository, run: activeRun } = await setup(fixture, 'live-submission');
    const beforeFirst = await review(claims, 'job'), beforeSecond = await review(claims, 'other');
    const profile = new ProfileService(repository);
    const setMode = async (enabled, source = 'user') => profile.patch(fromJSON({
      applicationPreferences: { submitAfterApproval: enabled },
    }), int(get(await profile.inspect(), 'revision')), source);
    const ledger = new NativeLiveSubmissionLedger(root);
    const projections = new WorkspaceProjectionsService(repository);
    let clock = Date.now();
    const makeService = () => new LiveSubmissionService(repository, ledger, () => clock);
    const service = makeService();
    assert.deepEqual(await service.status(), { enabled: false });
    await assert.rejects(bindBrowser(service, beforeFirst), /is off/);
    await setMode(true, 'agent');
    assert.deepEqual(await service.status(), { enabled: false });
    const adopted = await setMode(true);
    assert.equal(plain(adopted).factProvenance['/applicationPreferences/submitAfterApproval'].source, 'user');
    assert.equal(plain(await setMode(true)).revision, plain(adopted).revision);
    assert.deepEqual(await service.status(), { enabled: true });
    const first = await bindBrowser(service, beforeFirst), second = await bindBrowser(service, beforeSecond);
    const both = { jobs: [first, second] };
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
    const changed = await bindBrowser(service, beforeFirst, observation(first.jobId, 'PRIVATE-EDITED-PHONE'));
    await assert.rejects(service.claim(exact.approvalId, changed), /changed after approval/);
    const contenders = await Promise.allSettled([service.claim(exact.approvalId, first), makeService().claim(exact.approvalId, first)]);
    const won = contenders.filter(result => result.status === 'fulfilled');
    assert.equal(won.length, 1);
    await assert.rejects(service.claim(exact.approvalId, second), /previous application outcome/);
    assert.deepEqual(await makeService().inspect(first.jobId), { status: 'verify_submission_status' });
    assert.deepEqual(plain(await projections.activity(first.jobId)).submission, { status: 'verify_submission_status' });
    assert.equal(plain(await projections.activity(first.jobId)).submitAfterApproval, true);
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
    assert.deepEqual(plain(await projections.activity(second.jobId)).submission, receipt);
    const snapshot = plain(await projections.taskSnapshot());
    assert.deepEqual(snapshot.attention.items.map(({jobId, reasonCode}) => [jobId, reasonCode]),
      [[first.jobId, 'verify_submission_status']]);
    assert.equal(snapshot.overview.counts.attentionJobs, 1);
    const visible = JSON.stringify([snapshot, plain(await projections.activity(second.jobId))]);
    for (const secret of [exact.approvalId, secondClaim.claimId, outcome.confirmation]) {
      assert.equal(visible.includes(secret), false);
    }
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
    const reviewed = await review(claims, 'job');
    await enable(repository);
    const service = new LiveSubmissionService(repository, new NativeLiveSubmissionLedger(root));
    const first = await bindBrowser(service, reviewed);
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

test('a confirmed receipt survives a concurrent job edit and can be reconciled at the new revision', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture();
  try {
    const { root, claims, repository } = await setup(fixture, 'reconcile-receipt');
    const reviewed = await review(claims, 'job');
    await enable(repository);
    const service = new LiveSubmissionService(repository, new NativeLiveSubmissionLedger(root));
    const item = await bindBrowser(service, reviewed);
    const selection = { jobs: [item] };
    const { previewId } = await service.preview(selection);
    const { approvalId } = await service.preview(selection, previewId);
    const { claimId } = await service.claim(approvalId, item);
    const edited = plain(await new JobsService(repository).update(item.jobId,
      fromJSON({ notes: 'Concurrent owner edit' }), BigInt(item.jobRevision)));
    const receipt = await service.outcome({ jobId: item.jobId, claimId, status: 'confirmed', confirmation: digest('e') });
    assert.equal(receipt.storeUpdated, false);
    const projections = new WorkspaceProjectionsService(repository);
    assert.deepEqual(plain(await projections.activity(item.jobId)).submission, receipt);
    assert.equal(plain(await projections.attention()).items.find(row => row.jobId === item.jobId).reasonCode,
      'reconcile_submission_receipt');
    const transitions = new JobTransitionsService(repository);
    await assert.rejects(transitions.transition(item.jobId, 'applied', BigInt(item.jobRevision), null, true), /revision conflict/);
    await assert.rejects(transitions.transition(item.jobId, 'applied', BigInt(edited.revision)), /explicit user confirmation/);
    const applied = plain(await transitions.transition(item.jobId, 'applied', BigInt(edited.revision), null, true));
    assert.equal(applied.notes, edited.notes);
    assert.deepEqual(plain(await projections.activity(item.jobId)).submission, { ...receipt, storeUpdated: true });
    assert.equal(plain(await projections.attention()).items.some(row => row.jobId === item.jobId), false);
  } finally { await fixture.cleanup(); }
});

test('exact browser observations are stable across processes and deny masked or unsigned submissions', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture();
  try {
    const { root, claims, repository } = await setup(fixture, 'private-fingerprint');
    const item = await review(claims, 'job'), other = await review(claims, 'other');
    await enable(repository);
    const service = new LiveSubmissionService(repository, new NativeLiveSubmissionLedger(root));
    const form = observation(item.jobId);
    const bound = await bindBrowser(service, item, form);
    const file = join(fixture.root, 'observation.json');
    await writeFile(file, JSON.stringify({ ...item, observation: { ...form, controls: form.controls.toReversed() } }), { mode: 0o600 });
    const args = ['apps/companion/command.mjs', 'submission', '--root', root, 'fingerprint', '--input', file];
    const { stdout } = await promisify(execFile)(process.execPath, args);
    assert.deepEqual(JSON.parse(stdout), { reviewFingerprint: bound.reviewFingerprint });
    assert.doesNotMatch(stdout, /PRIVATE|synthetic\.txt/);
    assert.throws(() => service.preview({ jobs: [{ ...item, reviewFingerprint: digest('c') }] }), /private browser review fingerprint/);
    await assert.rejects(service.preview({ jobs: [{ ...other, reviewFingerprint: bound.reviewFingerprint }] }), /does not match this job/);
    assert.throws(() => service.fingerprint({ ...item, observation: observation(item.jobId, '<redacted>') }), /exact observed form values/);
    assert.throws(() => service.fingerprint({ ...item, observation: { ...form, complete: false } }), /exact observed form values/);
    const preview = await service.preview({ jobs: [bound] });
    const approval = await service.preview({ jobs: [bound] }, preview.previewId);
    const oneDigitChanged = await bindBrowser(service, item, observation(item.jobId, 'PRIVATE-PHONE2'));
    await assert.rejects(service.claim(approval.approvalId, oneDigitChanged), /changed after approval/);
    assert.deepEqual(await service.inspect(item.jobId), { status: 'no_agent_attempt' });
    assert.doesNotMatch(await readFile(join(root, 'live-submissions.json'), 'utf8'), /PRIVATE|synthetic\.txt/);
  } finally { await fixture.cleanup(); }
});

test('an upgrade preserves preview collection state and reconciles only the exact confirmed receipt', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture();
  try {
    const source = await setup(fixture, 'trial-origin');
    const destination = await setup(fixture, 'collection-origin');
    await write(destination.root, 'collection.json', { schemaVersion: 1, revision: 9, sources: { fictional: {} } });
    await write(destination.root, 'collection-journal.json', { schemaVersion: 1, operation: { staged: true } });
    const clone = `${destination.root}.native-candidate`;
    await assert.rejects(destination.jobs.get('job'), /pending collection operation/);
    await unlink(join(destination.root, '.native-jobs-fixture'));
    await unlink(join(destination.root, 'resume-operation.json'));
    await assert.rejects(prepareCanonicalStoreClone(destination.root, clone, destination.provider), /pending collection operation/);
    await write(destination.root, 'collection-journal.json', { schemaVersion: 1, operation: null });
    await prepareCanonicalStoreClone(destination.root, clone, destination.provider);
    const artifacts = ['collection.json', 'collection-journal.json'];
    const bytes = await Promise.all(artifacts.map(name => readFile(join(destination.root, name))));
    await activateNativeWriter(destination.root, clone, { provider: destination.provider });
    const sourceService = new LiveSubmissionService(source.repository, new NativeLiveSubmissionLedger(source.root));
    await enable(source.repository);
    const item = await bindBrowser(sourceService, await review(source.claims, 'job'));
    const selection = { jobs: [item] };
    const { previewId } = await sourceService.preview(selection);
    const { approvalId } = await sourceService.preview(selection, previewId);
    const { claimId } = await sourceService.claim(approvalId, item);
    await sourceService.outcome({ jobId: item.jobId, claimId, status: 'uncertain', confirmation: null });
    const exe = promisify(execFile);
    const args = ['apps/companion/command.mjs', 'submission', '--root', destination.root, 'reconcile',
      '--source-root', source.root, '--id', item.jobId, '--expected-revision', '1'];
    await assert.rejects(exe(process.execPath, args), /invalid submission command arguments/);
    await assert.rejects(exe(process.execPath, [...args, '--owner-confirmed']), /source has no confirmed submission/);
    assert.equal((await read(destination.root, 'jobs.json')).jobs.job.status, 'saved');
    const receipt = await sourceService.outcome({ jobId: item.jobId, claimId, status: 'confirmed', confirmation: digest('d') });
    const staleArgs = args.with(args.indexOf('--expected-revision') + 1, '2');
    await assert.rejects(exe(process.execPath, [...staleArgs, '--owner-confirmed']), /destination job revision conflict/);
    const otherPosting = await setup(fixture, 'different-posting');
    await otherPosting.jobs.update(item.jobId, fromJSON({ url: 'https://example.invalid/different-job' }), 1n);
    const otherArgs = staleArgs.with(args.indexOf('--root') + 1, otherPosting.root);
    await assert.rejects(exe(process.execPath, [...otherArgs, '--owner-confirmed']), /destination posting does not match/);
    assert.equal((await read(otherPosting.root, 'jobs.json')).jobs.job.status, 'saved');

    // A receipt created before postings were bound can still transfer at its exact applied revision.
    const originLedger = new NativeLiveSubmissionLedger(source.root);
    const key = liveSubmissionJobKey(item.jobId);
    await source.repository.claimTransaction(async () => {
      const { targetFingerprint, ...legacy } = await originLedger.read(key);
      assert.ok(targetFingerprint);
      await originLedger.write(key, legacy);
    });
    const result = await exe(process.execPath, [...args, '--owner-confirmed']);
    assert.deepEqual(JSON.parse(result.stdout), receipt);
    assert.deepEqual(JSON.parse((await exe(process.execPath, [...args, '--owner-confirmed'])).stdout), receipt);
    const activity = await exe(process.execPath, ['apps/companion/command.mjs', 'task', '--root', destination.root, 'activity', '--id', item.jobId]);
    assert.deepEqual(JSON.parse(activity.stdout).activity.submission, receipt);
    assert.equal(JSON.parse(activity.stdout).activity.job.status, 'applied');
    assert.deepEqual(await Promise.all(artifacts.map(name => readFile(join(destination.root, name)))), bytes);
    assert.doesNotMatch(await readFile(join(destination.root, 'live-submissions.json'), 'utf8'), new RegExp(claimId));
    await source.jobs.update(item.jobId, fromJSON({ notes: 'Edited after submission' }), BigInt(item.jobRevision) + 1n);
    await assert.rejects(exe(process.execPath, [...args, '--owner-confirmed']), /source posting cannot be verified/);
  } finally { await fixture.cleanup(); }
});
