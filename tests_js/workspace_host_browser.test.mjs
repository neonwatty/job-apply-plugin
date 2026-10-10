import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { BrowserWorkflowBroker } from '../runtime/integrations/host/browser-workflow-broker.js';
import { createBrowserAuthority } from '../runtime/integrations/host/browser-authority.js';
import { controlFingerprint, requestFingerprint } from '../runtime/contracts/workspace/browser-boundary.js';
import { fromJSON } from '../runtime/contracts/workspace/values.js';
import { setupHost, host, acquire, proposal, binding, event, read, snapshot, unchanged,
  assertUnrelatedPreserved } from './workspace_host_browser_support.mjs';

test('native browser host separates protected approvals and keeps canonical claim capability private', async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const state = await setupHost(fixture, 'host-browser'), ports = host(state); t.after(() => ports.host.close());
  assert.deepEqual(Object.keys(ports.model).sort(), ['context', 'event', 'execute', 'observe', 'reconcile']);
  const unapproved = event('acquire', null, { operationId: 'unapproved' });
  await unchanged(state, () => ports.model.event(unapproved), /user_event_required/);
  await unchanged(state, () => ports.model.event({ ...unapproved, approval: true }), /invalid_event/);
  const guidance = (await ports.model.context()).guidance;
  assert.ok(guidance.actions.length > 0);
  for (const action of guidance.actions) {
    assert.ok(action.args.includes('browser'));
    assert.ok(!action.args.includes('attempt'));
  }
  const task = await acquire(ports), request = await proposal(ports, state, task);
  assert.equal((await ports.model.execute(request)).status, 'verified');
  assert.equal(state.adapter.calls.writes, 1);
  const before = await snapshot(state.root), calls = state.adapter.calls;
  assert.equal((await ports.model.execute(request)).status, 'verified');
  assert.deepEqual(await snapshot(state.root), before);
  assert.deepEqual(state.adapter.calls, calls);
  const output = JSON.stringify({ context: await ports.model.context(),
    operations: (await read(state.root, 'jobs.json')).metadata.durableBrowserOperations });
  assert.doesNotMatch(output, /PRIVATE|claim_[A-Za-z0-9_-]{43}|approve|claimToken/);
  assert.equal((await ports.model.observe(binding(state, task))).finalAction, 'untouched');
  await assertUnrelatedPreserved(state);
  await ports.host.close();
  await assert.rejects(ports.model.execute(request), /broker_unavailable/);
  const replacement = host(state); t.after(() => replacement.host.close());
  await unchanged(state, () => replacement.model.execute(request), /authority_denied/);
  assert.equal(state.adapter.calls.writes, 1);
});

test('exact source grants and task revisions reject forged scope, stale progress and revoked replay', async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const state = await setupHost(fixture, 'host-browser-scope'), ports = host(state); t.after(() => ports.host.close());
  const task = await acquire(ports), request = await proposal(ports, state, task);
  for (const [field, value] of [['taskId', 'another-task'], ['taskRevision', '999'], ['jobId', 'other'],
    ['attemptRevision', '999'], ['authorizationRevision', '999']]) {
    const scope = { ...binding(state, task), [field]: value };
    await ports.model.observe(scope);
    await unchanged(state, () => ports.model.execute({ ...request, scope: { ...request.scope, ...scope } }), /authority_denied/);
  }
  await ports.model.observe(binding(state, task));
  await unchanged(state, () => ports.model.execute({ ...request, valueRef: 'model.invented' }), /authority_denied/);
  await unchanged(state, () => ports.model.execute({ ...request, valueRef: 'resume.source' }), /authority_denied/);
  const badForm = { ...request.scope.form, origin: 'https://unexpected.invalid' };
  await unchanged(state, () => ports.model.execute({ ...request, scope: { ...request.scope, form: badForm } }), /scope_changed/);
  assert.equal(state.adapter.calls.writes, 0);
  const progressed = (await ports.model.event(event('progress', task))).receipt.task;
  await unchanged(state, () => ports.model.execute(request), /authority_denied/);
  const upload = await proposal(ports, state, progressed, { operationId: 'host-upload', kind: 'upload',
    controlId: 'resume.file', valueRef: 'resume.source' });
  assert.equal((await ports.model.execute(upload)).status, 'verified');
  await state.authority.revoke(BigInt(state.authorization.revision));
  await unchanged(state, () => ports.model.execute(upload), /authority_denied/);
  await unchanged(state, () => ports.model.reconcile(binding(state, progressed), upload.operationId), /authority_denied/);
  await ports.model.event(event('handoff', progressed));
  assert.equal((await read(state.root, 'coordinator.json')).claim, null);
  assert.equal(state.adapter.calls.writes, 1);
});

test('changed canonical preparation input blocks a formerly approved browser operation', async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const state = await setupHost(fixture, 'host-browser-input'), ports = host(state); t.after(() => ports.host.close());
  const task = await acquire(ports), request = await proposal(ports, state, task);
  const profile = await read(state.root, 'profile.json');
  profile.profile.name = 'changed'; profile.metadata.revision = (profile.metadata.revision ?? 1) + 1;
  await writeFile(join(state.root, 'profile.json'), JSON.stringify(profile), { mode: 0o600 });
  await unchanged(state, () => ports.model.execute(request), /authority_denied/);
  assert.equal(state.adapter.calls.writes, 0);
});

test('browser broker accepts only dedicated model commands and cannot dispatch approval or campaign bypasses', async () => {
  let dispatched = 0;
  const ports = { model: { context: async () => { dispatched++; return {}; } }, host: { close: async () => {} } };
  const broker = new BrowserWorkflowBroker(ports, () => {});
  for (const request of [{ command: 'context' }, { command: 'campaign_context' },
    { command: 'event', event: {}, hostUserEvent: true }, { command: 'browser_approve', input: {} },
    { command: 'browser_event', input: {}, hostUserEvent: true }]) {
    await assert.rejects(broker.dispatch(fromJSON(request)));
  }
  assert.equal(dispatched, 0);
  await broker.dispatch(fromJSON({ command: 'browser_context' }));
  assert.equal(dispatched, 1);
  await broker.close();
});

test('trusted control mappings and source grants are copied and cannot be substituted by a model', async () => {
  let evaluations = 0;
  const original = { kind: 'fill', source: 'profile', field: 'name', profileRevision: '1' };
  const grants = new Map([['profile.name', original]]), controls = new Map([['name', 'profile.name']]);
  const authority = createBrowserAuthority({ checkBrowserAuthority: async (request, grant) => {
    evaluations++;
    assert.equal(grant.field, 'name'); assert.equal(grant.profileRevision, '1');
    return { authorized: true, requestFingerprint: requestFingerprint(request) };
  } }, grants, controls);
  original.field = 'email'; original.profileRevision = '9'; grants.clear(); controls.clear();
  const request = { operationId: 'mapped', kind: 'fill', controlId: 'name', valueRef: 'profile.name',
    scope: { taskId: 'task', taskRevision: '1', jobId: 'job', attemptRevision: '3', authorizationRevision: '1',
      observationRevision: '1', form: { documentId: 'document', formId: 'form', origin: 'https://example.invalid',
        controlSetFingerprint: controlFingerprint([{ id: 'name', kind: 'fill' }]) } } };
  assert.equal((await authority.check(request)).authorized, true);
  assert.equal((await authority.check({ ...request, controlId: 'email' })).authorized, false);
  assert.equal((await authority.check({ ...request, valueRef: 'profile.email' })).authorized, false);
  assert.equal(evaluations, 1);
  assert.throws(() => createBrowserAuthority({}, new Map(), new Map([['name', 'missing']])));
});
