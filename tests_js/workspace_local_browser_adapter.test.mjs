import assert from 'node:assert/strict';
import test from 'node:test';
import { localBrowserFixture } from './workspace_local_browser_support.mjs';
import { DurableBrowserBoundary } from '../runtime/integrations/browser/durable-boundary.js';
import { requestFingerprint } from '../runtime/integrations/browser/contract.js';
import { LocalFixtureBrowserAdapter } from '../runtime/integrations/browser/local-fixture-adapter.js';

const binding = { taskId: 'fixture-task', taskRevision: '1', jobId: 'job', attemptRevision: '1', authorizationRevision: '1' };
function boundary(adapter, store = memoryStore()) {
  return new DurableBrowserBoundary(adapter, { check: async request => ({ authorized: true,
    requestFingerprint: requestFingerprint(request) }) }, binding, store);
}
function memoryStore() {
  let ledger = { schemaVersion: 1, operations: {} };
  return { async transaction(operation) { return operation({ ledger, commit: async next => { ledger = next; } }); } };
}
async function proposal(browser, operationId = 'fill-name') {
  const observation = await browser.observe();
  return { operationId, kind: 'fill', controlId: 'contact.name', valueRef: 'profile.name',
    scope: { ...binding, form: observation.form, observationRevision: observation.observationRevision } };
}

test('real Chromium conditionally fills a mapped fixture control and replay does not write twice', async t => {
  const fixture = await localBrowserFixture(t), browser = boundary(fixture.adapter());
  await fixture.page.locator('#notes').fill('Surviving unrelated draft');
  const request = await proposal(browser);
  assert.equal((await browser.execute(request)).status, 'verified');
  assert.equal(await fixture.page.locator('#name').inputValue(), 'UNRELATED PRIVATE PROFILE');
  assert.equal(await fixture.page.locator('#notes').inputValue(), 'Surviving unrelated draft');
  assert.equal((await browser.execute(request)).status, 'verified');
  assert.equal(await fixture.page.evaluate(() => fixtureWrites), 1);
  assert.equal(await fixture.page.evaluate(() => fixtureSubmissions), 0);
  assert.doesNotMatch(JSON.stringify(await browser.observe()), /PRIVATE PROFILE|Surviving unrelated draft/);
});

for (const change of ['draft', 'replace-control', 'replace-form', 'reload', 'final-action']) {
  test(`real Chromium rejects a stale observation after ${change}`, async t => {
    const fixture = await localBrowserFixture(t), browser = boundary(fixture.adapter());
    const request = await proposal(browser);
    if (change === 'draft') await fixture.page.locator('#notes').fill('User draft after observation');
    if (change === 'replace-control') await fixture.page.evaluate(() => {
      const node = document.querySelector('#name'); node.replaceWith(node.cloneNode(true));
    });
    if (change === 'replace-form') await fixture.page.evaluate(() => {
      const node = document.querySelector('form'); node.replaceWith(node.cloneNode(true));
    });
    if (change === 'reload') await fixture.page.reload();
    if (change === 'final-action') await fixture.page.locator('#submit').click();
    assert.deepEqual(await browser.execute(request), { operationId: request.operationId, status: 'not_applied',
      evidenceKind: 'synthetic_adapter', reason: 'scope_changed' });
    assert.equal(await fixture.page.locator('#name').inputValue(), '');
    assert.equal(await fixture.page.evaluate(() => fixtureWrites), 0);
    if (change === 'draft') assert.equal(await fixture.page.locator('#notes').inputValue(), 'User draft after observation');
  });
}

test('interrupted readback reconciles through replaced adapter and boundary without overwriting surviving drafts', async t => {
  const fixture = await localBrowserFixture(t), store = memoryStore(), driver = fixture.driver();
  await fixture.page.locator('#notes').fill('Keep this draft across host restart');
  const interrupted = fixture.adapter({ ...driver, readback: async () => { throw Error('lost browser reply'); } });
  const before = boundary(interrupted, store), request = await proposal(before);
  assert.equal((await before.execute(request)).status, 'uncertain');
  const after = boundary(fixture.adapter(), store);
  const blocked = await proposal(after, 'blocked-fill');
  await assert.rejects(after.execute(blocked), /reconciliation_required/);
  assert.equal((await after.reconcile(request.operationId)).status, 'verified');
  assert.equal((await after.execute(request)).status, 'verified');
  assert.equal(await fixture.page.evaluate(() => fixtureWrites), 1);
  assert.equal(await fixture.page.locator('#notes').inputValue(), 'Keep this draft across host restart');
  assert.equal(await fixture.page.evaluate(() => fixtureSubmissions), 0);
});

test('changed readback leaves uncertainty and a user edit untouched', async t => {
  const fixture = await localBrowserFixture(t), store = memoryStore(), driver = fixture.driver();
  const before = boundary(fixture.adapter({ ...driver, readback: async () => { throw Error('interrupted'); } }), store);
  const request = await proposal(before);
  assert.equal((await before.execute(request)).status, 'uncertain');
  await fixture.page.locator('#name').fill('Human correction');
  const after = boundary(fixture.adapter(), store);
  assert.equal((await after.reconcile(request.operationId)).status, 'uncertain');
  assert.equal(await fixture.page.locator('#name').inputValue(), 'Human correction');
});

test('trusted mapping cannot be redirected and fixture adapter refuses uploads, final controls or remote origins', async t => {
  const fixture = await localBrowserFixture(t), adapter = fixture.adapter();
  const request = await proposal(boundary(adapter));
  for (const override of [{ valueRef: 'other.ref' }, { controlId: 'submit' }, { controlId: 'resume.file', kind: 'upload' }]) {
    assert.equal((await adapter.mutate({ ...request, ...override })).status, 'not_applied');
  }
  assert.equal(await fixture.page.evaluate(() => fixtureWrites), 0);
  assert.equal(await fixture.page.evaluate(() => fixtureSubmissions), 0);
  assert.throws(() => new LocalFixtureBrowserAdapter(fixture.driver(), 'https://example.com', new Map()), /invalid_browser_input/);
});


test('browser event handler changes are read back as uncertain instead of confirmed', async t => {
  const fixture = await localBrowserFixture(t), browser = boundary(fixture.adapter());
  await fixture.page.evaluate(() => document.querySelector('#name').addEventListener('input', event => {
    event.target.value = 'Page handler changed the intended value';
  }));
  const request = await proposal(browser);
  assert.equal((await browser.execute(request)).status, 'uncertain');
  assert.equal(await fixture.page.locator('#name').inputValue(), 'Page handler changed the intended value');
  const next = await proposal(browser, 'blocked-after-handler');
  await assert.rejects(browser.execute(next), /reconciliation_required/);
  assert.equal(await fixture.page.evaluate(() => fixtureWrites), 1);
});
