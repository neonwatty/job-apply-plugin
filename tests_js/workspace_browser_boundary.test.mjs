import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserBoundary } from '../runtime/integrations/browser/boundary.js';
import { BrowserBoundaryError, browserMutation, browserObservation, browserReadback, browserWriteResult,
  controlFingerprint, requestFingerprint } from '../runtime/integrations/browser/contract.js';
import { SyntheticBrowserAdapter } from '../runtime/integrations/browser/synthetic.js';

const binding = {taskId:'task-fictional', taskRevision:'9007199254740993', jobId:'job-fictional',
  attemptRevision:'3', authorizationRevision:'2'};
function observation(overrides = {}) {
  const controls = [{id:'contact.email', kind:'fill', state:'empty'}, {id:'resume.file', kind:'upload', state:'empty'},
    {id:'submit', kind:'final', state:'empty'}];
  return {evidenceKind:'synthetic_adapter', form:{documentId:'document-fictional', formId:'form-fictional',
    origin:'https://fixture.invalid', controlSetFingerprint:controlFingerprint(controls)},
    observationRevision:'1', controls, finalAction:'untouched', ...overrides};
}
const values = () => new Map([['profile.email', 'fictional@example.invalid'], ['resume.selected', 'fictional resume bytes']]);
const allow = {check:async request => ({authorized:true, requestFingerprint:requestFingerprint(request)})};
const mutation = (observed, overrides = {}) => ({operationId:'operation-one', scope:{...binding,
  form:observed.form, observationRevision:observed.observationRevision}, kind:'fill',
  controlId:'contact.email', valueRef:'profile.email', ...overrides});
async function setup({adapter = new SyntheticBrowserAdapter(observation(), values()), authority = allow} = {}) {
  const boundary = new BrowserBoundary(adapter, authority, binding);
  const observed = await boundary.observe();
  return {boundary, adapter, request:mutation(observed)};
}
async function rejects(operation, code) {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof BrowserBoundaryError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(error.cause, undefined);
    return true;
  });
}
function wrapper(base, overrides) {
  return {evidenceKind:'synthetic_adapter', observe:() => base.observe(), mutate:request => base.mutate(request),
    readback:request => base.readback(request), ...overrides};
}

test('non-string observation and readback enums reject instead of bypassing unavailable controls', async () => {
  const observed = observation();
  const malformed = {...observed, controls:observed.controls.map((control, index) =>
    index === 0 ? {...control, state:['unavailable']} : control)};
  assert.throws(() => new SyntheticBrowserAdapter(malformed, values()), {code:'invalid_browser_input'});
  for (const input of [malformed, {...observed, finalAction:['untouched']}]) {
    assert.throws(() => browserObservation(input), {code:'invalid_browser_input'});
  }
  const badKind = {...observed, controls:observed.controls.map((control, index) =>
    index === 0 ? {...control, kind:['fill']} : control)};
  badKind.form = {...observed.form, controlSetFingerprint:controlFingerprint(badKind.controls)};
  assert.throws(() => browserObservation(badKind), {code:'invalid_browser_input'});
  assert.throws(() => browserReadback({observation:observed, operationId:'operation-one',
    requestFingerprint:requestFingerprint(mutation(observed)), effect:['matches']}), {code:'invalid_browser_input'});
  const base = new SyntheticBrowserAdapter(observed, values());
  const boundary = new BrowserBoundary(wrapper(base, {observe:async () => malformed}), allow, binding);
  await rejects(boundary.observe(), 'adapter_unavailable');
  await rejects(boundary.execute(mutation(observed)), 'observation_required');
  assert.equal(base.calls.writes, 0);
});

test('malformed no-effect reason keeps a completed write uncertain until reconciliation', async () => {
  const base = new SyntheticBrowserAdapter(observation(), values());
  const malformed = {status:'not_applied', reason:['scope_changed']};
  assert.throws(() => browserWriteResult(malformed), {code:'invalid_browser_input'});
  const adapter = wrapper(base, {mutate:async request => { await base.mutate(request); return malformed; }});
  const {boundary, request} = await setup({adapter});
  assert.equal((await boundary.execute(request)).status, 'uncertain');
  const current = await boundary.observe();
  await rejects(boundary.execute(mutation(current, {operationId:'second-operation'})), 'reconciliation_required');
  assert.equal(base.calls.writes, 1);
  assert.equal((await boundary.reconcile(request.operationId)).status, 'verified');
  assert.equal(base.calls.writes, 1);
});

test('denial, malformed proposals, final actions and forged evidence make zero adapter calls', async () => {
  for (const authority of [
    {check:async () => ({authorized:false, requestFingerprint:'0'.repeat(64)})},
    {check:async () => ({authorized:true, requestFingerprint:'0'.repeat(64)})},
    {check:async () => { throw new Error('PRIVATE authority diagnostic'); }},
  ]) {
    const {boundary, adapter, request} = await setup({authority}), before = adapter.calls;
    await rejects(boundary.execute(request), 'authority_denied');
    assert.deepEqual(adapter.calls, before);
  }
  const {boundary, adapter, request} = await setup(), before = adapter.calls;
  for (const input of [
    {...request, kind:'submit'}, {...request, kind:'navigate_non_final'}, {...request, kind:'click'},
    {...request, kind:'evaluate'}, {...request, kind:'shell'}, {...request, authorized:true},
    {...request, evidenceKind:'agent_attested_current_attempt'}, {...request, value:'PRIVATE'},
    {...request, scope:{...request.scope, taskRevision:9007199254740992}},
    {...request, scope:{...request.scope, attemptRevision:'01'}},
  ]) await rejects(boundary.execute(input), 'invalid_browser_input');
  await rejects(boundary.execute({...request, controlId:'submit'}), 'scope_changed');
  assert.deepEqual(adapter.calls, before);
});

test('verified fill and upload require matching readbacks and produce value-free synthetic receipts', async () => {
  const {boundary, adapter, request} = await setup();
  const first = await boundary.execute(request);
  assert.deepEqual(first, {operationId:'operation-one', status:'verified', evidenceKind:'synthetic_adapter', reason:'readback_matched'});
  assert.deepEqual(adapter.calls, {observe:1, mutate:1, readback:1, writes:1});
  const latest = await boundary.observe();
  const uploaded = await boundary.execute(mutation(latest, {operationId:'operation-upload', kind:'upload',
    controlId:'resume.file', valueRef:'resume.selected'}));
  assert.equal(uploaded.status, 'verified');
  assert.equal(adapter.calls.readback, 2);
  assert.equal(adapter.calls.writes, 2);
  assert.ok(!JSON.stringify([first, uploaded, latest]).includes('fictional@example.invalid'));
  assert.ok(!JSON.stringify([first, uploaded]).includes('profile.email'));
  assert.ok(!JSON.stringify([first, uploaded]).includes('resume.selected'));
});

test('scope/revision changes reject before adapter execution; unseen changes fail conditional mutation', async () => {
  const {boundary, adapter, request} = await setup(), before = adapter.calls;
  for (const key of ['taskId','taskRevision','jobId','attemptRevision','authorizationRevision','observationRevision']) {
    const changed = key.endsWith('Id') ? 'different-id' : '99';
    await rejects(boundary.execute({...request, scope:{...request.scope, [key]:changed}}), 'scope_changed');
  }
  for (const key of ['documentId','formId','origin','controlSetFingerprint']) {
    const changed = key === 'origin' ? 'https://other.invalid' : key === 'controlSetFingerprint' ? '0'.repeat(64) : 'different-id';
    await rejects(boundary.execute({...request, scope:{...request.scope, form:{...request.scope.form, [key]:changed}}}), 'scope_changed');
  }
  assert.deepEqual(adapter.calls, before);
  adapter.replaceForm(observation({form:{...request.scope.form, documentId:'document-replaced'}}));
  const rejected = await boundary.execute(request);
  assert.equal(rejected.status, 'not_applied');
  assert.equal(rejected.reason, 'scope_changed');
  assert.equal(adapter.calls.writes, 0);
  assert.equal(adapter.calls.readback, 0);
  const fresh = await boundary.observe();
  await rejects(boundary.execute({...request, operationId:'new-operation'}), 'scope_changed');
  assert.equal(fresh.form.documentId, 'document-replaced');
});

test('adapter rechecks scope after the asynchronous authority decision', async () => {
  const adapter = new SyntheticBrowserAdapter(observation(), values());
  const authority = {check:async request => {
    adapter.replaceForm(observation({observationRevision:'2'}));
    return allow.check(request);
  }};
  const {boundary, request} = await setup({adapter, authority});
  const result = await boundary.execute(request);
  assert.equal(result.status, 'not_applied');
  assert.equal(result.reason, 'scope_changed');
  assert.equal(adapter.calls.writes, 0);
});

test('replay does not write or read again; operation ID reuse with changed input conflicts', async () => {
  const {boundary, adapter, request} = await setup();
  const original = await boundary.execute(request), before = adapter.calls;
  assert.deepEqual(await boundary.execute(request), original);
  assert.deepEqual(adapter.calls, before);
  await rejects(boundary.execute({...request, valueRef:'other-reference'}), 'operation_conflict');
  await rejects(boundary.execute({...request, scope:{...request.scope, observationRevision:'2'}}), 'operation_conflict');
  assert.deepEqual(adapter.calls, before);
});

test('a revoked trusted authority denies historical replay and new writes', async () => {
  let authorized = true;
  const authority = {check:async request => ({authorized, requestFingerprint:requestFingerprint(request)})};
  const {boundary, adapter, request} = await setup({authority});
  await boundary.execute(request);
  const latest = await boundary.observe(), before = adapter.calls;
  authorized = false;
  await rejects(boundary.execute(request), 'authority_denied');
  await rejects(boundary.execute(mutation(latest, {operationId:'new-operation'})), 'authority_denied');
  assert.deepEqual(adapter.calls, before);
});

test('wrong, missing, malformed and non-fresh readbacks never verify completion', async () => {
  for (const change of [
    () => undefined,
    result => ({...result, effect:'differs'}),
    result => ({...result, effect:'unavailable'}),
    result => ({...result, operationId:'different-operation'}),
    result => ({...result, requestFingerprint:'0'.repeat(64)}),
    result => ({...result, observation:{...result.observation, observationRevision:'1'}}),
    result => ({...result, observation:{...result.observation, observationRevision:'3'}}),
    result => ({...result, observation:{...result.observation, finalAction:'activated'}}),
    result => ({...result, observation:{...result.observation, evidenceKind:'agent_attested_current_attempt'}}),
    result => ({...result, observation:{...result.observation, form:{...result.observation.form, formId:'other-form'}}}),
    result => ({...result, observation:{...result.observation,
      controls:result.observation.controls.map(control => ({...control, state:'empty'}))}}),
  ]) {
    const base = new SyntheticBrowserAdapter(observation(), values());
    const adapter = wrapper(base, {readback:async request => change(await base.readback(request))});
    const {boundary, request} = await setup({adapter});
    assert.equal((await boundary.execute(request)).status, 'uncertain');
    assert.equal(base.calls.writes, 1);
    const fresh = await boundary.observe();
    await rejects(boundary.execute(mutation(fresh, {operationId:'new-operation'})), 'reconciliation_required');
    assert.equal(base.calls.writes, 1);
  }
});

test('write succeeded but response lost: only explicit exact reconciliation resolves uncertainty', async () => {
  const base = new SyntheticBrowserAdapter(observation(), values());
  const adapter = wrapper(base, {mutate:async request => {
    await base.mutate(request);
    throw new Error('PRIVATE timeout after write');
  }});
  const {boundary, request} = await setup({adapter});
  const uncertain = await boundary.execute(request);
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(base.calls.readback, 0);
  assert.deepEqual(await boundary.execute(request), uncertain);
  const fresh = await boundary.observe();
  await rejects(boundary.execute(mutation(fresh, {operationId:'retry-with-new-id'})), 'reconciliation_required');
  const result = await boundary.reconcile(request.operationId);
  assert.equal(result.status, 'verified');
  assert.equal(base.calls.writes, 1);
  assert.equal(base.calls.mutate, 1);
  assert.equal(base.calls.readback, 1);
  assert.deepEqual(await boundary.execute(request), result);
});

test('lost readback can be reconciled without rewriting; absent effect remains blocked', async () => {
  const base = new SyntheticBrowserAdapter(observation(), values());
  let unavailable = true;
  const adapter = wrapper(base, {readback:async request => {
    if (unavailable) throw new Error('readback lost');
    return base.readback(request);
  }});
  const {boundary, request} = await setup({adapter});
  assert.equal((await boundary.execute(request)).status, 'uncertain');
  unavailable = false;
  assert.equal((await boundary.reconcile(request.operationId)).status, 'verified');
  assert.equal(base.calls.writes, 1);
  const noWrite = new SyntheticBrowserAdapter(observation(), values());
  const missing = await setup({adapter:wrapper(noWrite, {mutate:async () => { throw new Error('timeout before write'); }})});
  assert.equal((await missing.boundary.execute(missing.request)).status, 'uncertain');
  assert.equal((await missing.boundary.reconcile(missing.request.operationId)).status, 'uncertain');
  const fresh = await missing.boundary.observe();
  await rejects(missing.boundary.execute(mutation(fresh, {operationId:'blind-retry'})), 'reconciliation_required');
  assert.equal(noWrite.calls.writes, 0);
});

test('concurrent duplicate delivery performs one write and queued input is immutable', async () => {
  const {boundary, adapter, request} = await setup();
  const first = boundary.execute(request), duplicate = boundary.execute(request);
  request.valueRef = 'changed-after-dispatch';
  const [left, right] = await Promise.all([first, duplicate]);
  assert.equal(left.status, 'verified');
  assert.deepEqual(left, right);
  assert.equal(adapter.calls.writes, 1);
  assert.equal(adapter.calls.readback, 1);
  const latest = await boundary.observe();
  const results = await Promise.allSettled([
    boundary.execute(mutation(latest, {operationId:'one'})), boundary.execute(mutation(latest, {operationId:'two'})),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.code, 'scope_changed');
  assert.equal(adapter.calls.writes, 2);
});

test('unknown reference and wrong control kind never write; final controls remain untouched', async () => {
  const {boundary, adapter, request} = await setup();
  await rejects(boundary.execute({...request, kind:'upload'}), 'scope_changed');
  const result = await boundary.execute({...request, valueRef:'missing-reference'});
  assert.equal(result.status, 'not_applied');
  assert.equal(result.reason, 'control_unavailable');
  assert.equal(adapter.calls.writes, 0);
  assert.equal((await boundary.observe()).finalAction, 'untouched');
});

test('closed immutable schema rejects accessors, cycles, large inputs and unsupported provenance', () => {
  const request = mutation(observation());
  let accessed = false;
  const accessor = Object.defineProperty({}, 'kind', {enumerable:true, get() { accessed = true; return 'fill'; }});
  const cyclic = {...request}; cyclic.scope = cyclic;
  for (const raw of [accessor, cyclic, {...request, valueRef:'x'.repeat(65537)}, {...request, valueRef:'file:///private/resume.pdf'}]) {
    assert.throws(() => browserMutation(raw), error => error.code === 'invalid_browser_input');
  }
  assert.equal(accessed, false);
  assert.throws(() => new BrowserBoundary({evidenceKind:'agent_attested_current_attempt'}, allow, binding),
    error => error.code === 'adapter_unavailable');
  const parsed = browserMutation(request);
  assert.throws(() => { parsed.scope.form.formId = 'changed'; }, TypeError);
  assert.equal(requestFingerprint(parsed), requestFingerprint({...request}));
});

test('capacity preserves all operation identities and refuses new writes without adapter calls', async () => {
  const {boundary, adapter} = await setup();
  let first;
  for (let index = 0; index < 64; index++) {
    const request = mutation(await boundary.observe(), {operationId:`operation-${index}`});
    if (index === 0) first = request;
    assert.equal((await boundary.execute(request)).status, 'verified');
  }
  const request = mutation(await boundary.observe(), {operationId:'overflow'}), before = adapter.calls;
  await rejects(boundary.execute(request), 'capacity_reached');
  assert.equal((await boundary.execute(first)).status, 'verified');
  assert.deepEqual(adapter.calls, before);
});
