import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { localBrowserFixture } from './workspace_local_browser_support.mjs';
import { host, binding, event, read } from './workspace_host_browser_support.mjs';
import { BrowserWorkflowBroker } from '../runtime/integrations/host/browser-workflow-broker.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, extractAndStartRun, prepareJob, plain } from './workspace_combined_workflows_support.mjs';
import { ApplicationAuthorityService } from '../runtime/workspace-core/application-authority.js';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';

test('protected broker and adapter replacement reconcile canonical intent against a surviving Chromium draft', async t => {
  const native = await nativeFixture(); t.after(() => native.cleanup());
  const fixture = await localBrowserFixture(t), state = await setup(native, 'local-browser-host');
  // Seed the local job destination before any run, preparation, grant, or claim is created.
  const jobs = await read(state.root, 'jobs.json');
  jobs.jobs.job.url = `${fixture.origin}/job`;
  jobs.jobs.job.normalizedUrl = `${fixture.origin}/job`;
  await writeFile(join(state.root, 'jobs.json'), JSON.stringify(jobs), { mode: 0o600 });
  await extractAndStartRun(state);
  await prepareJob(state);
  state.authority = new ApplicationAuthorityService(state.repository, () => state.clock.now);
  state.authorization = plain(await state.authority.set(fromJSON({ mode: 'autofill_to_review',
    runId: state.run.runId, jobIds: ['job'], sensitiveAnswerRefs: [], durationMinutes: 60 }), 0n));
  state.grants = new Map([['profile.name', { kind: 'fill', source: 'profile', field: 'name', profileRevision: '1' }]]);
  const controls = new Map([['contact.name', 'profile.name']]);
  await fixture.page.locator('#notes').fill('Retain this browser draft through recovery');
  const driver = fixture.driver();
  let ports = host(state, { controls, adapter: fixture.adapter({ ...driver, readback: async () => { throw Error('readback transport lost'); } }) });
  let broker = new BrowserWorkflowBroker(ports, () => assert.fail('unexpected heartbeat failure'));
  t.after(() => broker.close());
  const call = async (command, input) => {
    const dispatched = await broker.dispatch(fromJSON({ command, input }));
    return JSON.parse(serialize(dispatched.response)).result;
  };
  const acquire = { kind: 'acquire', operationId: 'local-acquire', taskId: null, expectedRevision: null,
    jobId: 'job', jobRevision: '2' };
  // The model port cannot approve its own acquisition.
  await assert.rejects(call('browser_event', acquire), /user_event_required/);
  ports.host.approvals.approve((await ports.host.review(acquire)).binding, 300000);
  const task = (await call('browser_event', acquire)).receipt.task;
  const observation = await call('browser_observe', binding(state, task));
  const request = { operationId: 'local-durable-fill', kind: 'fill', controlId: 'contact.name', valueRef: 'profile.name',
    scope: { ...binding(state, task), form: observation.form, observationRevision: observation.observationRevision } };
  assert.equal((await call('browser_execute', request)).status, 'uncertain');
  const before = (await read(state.root, 'jobs.json')).metadata.durableBrowserOperations.operations[request.operationId];
  assert.match(before.request.sourceGrantFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(await fixture.page.locator('#name').inputValue(), 'UNRELATED PRIVATE PROFILE');
  await broker.close();
  state.clock.now = '2026-10-10T12:06:00Z';
  ports = host(state, { controls, adapter: fixture.adapter() });
  broker = new BrowserWorkflowBroker(ports, () => assert.fail('unexpected heartbeat failure'));
  await assert.rejects(call('browser_reconcile', { binding: binding(state, task), operationId: request.operationId }), /authority_denied/);
  const recover = event('recover', task, { operationId: 'local-recovery' });
  ports.host.approvals.approve((await ports.host.review(recover)).binding, 300000);
  const recovered = (await call('browser_event', recover)).receipt.task;
  const current = binding(state, recovered);
  const observed = await call('browser_observe', current);
  await assert.rejects(call('browser_execute', { ...request, operationId: 'no-retry-before-readback',
    scope: { ...current, form: observed.form, observationRevision: observed.observationRevision } }), /reconciliation_required/);
  assert.equal((await call('browser_reconcile', { binding: current, operationId: request.operationId })).status, 'verified');
  assert.equal((await call('browser_reconcile', { binding: current, operationId: request.operationId })).status, 'verified');
  const after = (await read(state.root, 'jobs.json')).metadata.durableBrowserOperations.operations[request.operationId];
  assert.deepEqual(after.request, before.request);
  assert.equal(after.state, 'verified');
  assert.equal(await fixture.page.evaluate(() => fixtureWrites), 1);
  assert.equal(await fixture.page.evaluate(() => fixtureSubmissions), 0);
  assert.equal(await fixture.page.locator('#notes').inputValue(), 'Retain this browser draft through recovery');
  await state.authority.revoke(BigInt(state.authorization.revision));
  await assert.rejects(call('browser_reconcile', { binding: current, operationId: request.operationId }), /authority_denied/);
});
