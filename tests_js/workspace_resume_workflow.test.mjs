import assert from 'node:assert/strict';
import test from 'node:test';
import { basename, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { fromJSON } from '../runtime/contracts/workspace/values.js';
import { setup, runtime, start, propose, ask, cancel, pending, reply, read, snapshot, plain, rejectedUnchanged } from './workspace_resume_workflow_support.mjs';

test('scoped resume workflow owns review, exact replay and canonical recovery', { timeout: 90000 }, async t => {
  const fixture = await nativeFixture();
  try {
    await t.test('proposal cannot confirm; restart review accepts exact draft and preserves unrelated facts/profile', async () => {
      const state = await setup(fixture, 'success'), app = runtime(state);
      const before = await snapshot(state.root), others = (await read(state.root, 'resume-facts.json')).sets.other;
      const started = await app.workflow.route(start());
      assert.equal(started.receipt.outcome, 'extraction_requested');
      assert.equal(started.receipt.task.subject.kind, 'resume');
      assert.equal('jobId' in started.receipt.task.subject, false);
      const proposed = await app.workflow.action(propose(started.receipt.task));
      assert.equal(plain(await state.facts.get('source')).state, 'draft');
      assert.equal((await snapshot(state.root))['profile.json'], before['profile.json']);
      await rejectedUnchanged(state, () => app.workflow.action({ ...propose(proposed.receipt.task, 'skip'), actionId: 'resume.confirm' }), /action_unavailable/);
      const waiting = (await app.workflow.action(ask(proposed.receipt.task))).receipt.task;
      const fresh = runtime(state).workflow, event = await reply(fresh, waiting);
      const accepted = await fresh.route(event.proposal, event.attestation);
      assert.equal(accepted.receipt.outcome, 'extraction_accepted');
      assert.equal(plain(await state.facts.get('source')).state, 'confirmed');
      const after = await snapshot(state.root);
      assert.deepEqual(await fresh.route(start()), { receipt: started.receipt, replayed: true });
      assert.deepEqual(await fresh.action(propose(started.receipt.task)), { receipt: proposed.receipt, replayed: true });
      assert.deepEqual(await fresh.route(event.proposal, event.attestation), { receipt: accepted.receipt, replayed: true });
      assert.deepEqual(await snapshot(state.root), after);
      assert.equal(after['profile.json'], before['profile.json']);
      assert.deepEqual((await read(state.root, 'resume-facts.json')).sets.other, others);
      assert.doesNotMatch(JSON.stringify((await read(state.root, 'jobs.json')).metadata.agentWorkflows), /PRIVATE|private\.txt|skills|Synthetic/);
      await rejectedUnchanged(state, () => fresh.action({ ...propose(started.receipt.task), arguments: { changed: true } }), /operation_conflict/);
    });
    await t.test('archive preserves historical extraction scopes and exact resume replay', async () => {
      const state = await setup(fixture, 'archive'), { workflow } = runtime(state);
      const started = await workflow.route(start()), jobs = await read(state.root, 'jobs.json');
      const ledger = jobs.metadata.agentWorkflows;
      for (let index = 0; index < 252; index++) {
        const operationId = `seed-${index}`, item = structuredClone(ledger.receipts.start);
        item.receipt.operationId = operationId; ledger.receipts[operationId] = item;
      }
      await writeFile(join(state.root, 'jobs.json'), JSON.stringify(jobs), { mode: 0o600 });
      const proposed = await workflow.action(propose(started.receipt.task));
      assert.notEqual(proposed.receipt.task.subject.inputRevision, started.receipt.task.subject.inputRevision);
      assert.equal((await read(state.root, 'jobs.json')).metadata.agentWorkflows.archive.segments.length, 1);
      const task = (await workflow.action(ask(proposed.receipt.task))).receipt.task;
      const event = await reply(workflow, task);
      await workflow.route(event.proposal, event.attestation);
      const before = await snapshot(state.root), fresh = runtime(state).workflow;
      assert.deepEqual(await fresh.route(start()), { receipt: started.receipt, replayed: true });
      await rejectedUnchanged(state, () => fresh.route({ ...start(), input: { resumeId: 'other', resumeRevision: '1' } }), /operation_conflict/);
      assert.deepEqual(await snapshot(state.root), before);
    });
    await t.test('missing, mismatched and fabricated review events fail without writes', async () => {
      const state = await setup(fixture, 'approval'), { workflow } = runtime(state), task = await pending(workflow);
      const event = await reply(workflow, task);
      await rejectedUnchanged(state, () => workflow.route(event.proposal), /user_event_required/);
      await rejectedUnchanged(state, () => workflow.route(event.proposal, { ...event.attestation, expectedRevision: '1' }), /user_event_required/);
      for (const patch of [{ requestId: 'invented' }, { factRevision: '999' }, { contentRevision: `content_${'z'.repeat(32)}` }]) {
        const proposal = { ...event.proposal, event: { ...event.proposal.event, ...patch } };
        await rejectedUnchanged(state, () => workflow.route(proposal, { ...event.attestation, reply: proposal.event }), /user_event_required/);
      }
      const rejected = await reply(workflow, task, 'reject');
      assert.equal((await workflow.route(rejected.proposal, rejected.attestation)).receipt.outcome, 'extraction_rejected');
      assert.equal(plain(await state.facts.get('source')).state, 'draft');
    });
    await t.test('replacement and competing drafts stale the review, with safe cancellation', async () => {
      for (const change of ['replace', 'draft']) {
        const state = await setup(fixture, change), { workflow } = runtime(state), task = await pending(workflow);
        const event = await reply(workflow, task);
        if (change === 'replace') await state.resumes.replace('source', 'next.txt', Buffer.from('NEW SOURCE'), 1n);
        else await state.facts.createDraft('source', fromJSON({ name: 'Different candidate' }), 1n, 1n);
        await rejectedUnchanged(state, () => workflow.route(event.proposal, event.attestation), /stale_revision/);
        assert.deepEqual((await workflow.inspect()).context.allowedActions, []);
        assert.equal((await workflow.route(cancel(task))).receipt.outcome, 'cancelled');
      }
    });
    await t.test('request adoption is exact; interrupted request is failed and replay is inert', async () => {
      const state = await setup(fixture, 'adopt'), { workflow } = runtime(state);
      const request = plain(await state.requests.createRequest('source', 1n, true));
      await rejectedUnchanged(state, () => workflow.route(start('bad', { requestId: request.requestId, requestRevision: '2', resumeRevision: '1' })), /stale_revision/);
      const task = (await workflow.route(start('adopt', { requestId: request.requestId, requestRevision: '1', resumeRevision: '1' }))).receipt.task;
      const action = { ...propose(task, 'interrupt'), actionId: 'resume.interrupt', arguments: {} };
      const result = await workflow.action(action);
      assert.equal(result.receipt.outcome, 'extraction_interrupted');
      assert.equal(plain(await state.requests.getRequest(request.requestId)).failureReason, 'interrupted');
      const before = await snapshot(state.root);
      assert.equal((await runtime(state).workflow.action(action)).replayed, true);
      assert.deepEqual(await snapshot(state.root), before);
    });
    await t.test('revocation blocks historical access and continuation; cancel stays available', async () => {
      const state = await setup(fixture, 'revoked'), app = runtime(state), task = await pending(app.workflow);
      app.access.authorized = [];
      await rejectedUnchanged(state, () => app.workflow.route(start()), /profile_unavailable/);
      assert.deepEqual((await app.workflow.inspect()).context.allowedActions, []);
      assert.equal((await app.workflow.route(cancel(task))).receipt.outcome, 'cancelled');
    });
    await t.test('ordinary Store access recovers request/facts/receipt after every publication interruption', async () => {
      for (const target of ['resume-extraction-journal.json', 'resume-extraction-requests.json', 'resume-facts.json', 'jobs.json']) {
        const state = await setup(fixture, `crash-${target}`), initial = runtime(state);
        const task = (await initial.workflow.route(start())).receipt.task;
        let armed = true;
        const failing = runtime(state, async path => {
          if (armed && basename(path) === target) { armed = false; throw Error('injected interruption'); }
        });
        const action = propose(task);
        await assert.rejects(failing.workflow.action(action), /injected interruption/);
        await state.repository.transaction(async () => {});
        const before = await snapshot(state.root);
        const result = await runtime(state).workflow.action(action);
        assert.equal(result.replayed, true);
        assert.deepEqual(await snapshot(state.root), before);
        assert.equal(plain(await state.facts.get('source')).versions.length, 1);
      }
    });
  } finally { await fixture.cleanup(); }
});
