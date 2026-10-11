import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { localBrowserFixture } from './workspace_local_browser_support.mjs';
import { processState, processHost } from './workspace_browser_process_support.mjs';
import { binding, event, read } from './workspace_host_browser_support.mjs';

const draft = 'Unrelated draft remains in the surviving browser';
const operation = async state => (await read(state.root, 'jobs.json')).metadata.durableBrowserOperations.operations['process-fill'];

async function interrupted(t, cut) {
  const native = await nativeFixture();
  t.after(() => native.cleanup());
  const fixture = await localBrowserFixture(t);
  const state = await processState(native, fixture, `process-${cut}`);
  await fixture.page.locator('#notes').fill(draft);
  const first = await processHost(t, native, fixture, state, cut);
  assert.notEqual(first.pid, process.pid);
  const acquire = event('acquire', null, { operationId: 'process-acquire' });
  await assert.rejects(first.call('browser_event', acquire), /user_event_required/);
  await assert.rejects(first.call('browser_approve', acquire), /invalid browser command/);
  await first.approve(acquire);
  const task = (await first.call('browser_event', acquire)).receipt.task;
  const observed = await first.call('browser_observe', binding(state, task));
  assert.equal(observed.evidenceKind, 'synthetic_adapter');
  const request = { operationId: 'process-fill', kind: 'fill', controlId: 'contact.name', valueRef: 'profile.name',
    scope: { ...binding(state, task), form: observed.form, observationRevision: observed.observationRevision } };
  const execution = first.call('browser_execute', request);
  // Attach the rejection assertion before killing to avoid an unhandled rejection.
  const lostResponse = assert.rejects(execution, /host exited null\/SIGKILL/);
  await first.reached;
  const reserved = await operation(state);
  assert.equal(reserved.state, 'pending');
  assert.equal(reserved.receipt.status, 'uncertain');
  assert.match(reserved.request.sourceGrantFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.pageCalls, ['observe', 'compareAndFill']);
  const writes = cut === 'after-mutation' ? 1 : 0;
  assert.equal(await fixture.page.evaluate(() => fixtureWrites), writes);
  assert.deepEqual(await first.stop(), { code: null, signal: 'SIGKILL' });
  await lostResponse;
  assert.deepEqual(await operation(state), reserved);
  assert.equal(await fixture.page.locator('#notes').inputValue(), draft);
  return { native, fixture, state, task, request, reserved, first, writes };
}

async function recover(t, context) {
  const { native, fixture, state, task, first } = context;
  // A deterministic clock expires the old claim; recovery still needs private approval.
  state.clock.now = '2026-10-10T12:06:00Z';
  const second = await processHost(t, native, fixture, state);
  assert.notEqual(second.pid, first.pid);
  await assert.rejects(second.call('browser_reconcile', {
    binding: binding(state, task), operationId: 'process-fill',
  }), /authority_denied/);
  const recoverEvent = event('recover', task, { operationId: 'process-recover' });
  await assert.rejects(second.call('browser_event', recoverEvent), /user_event_required/);
  await second.approve(recoverEvent);
  const recovered = (await second.call('browser_event', recoverEvent)).receipt.task;
  return { second, current: binding(state, recovered) };
}

for (const cut of ['before-mutation', 'after-mutation']) {
  test(`SIGKILL ${cut}: explicit host recovery only reads the original durable intent`, { timeout: 90000 }, async t => {
    const context = await interrupted(t, cut);
    const { fixture, state, request, reserved, writes } = context;
    const { second, current } = await recover(t, context);
    const observed = await second.call('browser_observe', current);
    await assert.rejects(second.call('browser_execute', { ...request, operationId: 'forbidden-new-write',
      scope: { ...current, form: observed.form, observationRevision: observed.observationRevision } }), /reconciliation_required/);
    const input = { binding: current, operationId: request.operationId };
    const expected = writes ? 'verified' : 'uncertain';
    assert.equal((await second.call('browser_reconcile', input)).status, expected);
    assert.equal((await second.call('browser_reconcile', input)).status, expected);
    const after = await operation(state);
    assert.deepEqual(after.request, reserved.request);
    assert.equal(after.state, expected);
    assert.equal(second.pageCalls.filter(method => method === 'compareAndFill').length, 0);
    assert.equal(second.pageCalls.filter(method => method === 'readback').length, writes ? 1 : 2);
    assert.equal(await fixture.page.evaluate(() => fixtureWrites), writes);
    assert.equal(await fixture.page.evaluate(() => fixtureSubmissions), 0);
    assert.equal(await fixture.page.locator('#name').inputValue(), writes ? 'UNRELATED PRIVATE PROFILE' : '');
    assert.equal(await fixture.page.locator('#notes').inputValue(), draft);
  });
}

for (const loss of ['reload', 'closed-browser']) {
  test(`SIGKILL then ${loss}: lost browser identity cannot verify or replay an effect`, { timeout: 90000 }, async t => {
    const context = await interrupted(t, 'after-mutation');
    const { fixture, state, reserved } = context;
    if (loss === 'reload') {
      await fixture.page.reload();
      assert.equal(await fixture.page.locator('#notes').inputValue(), '');
      assert.equal(await fixture.page.evaluate(() => fixtureWrites), 0);
    } else await fixture.browser.close();
    const { second, current } = await recover(t, context);
    const input = { binding: current, operationId: 'process-fill' };
    assert.equal((await second.call('browser_reconcile', input)).status, 'uncertain');
    assert.equal((await second.call('browser_reconcile', input)).status, 'uncertain');
    const after = await operation(state);
    assert.equal(after.state, 'uncertain');
    assert.deepEqual(after.request, reserved.request);
    assert.deepEqual(second.pageCalls, ['readback', 'readback']);
    if (loss === 'reload') {
      const observed = await second.call('browser_observe', current);
      assert.notEqual(observed.form.documentId, reserved.request.scope.form.documentId);
      assert.equal(await fixture.page.locator('#name').inputValue(), '');
      assert.equal(await fixture.page.locator('#notes').inputValue(), '');
      assert.equal(await fixture.page.evaluate(() => fixtureSubmissions), 0);
    } else {
      assert.equal(fixture.browser.isConnected(), false);
      assert.equal(fixture.page.isClosed(), true);
    }
  });
}
