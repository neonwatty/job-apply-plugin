import assert from 'node:assert/strict';
import test from 'node:test';
import { installedFixture, durableSnapshot, readDocument } from './workspace_installed_workflows_support.mjs';
import { installedBrowserHost } from './workspace_installed_workflows_browser_support.mjs';
import { prepareInstalledCampaign } from '../evals/workflows/scenarios.mjs';

test('installed protected browser host preserves approval separation, archival replay and revocation', {
  skip: !['darwin', 'linux'].includes(process.platform), timeout: 90000,
}, async () => {
  const state = await installedFixture();
  let host;
  try {
    await prepareInstalledCampaign(state);
    const resume = await state.call('store', ['resume-get'], undefined, ['--id', 'source']);
    host = await installedBrowserHost(state, { source: 'resume', kind: 'upload', resumeId: 'source',
      resumeRevision: String(resume.revision), contentRevision: String(resume.contentRevision) });
    const context = await state.call('workflow', ['browser', 'context'], undefined, ['--job-id', 'job']);
    assert.equal(context.userEventSource, 'trusted_host');
    assert.equal(context.browserRecovery.status, 'ready');
    assert.equal(context.browserRecovery.hotOperationCount, 0);
    for (const action of context.guidance.actions) {
      assert.ok(action.args.includes('browser'));
      assert.ok(!action.args.includes('attempt'));
    }
    const request = { ...context.guidance.actions.find(action => action.kind === 'acquire').input, operationId: 'browser-acquire' };
    const before = await durableSnapshot(state.root);
    for (const [command, payload, flags] of [
      ['event', request, []], ['event', request, ['--host-user-event']],
      ['approve', request, []], ['event', { ...request, approved: true }, []],
    ]) {
      assert.equal((await state.call('workflow', ['browser', command], payload, flags, { failure: true })).ok, false);
    }
    assert.deepEqual(await durableSnapshot(state.root), before);
    const review = await host.trusted({ kind: 'review', event: request });
    const approval = await host.trusted({ kind: 'approve', binding: review.binding, lifetime: 300000 });
    const acquired = await state.call('workflow', ['browser', 'event'], request);
    const task = acquired.receipt.task;
    await host.trusted({ kind: 'revoke', grant: approval });
    assert.equal((await state.call('workflow', ['browser', 'event'], request, [], { failure: true })).ok, false);
    const binding = { taskId: task.taskId, taskRevision: task.revision, jobId: 'job',
      attemptRevision: task.subject.jobRevision, authorizationRevision: '1' };
    let first;
    for (let index = 0; index < 64; index++) {
      const observation = await state.call('workflow', ['browser', 'observe'], binding);
      const mutation = { operationId: `upload-${index}`, scope: { ...binding, form: observation.form,
        observationRevision: observation.observationRevision }, kind: 'upload', controlId: 'resume.file', valueRef: 'selected-resume' };
      if (index === 0) {
        first = mutation;
        const unchanged = await durableSnapshot(state.root);
        assert.equal((await state.call('workflow', ['browser', 'execute'],
          { ...mutation, operationId: 'wrong-target', controlId: 'other.file' }, [], { failure: true })).ok, false);
        assert.deepEqual(await durableSnapshot(state.root), unchanged);
      }
      assert.equal((await state.call('workflow', ['browser', 'execute'], mutation)).status, 'verified');
    }
    const ledger = (await readDocument(state.root, 'jobs.json')).metadata.durableBrowserOperations;
    assert.equal(ledger.schemaVersion, 2);
    assert.ok(ledger.archive.segments.length >= 1);
    assert.equal(Object.hasOwn(ledger.operations, first.operationId), false);
    const recovery = (await state.call('workflow', ['browser', 'context'])).browserRecovery;
    assert.equal(recovery.hotOperationCount, Object.keys(ledger.operations).length);
    assert.equal(recovery.archivedOperationCount, 64 - recovery.hotOperationCount);
    const committed = await durableSnapshot(state.root);
    const stats = await host.trusted({ kind: 'stats' });
    assert.equal(stats.writes, 64);
    assert.equal((await state.call('workflow', ['browser', 'execute'], first)).status, 'verified');
    assert.deepEqual(await durableSnapshot(state.root), committed);
    assert.deepEqual(await host.trusted({ kind: 'stats' }), stats);
    assert.equal((await state.call('workflow', ['browser', 'execute'], { ...first, valueRef: 'changed' }, [], { failure: true })).ok, false);
    assert.deepEqual(await durableSnapshot(state.root), committed);
    const observation = await state.call('workflow', ['browser', 'observe'], binding);
    const interrupted = { ...first, operationId: 'interrupted', scope: { ...binding, form: observation.form, observationRevision: observation.observationRevision } };
    await host.trusted({ kind: 'interrupt-readback' });
    assert.equal((await state.call('workflow', ['browser', 'execute'], interrupted)).status, 'uncertain');
    const uncertain = await durableSnapshot(state.root);
    const blocked = (await state.call('workflow', ['browser', 'context'])).browserRecovery;
    assert.equal(blocked.status, 'reconciliation_required');
    assert.equal(blocked.unresolvedOperationId, interrupted.operationId);
    assert.equal((await state.call('workflow', ['browser', 'execute'], { ...interrupted, operationId: 'blind-new-operation' }, [], { failure: true })).ok, false);
    assert.deepEqual(await durableSnapshot(state.root), uncertain);
    assert.equal((await state.call('workflow', ['browser', 'reconcile'], { binding, operationId: interrupted.operationId })).status, 'verified');
    const recoveredStats = await host.trusted({ kind: 'stats' });
    assert.equal(recoveredStats.writes, 65);
    await state.call('store', ['application-authority-revoke'], undefined, ['--expected-revision', '1']);
    const revoked = await durableSnapshot(state.root);
    assert.equal((await state.call('workflow', ['browser', 'execute'], first, [], { failure: true })).ok, false);
    assert.equal((await state.call('workflow', ['browser', 'execute'], { ...first, operationId: 'after-revoke' }, [], { failure: true })).ok, false);
    assert.deepEqual(await durableSnapshot(state.root), revoked);
    assert.deepEqual(await host.trusted({ kind: 'stats' }), recoveredStats);
    // Safe handoff remains possible; a browser receipt never manufactures review readiness.
    await state.call('workflow', ['browser', 'event'], { kind: 'handoff', operationId: 'browser-handoff', taskId: task.taskId,
      expectedRevision: task.revision, jobId: 'job', jobRevision: task.subject.jobRevision, status: 'needs_info',
      session: { status: 'active', handoffChecklist: ['resume_upload'] } });
    assert.equal((await readDocument(state.root, 'coordinator.json')).claim, null);
  } finally {
    try { if (host) await host.stop(); } finally { await state.cleanup(); }
  }
});
