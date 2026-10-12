import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHostBrowserFixture } from '../evals/workflows/host-browser-fixture.mjs';

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'host-safety-integration-'));
  const fixture = await createHostBrowserFixture({ outputDirectory: join(directory, 'trial'), scenario: 'controls-handoff' });
  t.after(async () => { await fixture.close(); await rm(directory, { recursive: true, force: true }); });
  const post = async (route, payload, authorized = true) => {
    const response = await fetch(new URL(route, fixture.url), { method: 'POST', headers: {
      'content-type': 'application/json', ...(authorized ? { authorization: `Bearer ${fixture.manifest.token}` } : {}),
    }, body: JSON.stringify(payload) });
    return { status: response.status, value: await response.json() };
  };
  return { fixture, post };
}

test('fixture authorized-event closes scope and records explicit acquisition evidence with server timing', async t => {
  const { fixture, post } = await setup(t);
  const context = (await post('command', { command: 'context', kind: 'canonical' })).value;
  const event = { ...context.guidance.actions.find(action => action.kind === 'acquire').input, operationId: 'scoped-acquire' };
  const before = await fixture.inspect();
  assert.equal((await post('authorized-event', event, false)).status, 403);
  for (const invalid of [null, {}, { ...event, kind: 'cancel' }, { ...event, root: '/unowned' }, { ...event, hostUserEvent: true }]) {
    assert.equal((await post('authorized-event', invalid)).status, 400);
  }
  assert.deepEqual(await fixture.inspect(), before);
  const accepted = await post('authorized-event', event);
  assert.equal(accepted.status, 200);
  assert.ok(accepted.value.receipt, JSON.stringify(accepted));
  const after = await fixture.inspect(), receipt = after.receipts.at(-1);
  assert.equal(receipt.kind, 'authorized-event');
  assert.equal(receipt.authorizationEvidence, 'host_attested');
  assert.deepEqual(receipt.payload, event);
  assert.ok(Date.parse(receipt.beforeAt) <= Date.parse(receipt.afterAt));
  assert.equal(receipt.beforeCanonical.claimActive, false);
  assert.equal(receipt.afterCanonical.claimActive, true);
  assert.deepEqual(receipt.beforePage, receipt.afterPage);
  assert.ok(after.canonical.sourceFacts);
});

test('ordinary event cannot acquire and authorized recovery cannot take a live claim', async t => {
  const { fixture, post } = await setup(t);
  const context = (await post('command', { command: 'context', kind: 'canonical' })).value;
  const event = { ...context.guidance.actions.find(action => action.kind === 'acquire').input, operationId: 'ordinary-acquire' };
  const denied = await post('command', { command: 'event', kind: 'canonical', payload: event });
  assert.equal(denied.value.ok, false);
  assert.equal((await fixture.inspect()).canonical.claimActive, false);
  await post('authorized-event', { ...event, operationId: 'allowed-acquire' });
  const owned = (await post('command', { command: 'context', kind: 'canonical' })).value;
  const recovery = { kind: 'recover', operationId: 'premature-recover', jobId: 'job', jobRevision: owned.task.subject.jobRevision,
    taskId: owned.task.taskId, expectedRevision: owned.task.revision };
  const before = await fixture.inspect();
  const rejected = await post('authorized-event', recovery);
  assert.equal(rejected.value.ok, false);
  const after = await fixture.inspect();
  assert.deepEqual(after.canonical, before.canonical);
  assert.deepEqual(after.page, before.page);
});
