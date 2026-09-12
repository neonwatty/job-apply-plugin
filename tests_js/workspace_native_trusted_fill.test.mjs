import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { plain, read, setup, snapshot, write } from './workspace_native_claims_support.mjs';
import { resolveAccountRealm } from '../runtime/contracts/workspace/account-realm.js';
import { fromJSON } from '../runtime/contracts/workspace/values.js';
import { TrustedFillService } from '../runtime/workspace-core/trusted-fill.js';
import { jobsHttp } from '../runtime/workspace-core/jobs-http.js';

const portal = suffix => `https://example.wd1.myworkdayjobs.com/en-US/careers/job/${suffix}`;
const fp = character => `sha256:${character.repeat(64)}`;

async function prepared(fixture, name) {
  const state = await setup(fixture, name), id = 'trusted-job';
  await state.jobs.create(fromJSON({ id, url: portal(name), role: 'Engineer', company: 'Synthetic', ats: 'workday', resumeId: 'resume' }));
  const selected = plain(await state.claims.select(id, 1n, true));
  const acquired = plain(await state.claims.acquire(id, fromJSON('Trusted Fill owner'), BigInt(selected.job.revision)));
  const realm = resolveAccountRealm(portal(name));
  assert.equal(realm.status, 'resolved');
  const packet = { jobId: id, expectedJobRevision: acquired.job.revision, realmRef: realm.realmRef, answerRefs: [],
    observedQuestionFingerprint: fp('1'), observedControlFingerprint: fp('2'), formFingerprint: fp('3'),
    allowedOperations: ['fill_text'], durationMinutes: 30 };
  const evaluation = { jobId: id, expectedApprovalRevision: 1, observedQuestionFingerprint: fp('1'),
    observedControlFingerprint: fp('2'), formFingerprint: fp('3'), fieldOperations: ['fill_text'],
    authenticationRequired: false, consentRequired: false, credentialFieldsPresent: false,
    finalControlsPresent: false, unseenQuestions: false, unseenControls: false };
  return { ...state, id, acquired, packet, evaluation };
}

test('native Trusted Fill is exact, one-shot, redacted, and converges denial', { timeout: 60_000 }, async t => {
  const fixture = await nativeFixture();
  t.after(() => fixture.cleanup());

  await t.test('approval binds canonical state and one successful evaluation consumes it', async () => {
    const state = await prepared(fixture, 'trusted-success');
    const answers = await read(state.root, 'answers.json');
    answers.answers['question.one'] = { key: 'question.one', question: 'Private question?', state: 'confirmed', value: 'PRIVATE-ANSWER',
      source: 'user', revision: 7, createdAt: state.clock.now, updatedAt: state.clock.now, deletedAt: null };
    await write(state.root, 'answers.json', answers); state.packet.answerRefs = ['question.one'];
    const service = new TrustedFillService(state.repository, () => state.clock.now);
    const approval = plain(await service.approve(fromJSON(state.packet)));
    assert.deepEqual({ status: approval.status, approvalRevision: approval.approvalRevision,
      allowedOperations: approval.allowedOperations }, { status: 'active', approvalRevision: 1, allowedOperations: ['fill_text'] });
    assert.doesNotMatch(JSON.stringify(approval), /PRIVATE|content_|nonce|approvalId|urlFingerprint/);
    assert.deepEqual((await read(state.root, 'trusted-fill.json')).approvals[state.id].answerBindings,
      [{ answerRef: 'question.one', questionRevision: 7, answerRevision: 7 }]);
    const decision = plain(await service.evaluate(fromJSON(state.evaluation)));
    assert.deepEqual({ authorized: decision.authorized, reasonCode: decision.reasonCode, attentionHandoff: decision.attentionHandoff,
      approvalRevision: decision.approvalRevision, consumedApprovalRevision: decision.consumedApprovalRevision },
    { authorized: true, reasonCode: 'authorized_non_final_fields', attentionHandoff: false,
      approvalRevision: 1, consumedApprovalRevision: 2 });
    assert.equal((await read(state.root, 'trusted-fill.json')).approvals[state.id].status, 'revoked');
    assert.equal((await read(state.root, 'coordinator.json')).claim.jobId, state.id);
    const replay = plain(await service.evaluate(fromJSON(state.evaluation)));
    assert.deepEqual({ authorized: replay.authorized, reasonCode: replay.reasonCode, attentionHandoff: replay.attentionHandoff },
      { authorized: false, reasonCode: 'approval_revision_mismatch', attentionHandoff: true });
    assert.equal(replay.job.status, 'needs_info');
    assert.equal((await read(state.root, 'coordinator.json')).claim, null);
  });

  await t.test('resume byte drift denies without retry and writes exact attention evidence', async () => {
    const state = await prepared(fixture, 'trusted-drift'), service = new TrustedFillService(state.repository, () => state.clock.now);
    await service.approve(fromJSON(state.packet));
    const resume = (await read(state.root, 'resumes.json')).resumes.resume;
    await writeFile(join(state.root, 'resume-files', resume.managedFile), 'CHANGED PRIVATE RESUME');
    const denied = plain(await service.evaluate(fromJSON(state.evaluation)));
    assert.deepEqual({ authorized: denied.authorized, reasonCode: denied.reasonCode, retryAllowed: denied.retryAllowed,
      attentionHandoff: denied.attentionHandoff }, { authorized: false, reasonCode: 'resume_content_changed', retryAllowed: false, attentionHandoff: true });
    const session = await read(state.root, `sessions/${state.id}.json`);
    assert.equal(session.step, 'trusted_fill_denied:resume_content_changed');
    assert.deepEqual(session.blockers, [{ type: 'browser_handoff', code: 'browser-state-uncertain' }]);
    assert.doesNotMatch(JSON.stringify(denied), /PRIVATE|claim_/);
  });

  await t.test('a replaced claim and final operation fail without extending authority', async () => {
    const state = await prepared(fixture, 'trusted-boundary'), service = new TrustedFillService(state.repository, () => state.clock.now);
    await service.approve(fromJSON(state.packet));
    const coordinator = await read(state.root, 'coordinator.json');
    coordinator.claim.claimId = '22222222-2222-4222-8222-222222222222';
    await write(state.root, 'coordinator.json', coordinator);
    const before = await snapshot(state.root), mismatch = plain(await service.evaluate(fromJSON(state.evaluation)));
    assert.deepEqual({ authorized: mismatch.authorized, reasonCode: mismatch.reasonCode, attentionHandoff: mismatch.attentionHandoff },
      { authorized: false, reasonCode: 'claim_binding_mismatch', attentionHandoff: false });
    assert.deepEqual(await snapshot(state.root), before);
    assert.throws(() => service.evaluate(fromJSON({ ...state.evaluation, fieldOperations: ['submit'] })), /final action/);
    assert.deepEqual(await snapshot(state.root), before);
  });

  await t.test('concurrent evaluation has one winner and burns replay authority', async () => {
    const state = await prepared(fixture, 'trusted-concurrent'), service = new TrustedFillService(state.repository, () => state.clock.now);
    await service.approve(fromJSON(state.packet));
    const results = (await Promise.all([
      service.evaluate(fromJSON(state.evaluation)), service.evaluate(fromJSON(state.evaluation)),
    ])).map(plain);
    assert.equal(results.filter(result => result.authorized).length, 1);
    assert.equal(results.filter(result => result.reasonCode === 'approval_revision_mismatch').length, 1);
    assert.equal((await read(state.root, 'trusted-fill.json')).approvals[state.id].approvalRevision, 2);
    assert.equal((await read(state.root, 'coordinator.json')).claim, null);
  });

  await t.test('all HTTP routes use public projections and exact revisions', async () => {
    const state = await prepared(fixture, 'trusted-http');
    const coordinator = await read(state.root, 'coordinator.json');
    coordinator.claim.expiresAt = '2099-01-01T00:00:00Z';
    await write(state.root, 'coordinator.json', coordinator);
    const call = async (method, path, body = '') => jobsHttp(state.jobs, state.repository, method, path,
      typeof body === 'string' ? body : JSON.stringify(body));
    const approved = await call('POST', '/api/trusted-fill/approve', state.packet);
    assert.equal(approved.status, 200, String(approved.body)); assert.equal(JSON.parse(approved.body).status, 'active');
    const loaded = await call('GET', `/api/trusted-fill/${state.id}`);
    assert.deepEqual(JSON.parse(loaded.body), JSON.parse(approved.body));
    const conflict = await call('POST', `/api/trusted-fill/${state.id}/revoke`, { expectedApprovalRevision: 2 });
    assert.equal(conflict.status, 409);
    const revoked = await call('POST', `/api/trusted-fill/${state.id}/revoke`, { expectedApprovalRevision: 1 });
    assert.equal(revoked.status, 200); assert.equal(JSON.parse(revoked.body).status, 'revoked');
    const missing = await call('GET', '/api/trusted-fill/missing-job');
    assert.deepEqual(JSON.parse(missing.body), { status: 'missing', approvalRevision: null });
  });
});
