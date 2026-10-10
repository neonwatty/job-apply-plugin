import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import * as extraction from './workspace_resume_workflow_support.mjs';
import * as preparation from './workspace_durable_preparation_support.mjs';
import { setup, extractAndStartRun, prepareJob, assertUnrelatedPreserved, archivePressure,
  read, snapshot, unchanged, host, event, pending, readyPacket } from './workspace_combined_workflows_support.mjs';

test('native extraction, preparation and attempts share one durable lifecycle', { timeout: 90000 }, async t => {
  const fixture = await nativeFixture();
  try {
    await t.test('confirmed facts flow into selection, archived replay and manual-review handoff', async () => {
      const state = await setup(fixture, 'combined-archive');
      const extracted = await extractAndStartRun(state), prepared = await prepareJob(state);
      assert.equal(state.run.selection.factRevision, 2);
      assert.equal(state.run.selection.resumeId, 'source');
      const app = host(state), acquire = event('acquire');
      try {
        const acquired = await app.workflow.execute(acquire, acquire);
        assert.equal(acquired.receipt.task.subject.jobRevision, '3');
        await archivePressure(state, 'extract-start');
        const progress = event('progress', acquired.receipt.task, { operationId: 'combined-progress' });
        const progressed = await app.workflow.execute(progress);
        const jobs = await read(state.root, 'jobs.json');
        assert.equal(jobs.metadata.agentWorkflows.archive.segments.length, 1);
        assert.equal(jobs.metadata.agentWorkflows.receipts['extract-start'], undefined);
        const archived = await snapshot(state.root);
        assert.equal(Object.keys(archived).filter(path => path.startsWith('workflow-archive/')).length, 1);
        const resume = extraction.runtime(state).workflow, prepare = preparation.runtime(state).workflow;
        assert.deepEqual(await resume.route(extracted.reply.proposal, extracted.reply.attestation),
          { receipt: extracted.accepted.receipt, replayed: true });
        assert.deepEqual(await prepare.route(prepared.reply.proposal, prepared.reply.attestation),
          { receipt: prepared.ready.receipt, replayed: true });
        assert.deepEqual(await app.workflow.execute(acquire, acquire), { receipt: acquired.receipt, replayed: true });
        assert.deepEqual(await snapshot(state.root), archived);
        await unchanged(state, () => resume.action({ ...extracted.propose, arguments: { name: 'Changed' } }), /operation_conflict/);
        const handoff = event('handoff', progressed.receipt.task, { operationId: 'combined-review', status: 'awaiting_review',
          session: { status: 'review', readinessInput: readyPacket(3), handoffChecklist: [] } });
        const reviewed = await app.workflow.execute(handoff);
        assert.equal(reviewed.receipt.outcome, 'awaiting_review');
        assert.equal((await read(state.root, 'coordinator.json')).claim, null);
        assert.equal((await read(state.root, 'jobs.json')).jobs.job.status, 'awaiting_review');
        assert.equal((await read(state.root, 'jobs.json')).jobs.other.revision, 1);
        const beforeReplay = await snapshot(state.root), fresh = host(state).workflow;
        try {
          assert.deepEqual(await fresh.execute(handoff), { receipt: reviewed.receipt, replayed: true });
          assert.deepEqual(await snapshot(state.root), beforeReplay);
        } finally { await fresh.close(); }
        await assertUnrelatedPreserved(state);
        assert.doesNotMatch(JSON.stringify((await read(state.root, 'jobs.json')).metadata.agentWorkflows), /PRIVATE|claim_[A-Za-z0-9_-]{43}/);
      } finally { await app.workflow.close(); }
    });
    await t.test('broker restart needs exact expiry recovery and revocation still permits safe release', async () => {
      const state = await setup(fixture, 'combined-broker-loss');
      await extractAndStartRun(state);
      await prepareJob(state);
      const first = host(state).workflow, acquire = event('acquire');
      const task = (await first.execute(acquire, acquire)).receipt.task;
      await first.close();
      const next = host(state);
      try {
        assert.equal((await next.workflow.execute(acquire, acquire)).replayed, true);
        assert.equal((await next.workflow.inspect()).brokerAvailable, false);
        await unchanged(state, () => next.workflow.execute(event('progress', task)), /broker_unavailable/);
        const recover = event('recover', task);
        await unchanged(state, () => next.workflow.execute(recover), /user_event_required/);
        await unchanged(state, () => next.workflow.execute(recover, recover), /live claim/);
        state.clock.now = '2026-10-10T12:05:00Z';
        const recovered = (await next.workflow.execute(recover, recover)).receipt.task;
        assert.equal((await next.workflow.inspect()).brokerAvailable, true);
        next.access.authorized = [];
        await unchanged(state, () => next.workflow.execute(event('progress', recovered)), /profile_unavailable/);
        await unchanged(state, () => next.workflow.execute(acquire, acquire), /profile_unavailable/);
        const handoff = event('handoff', recovered, { operationId: 'revoked-safe-handoff', session: pending });
        assert.equal((await next.workflow.execute(handoff)).receipt.outcome, 'needs_info');
        assert.equal((await read(state.root, 'coordinator.json')).claim, null);
        assert.deepEqual((await read(state.root, 'sessions/job.json')).handoffChecklist, pending.handoffChecklist);
        await assertUnrelatedPreserved(state);
      } finally { await next.workflow.close(); }
    });
  } finally { await fixture.cleanup(); }
});
