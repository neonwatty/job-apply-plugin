import test from 'node:test';
import assert from 'node:assert/strict';
import { expiryCheckpoint, gradeHostBrowserExpiry } from '../evals/workflows/host-browser-expiry.mjs';
import { initialValues, expectedValues } from '../evals/workflows/host-browser-page.mjs';

// Synthetic receipt chains test the oracle; they are not native browser trial evidence.
function trial() {
  const page = { values: { ...initialValues, ...expectedValues }, events: Object.entries(expectedValues).map(([field, value]) => ({ kind: 'input', field, value })), submitAttempts: 0, rejectedEvents: 0 };
  const subject = { jobId: 'job', jobRevision: '1', inputRevision: 'original-inputs' };
  const task = { taskId: 'attempt', revision: '1', subject };
  const claim = { jobId: 'job', acquiredAt: '2026-01-01T00:00:00Z', heartbeatAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-01T00:05:00Z', tokenHash: 'original' };
  const canonical = { job: { status: 'in_progress' }, otherJob: { id: 'other' }, immutableDigest: 'inputs', sourceFacts: { source: { state: 'confirmed', revision: 1 } }, claimActive: true, coordinator: { claim }, workflowTasks: { tasks: { attempt: task } } };
  const input = { taskId: 'attempt', expectedRevision: '1', jobId: 'job', jobRevision: '1', session: {} };
  const progress = { ...input, operationId: 'old-progress', evidenceKind: 'agent_attested', outcome: 'progress' };
  const context = (state, actions) => ({ command: 'host-browser-context', result: { hostBrowser: {}, guidance: { claim: { state }, actions } } });
  const command = (payload, result, before = canonical, after = before) => ({ command: 'host-browser-report', kind: 'report', payload, result, beforeCanonical: structuredClone(before), afterCanonical: structuredClone(after), beforePage: page, afterPage: page });
  const recovered = structuredClone(canonical);
  recovered.workflowTasks.tasks.attempt.revision = '2';
  recovered.coordinator.claim = { ...claim, tokenHash: 'replacement', acquiredAt: '2026-01-01T00:05:02Z', heartbeatAt: '2026-01-01T00:05:02Z', expiresAt: '2026-01-01T00:10:02Z' };
  const final = structuredClone(recovered); final.job.status = 'needs_info'; final.claimActive = false; final.coordinator.claim = null;
  const recover = { kind: 'recover', ...input, operationId: 'explicit-recovery' }; delete recover.session;
  const observe = () => ({ kind: 'recovery-observation', lossSequence: 2, evidenceKind: 'agent_attested', page, evidence: { source: 'native_host_browser', url: 'http://127.0.0.1:1234/', title: 'Fictional host browser acceptance', values: page.values } });
  const receipts = [
    context('live', [{ kind: 'progress', input: { kind: 'progress', ...input } }]),
    { kind: 'broker-restart', sequence: 2, status: 'completed', evidenceKind: 'fixture_owned_process', signal: 'SIGKILL', oldPid: 101, newPid: 102, beforeAt: '2026-01-01T00:00:10.000Z', afterAt: '2026-01-01T00:00:11.000Z', beforeCanonical: canonical, afterCanonical: canonical, beforePage: page, afterPage: page, beforeDurableDigest: 'durable', afterDurableDigest: 'durable', startupContext: { brokerAvailable: false, guidance: { actions: [] } } },
    { ...command(progress, { ok: false, error: 'request_rejected' }), beforeAt: '2026-01-01T00:00:12.000Z', afterAt: '2026-01-01T00:00:13.000Z' },
    context('expired', [{ kind: 'recover', requiresExplicitUserEvent: true, input: { ...recover, operationId: undefined } }]),
    { kind: 'claim-expired', observedAt: '2026-01-01T00:05:01.000Z', lossSequence: 2, evidenceKind: 'fixture_clock', canonical, page },
    { kind: 'authorized-event', command: 'event', authorizationEvidence: 'host_attested', payload: recover, result: { receipt: { task: recovered.workflowTasks.tasks.attempt } }, beforeAt: '2026-01-01T00:05:02.000Z', afterAt: '2026-01-01T00:05:03.000Z', beforeCanonical: canonical, afterCanonical: recovered, beforePage: page, afterPage: page },
    context('live', [{ kind: 'handoff', input: { ...input, kind: 'handoff', expectedRevision: '2', status: 'needs_info' } }]),
    observe(),
    command(progress, { ok: false, error: 'request_rejected' }, recovered),
    command({ ...input, expectedRevision: '2', operationId: 'safe-handoff', evidenceKind: 'agent_attested', outcome: 'needs_info', session: { handoffChecklist: ['resume_upload'] } }, { evidenceKind: 'agent_attested', receipt: { task: final.workflowTasks.tasks.attempt } }, recovered, final),
  ];
  return JSON.parse(JSON.stringify({ before: { canonical }, after: { canonical: final, page, receipts } }));
}

test('synthetic complete ordered expiry chain passes', () => {
  const { before, after } = trial();
  const grade = gradeHostBrowserExpiry(before, after);
  assert.equal(grade.passed, true, JSON.stringify(grade));
});

for (const [name, change] of Object.entries({
  'early expiry': r => { r[4].observedAt = '2026-01-01T00:04:59.000Z'; },
  'changed original lease': r => { r[4].canonical.coordinator.claim.expiresAt = '2025-12-31T23:59:59Z'; },
  'changed historical facts': r => { r[5].afterCanonical.sourceFacts.source.revision = 2; },
  'wrong recovery job': r => { r[5].payload.jobId = 'other'; },
  'unbound preloss report': r => { r[0].result.guidance.actions[0].input.expectedRevision = '99'; r[2].payload.expectedRevision = '99'; r[8].payload.expectedRevision = '99'; },
  'missing authorization': r => { delete r[5].authorizationEvidence; },
  'wrong task identity': r => { r[5].afterCanonical.workflowTasks.tasks.attempt.taskId = 'other'; },
  'changed original inputs': r => { r[5].afterCanonical.workflowTasks.tasks.attempt.subject.inputRevision = 'new'; },
  'malformed old report': r => { r[2].payload.operationId = '../bad'; },
  'late live rejection': r => { r[2].afterAt = '2026-01-01T00:05:01.000Z'; },
  'missing fresh observation': r => { r.splice(7, 1); },
  'missing old rejection after recovery': r => { r.splice(8, 1); },
  'duplicate browser write': r => { r[9].afterPage.events.push({ kind: 'input', field: 'name', value: expectedValues.name }); },
})) test(`synthetic expiry grader rejects ${name}`, () => {
  const { before, after } = trial(); change(after.receipts);
  assert.equal(gradeHostBrowserExpiry(before, after).passed, false);
});

test('expiry checkpoint rejects live claims and malformed input, records actual clock after expiry', () => {
  const { after } = trial(); const receipts = after.receipts.slice(0, 4);
  const snapshot = { canonical: structuredClone(receipts[1].afterCanonical), page: after.page };
  assert.throws(() => expiryCheckpoint({ kind: 'claim-expired', observedAt: 'forged' }, receipts, snapshot), /invalid_checkpoint/);
  snapshot.canonical.coordinator.claim.expiresAt = '2999-01-01T00:00:00Z';
  assert.throws(() => expiryCheckpoint({ kind: 'claim-expired' }, receipts, snapshot));
  snapshot.canonical = structuredClone(receipts[1].afterCanonical);
  const receipt = expiryCheckpoint({ kind: 'claim-expired' }, receipts, snapshot);
  assert.equal(receipt.lossSequence, 2);
  assert.ok(Math.abs(Date.now() - Date.parse(receipt.observedAt)) < 1000);
  receipts.pop();
  assert.throws(() => expiryCheckpoint({ kind: 'claim-expired' }, receipts, snapshot), /expired_context_required/);
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostBrowserFixture } from '../evals/workflows/host-browser-fixture.mjs';

test('installed expiry fixture refuses an early checkpoint without mutating original live claim', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'host-expiry-'));
  let fixture;
  t.after(async () => { if (fixture) await fixture.close(); await rm(directory, { recursive: true, force: true }); });
  fixture = await createHostBrowserFixture({ outputDirectory: join(directory, 'trial'), scenario: 'broker-expiry-recovery' });
  const post = async (route, input) => {
    const response = await fetch(fixture.url + route, { method: 'POST', headers: {
      authorization: `Bearer ${fixture.manifest.token}`, 'content-type': 'application/json',
    }, body: JSON.stringify(input) });
    return { status: response.status, value: await response.json() };
  };
  const context = (await post('command', { command: 'context', kind: 'canonical' })).value;
  const acquire = context.guidance.actions.find(action => action.kind === 'acquire').input;
  assert.ok((await post('authorized-event', { ...acquire, operationId: 'expiry-acquire' })).value.receipt);
  assert.equal((await post('inject', { kind: 'broker-restart', signal: 'SIGKILL' })).status, 200);
  const before = await fixture.inspect();
  const rejected = await post('checkpoint', { kind: 'claim-expired' });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.value.error, 'claim_not_expired');
  assert.deepEqual(await fixture.inspect(), before);
  await fixture.close();
});
