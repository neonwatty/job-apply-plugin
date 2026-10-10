import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { NativeBrowserOperations } from '../runtime/store/native-browser-operations.js';
import { DurableBrowserBoundary } from '../runtime/integrations/browser/durable-boundary.js';
import { SyntheticBrowserAdapter } from '../runtime/integrations/browser/synthetic.js';
import { controlFingerprint, requestFingerprint } from '../runtime/integrations/browser/contract.js';
import { ApplicationAuthorityService } from '../runtime/workspace-core/application-authority.js';
import { applicationAuthorityInterrupts } from '../runtime/contracts/workspace/application-authority.js';
import { fromJSON, get, text } from '../runtime/contracts/workspace/values.js';
import { setup, extractAndStartRun, prepareJob, assertUnrelatedPreserved, archivePressure,
  plain, read, snapshot, unchanged } from './workspace_combined_workflows_support.mjs';

function synthetic() {
  const controls = [{ id: 'contact.name', kind: 'fill', state: 'empty' },
    { id: 'resume.file', kind: 'upload', state: 'empty' }, { id: 'submit', kind: 'final', state: 'empty' }];
  const observation = { evidenceKind: 'synthetic_adapter', observationRevision: '1', finalAction: 'untouched',
    controls, form: { documentId: 'combined-document', formId: 'combined-form', origin: 'https://example.invalid',
      controlSetFingerprint: controlFingerprint(controls) } };
  return new SyntheticBrowserAdapter(observation, new Map([['profile.name', 'PRIVATE SYNTHETIC VALUE']]));
}

test('native authority, archive and durable browser uncertainty compose without a repeated write', { timeout: 90000 }, async () => {
  const fixture = await nativeFixture();
  try {
    const state = await setup(fixture, 'combined-browser');
    await extractAndStartRun(state);
    await prepareJob(state);
    await archivePressure(state, 'extract-start');
    await prepareJob(state, 'other');
    const archive = (await read(state.root, 'jobs.json')).metadata.agentWorkflows.archive;
    assert.equal(archive.segments.length, 1);
    const authority = new ApplicationAuthorityService(state.repository, () => state.clock.now);
    const grant = plain(await authority.set(fromJSON({ mode: 'autofill_to_review', runId: state.run.runId,
      jobIds: ['job'], sensitiveAnswerRefs: [], durationMinutes: 60 }), 0n));
    // The fixture host holds the capability privately; no browser proposal or receipt carries it.
    const acquired = await state.claims.acquire('job', text('Synthetic combined host'), 2n);
    const token = get(acquired, 'token');
    const binding = { taskId: 'fixture-host-task', taskRevision: '1', jobId: 'job', attemptRevision: '3',
      authorizationRevision: String(grant.revision) };
    const hostAuthority = { check: async request => {
      const decision = plain(await authority.evaluate(fromJSON({ jobId: request.scope.jobId, claimToken: plain(token),
        destinationUrl: request.scope.form.origin,
        operations: [request.kind === 'fill' ? 'fill_canonical_profile' : 'upload_managed_resume'],
        answerRefs: [], sensitiveAnswerRefs: [],
        interrupts: Object.fromEntries([...applicationAuthorityInterrupts.keys()].map(key => [key, false])) })));
      return { authorized: decision.authorized && String(decision.revision) === request.scope.authorizationRevision,
        requestFingerprint: requestFingerprint(request) };
    } };
    const external = synthetic();
    const losesResponse = { evidenceKind: 'synthetic_adapter', observe: () => external.observe(),
      readback: request => external.readback(request), mutate: async request => {
        await external.mutate(request);
        throw Error('synthetic response lost after write');
      } };
    const boundary = new DurableBrowserBoundary(losesResponse, hostAuthority, binding, new NativeBrowserOperations(state.repository));
    const observed = await boundary.observe();
    const request = { operationId: 'combined-browser-fill', scope: { ...binding, form: observed.form,
      observationRevision: observed.observationRevision }, kind: 'fill', controlId: 'contact.name', valueRef: 'profile.name' };
    assert.equal((await boundary.execute(request)).status, 'uncertain');
    assert.equal(external.calls.writes, 1);
    assert.equal((await read(state.root, 'jobs.json')).metadata.durableBrowserOperations.operations[request.operationId].state, 'uncertain');
    const restarted = new DurableBrowserBoundary(external, hostAuthority, binding, new NativeBrowserOperations(state.repository));
    const fresh = await restarted.observe();
    await unchanged(state, () => restarted.execute({ ...request, operationId: 'blind-new-id',
      scope: { ...request.scope, observationRevision: fresh.observationRevision } }), /reconciliation_required/);
    assert.equal(external.calls.writes, 1);
    const verified = await restarted.reconcile(request.operationId);
    assert.equal(verified.status, 'verified');
    assert.equal(external.calls.writes, 1);
    const before = await snapshot(state.root), calls = external.calls;
    assert.deepEqual(JSON.parse(JSON.stringify(await restarted.execute(request))), verified);
    assert.deepEqual(await snapshot(state.root), before);
    assert.deepEqual(external.calls, calls);
    await unchanged(state, () => restarted.execute({ ...request, valueRef: 'other.value' }), /operation_conflict/);
    const document = await read(state.root, 'jobs.json');
    assert.deepEqual(document.metadata.agentWorkflows.archive, archive);
    assert.doesNotMatch(JSON.stringify(document.metadata.durableBrowserOperations), /PRIVATE|claim_[A-Za-z0-9_-]{43}/);
    const revoked = plain(await authority.status());
    await authority.revoke(BigInt(revoked.revision));
    await unchanged(state, () => restarted.execute(request), /authority_denied/);
    await unchanged(state, () => restarted.reconcile(request.operationId), /authority_denied/);
    await state.claims.handoff('job', token, 'needs_info', fromJSON({ status: 'active',
      handoffChecklist: ['resume_upload'] }), 3n);
    assert.deepEqual((await read(state.root, 'jobs.json')).metadata.durableBrowserOperations, document.metadata.durableBrowserOperations);
    assert.equal((await read(state.root, 'coordinator.json')).claim, null);
    assert.equal((await restarted.observe()).finalAction, 'untouched');
    await assertUnrelatedPreserved(state);
  } finally { await fixture.cleanup(); }
});
