import assert from 'node:assert/strict';
import test from 'node:test';
import { installedHost } from './workspace_host_support.mjs';
import { event, snapshot, read } from './workspace_durable_claims_support.mjs';

test('installed trusted host receives separate approvals while the public client cannot mint them', async t => {
  const { state, workflow, serve } = await installedHost(t);
  await state.claims.select('job', 1n, true);
  const { child, done } = await serve(true);
  let serial = 0;
  function trusted(message) {
    return new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => { child.off('message', receive); reject(Error('fixture host timeout')); }, 10000);
      function receive(response) {
        if (response.id !== id) return;
        clearTimeout(timer); child.off('message', receive);
        if (response.ok) resolve(response.result); else reject(Error('fixture host rejected'));
      }
      child.on('message', receive); child.send({ id, ...message });
    });
  }
  const context = await workflow('attempt', 'context');
  assert.equal(context.result.userEventSource, 'trusted_host');
  const request = event('acquire'), before = await snapshot(state.root);
  assert.equal((await workflow('attempt', 'event', request, ['--host-user-event'])).ok, false);
  assert.equal((await workflow('attempt', 'approve', request)).ok, false);
  assert.equal((await workflow('attempt', 'event', { ...request, approval: true })).ok, false);
  assert.deepEqual(await snapshot(state.root), before);
  const review = await trusted({ kind: 'review', event: request });
  const grant = await trusted({ kind: 'approve', binding: review.binding, lifetime: 300000 });
  assert.equal((await workflow('attempt', 'event', { ...request, operationId: 'different' }, ['--host-user-event'])).ok, false);
  const acquired = await workflow('attempt', 'event', request);
  assert.equal(acquired.ok, true); assert.equal(acquired.result.receipt.outcome, 'claim_acquired');
  assert.equal((await workflow('attempt', 'event', request)).result.replayed, true);
  await trusted({ kind: 'revoke', grant });
  assert.equal((await workflow('attempt', 'event', request, ['--host-user-event'])).ok, false);
  const progress = await workflow('attempt', 'event', event('progress', acquired.result.receipt.task));
  const cancel = event('cancel', progress.result.receipt.task);
  const beforeCancel = await snapshot(state.root);
  assert.equal((await workflow('attempt', 'event', cancel, ['--host-user-event'])).ok, false);
  assert.deepEqual(await snapshot(state.root), beforeCancel);
  const cancellation = await trusted({ kind: 'review', event: cancel });
  await trusted({ kind: 'approve', binding: cancellation.binding, lifetime: 300000 });
  assert.equal((await workflow('attempt', 'event', cancel)).result.receipt.outcome, 'cancelled');
  assert.equal((await read(state.root, 'coordinator.json')).claim, null);
  assert.deepEqual((await read(state.root, 'sessions/job.json')).handoffChecklist, ['resume_upload']);
  child.kill('SIGTERM');
  const exit = await done; assert.equal(exit.code, 0); assert.equal(exit.stderr, '');
});
