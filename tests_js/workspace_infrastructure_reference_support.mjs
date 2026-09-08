import assert from 'node:assert/strict';
import * as api from '../workspace/lib/api.js';
import { createWorkspaceState, createCoordinators } from '../workspace/lib/state.js';
import { createDom } from '../workspace/lib/dom.js';
import { fileToBase64 } from '../workspace/lib/helpers.js';

function globals(values, body) {
  const saved = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  return Promise.resolve().then(body).finally(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
}

export function errorsReference() {
  const empty = new api.ApiError(418, null);
  assert.equal(empty.message, 'Workspace request failed (418)');
  assert.deepEqual([empty.status, empty.code, empty.recordType, empty.operation, empty.counts], [418, 'request_error', null, null, {}]);
  const counts = { protected: 2 }, recordType = {}, operation = [];
  const conflict = new api.ApiError(409, { error: { message: 'changed', code: 'revision_conflict', counts, recordType, operation } });
  assert.equal(conflict.message, 'changed');
  assert.equal(conflict.counts, counts); assert.equal(conflict.recordType, recordType); assert.equal(conflict.operation, operation);
  assert.equal(api.FACT_SAVE_REVISION_RETRIES, 2);
  assert.deepEqual([0, 1, 2, '1'].map(n => api.shouldRetryFactSave(conflict, n)), [true, true, false, true]);
  assert.equal(api.shouldRetryFactSave(conflict, 2, 3), true);
  assert.equal(api.shouldRetryFactSave({ status: 409, code: 'revision_conflict' }, 0), false);
  assert.equal(api.shouldRetryFactSave(new api.ApiError(500, { error: { code: 'revision_conflict' } }), 0), false);
  const failure = {}; assert.throws(() => new api.ApiError(400, { get error() { throw failure; } }), e => e === failure);
}

export function storageReference() {
  assert.equal(api.tokenFromHash('#token=a+b&token=second'), 'a b');
  assert.equal(api.tokenFromHash({ toString() { return '#token=%E2%98%83'; } }), '☃');
  assert.equal(api.tokenFromHash(0), '');
  const log = [], storage = {
    setItem(key, value) { log.push(['set', key, value]); },
    getItem(key) { log.push(['get', key]); return 'retained'; },
  };
  assert.equal(api.sessionToken('#token=fresh', storage), 'fresh');
  assert.deepEqual(log, [['set', 'jobApplyWorkspaceToken', 'fresh']]);
  assert.equal(api.sessionToken('', storage), 'retained');
  assert.deepEqual(log[1], ['get', 'jobApplyWorkspaceToken']);
  assert.equal(api.sessionToken('#token=fallback', { setItem() { throw Error('denied'); } }), 'fallback');
  assert.equal(api.sessionToken('', { getItem() { throw Error('denied'); } }), '');
  assert.equal(api.safeSessionStorage({ get sessionStorage() { throw Error('denied'); } }), null);
  assert.equal(api.safeSessionStorage({ sessionStorage: storage }), storage);
}

export async function fetchReference() {
  const signal = {}, body = {}, response = { synthetic: true }, calls = [];
  const fetch = async (path, options) => { calls.push([path, options]); return { ok: true, json: async () => response }; };
  const client = api.createApi('token', fetch);
  assert.equal(await client('/synthetic', { headers: { Authorization: 'override', 'Content-Type': 'text/plain' }, body, signal }), response);
  assert.deepEqual(calls[0], ['/synthetic', { headers: { Authorization: 'override', 'Content-Type': 'application/json' }, body, signal }]);
  assert.equal(calls[0][1].signal, signal); assert.equal(calls[0][1].body, body);
  await client('/empty'); assert.deepEqual(calls[1][1], { headers: { Authorization: 'Bearer token' } });
  assert.equal(await api.createApi('', async () => ({ ok: true, json() { throw Error('invalid'); } }))('/'), null);
  await assert.rejects(api.createApi('', async () => ({ ok: false, status: 403, json() { throw Error('invalid'); } }))('/'),
    e => e instanceof api.ApiError && e.message === 'Workspace request failed (403)');
  const failure = {}; await assert.rejects(api.createApi('', async () => { throw failure; })('/'), e => e === failure);
  await globals({ fetch }, async () => {
    const captured = api.createApi('captured');
    globalThis.fetch = () => { throw Error('wrong fetch'); };
    assert.equal(await captured('/captured'), response);
  });
}

export async function coordinatorReference() {
  const c = api.createLatestRequestCoordinator(), log = [];
  let resolve, reject;
  const old = c.run(() => new Promise(r => { resolve = r; }), v => log.push(v), e => log.push(e));
  assert.equal(await c.run(async () => 'new', v => log.push(v), e => log.push(e)), true);
  resolve('old'); assert.equal(await old, false); assert.deepEqual(log, ['new']);
  const failed = c.run(() => new Promise((_r, j) => { reject = j; }), v => log.push(v), e => log.push(e));
  c.invalidate(); reject('stale'); assert.equal(await failed, false); assert.deepEqual(log, ['new']);
  const failure = {}, callback = {};
  assert.equal(await c.run(() => { throw failure; }, () => assert.fail(), e => assert.equal(e, failure)), true);
  assert.equal(await c.run(async () => 1, () => { throw callback; }, e => assert.equal(e, callback)), true);
  await assert.rejects(c.run(async () => { throw failure; }, () => assert.fail(), () => { throw callback; }), e => e === callback);
  assert.equal(await c.run(async () => 1, () => new Promise(() => {}), () => assert.fail()), true);
  const pair = createCoordinators();
  assert.deepEqual(Object.keys(pair), ['trashRefreshCoordinator', 'activityRefreshCoordinator', 'attentionRefreshCoordinator', 'overviewRefreshCoordinator']);
  const pending = pair.trashRefreshCoordinator.run(async () => 1, () => {}, () => assert.fail());
  pair.activityRefreshCoordinator.invalidate(); assert.equal(await pending, true);
}

export function stateReference() {
  const s = createWorkspaceState(), fresh = createWorkspaceState();
  const expected = {
    job: {
      jobs: [], activeJobsLoaded: false, resumes: [], selected: null, latest: null,
      draft: null, dirty: false, dirtyFields: new Set(), refreshPromise: null,
      refreshEpoch: 0, canonicalStateCurrent: false, pollIntervalId: null,
      opener: null, openerJobId: null, focusAfterClose: null, focusAfterCloseJobId: null,
      activity: null, activityJobId: null, activityUnavailable: false, attentionReturnJobId: null,
      navigationGeneration: 0, jobDialogGeneration: 0, dependencyObservation: 0,
      preflightRequestSequence: 0, preflightPolling: false, preflightError: null, readyHandoffProof: null,
      groupedApprovalPreview: null, groupedApprovalRequest: null, groupedApprovalProjectionSignature: null, groupedApprovalRequestSequence: 0,
    },
    profile: { inspection: null, preparedness: null, drafts: new Map(), draftBases: new Map(), atomic: new Set(), additionalAtomic: new Set(), deletions: new Set(), conflicts: [], latest: null, loaded: false },
    factGroup: { items: [], selectedView: 'all', selected: null, editing: null, loaded: false, opener: null, requestSequence: 0 },
    resume: { items: [], proposals: [], trash: false, loaded: false, loading: false, requestId: 0, selected: null, opener: null, proposal: null, dirtyMetadata: new Set(), pendingReview: null },
    answer: { items: [], loaded: false, selected: null, offset: 0, limit: 25, total: 0, dirty: new Set(), opener: null, pendingJobId: null, pendingReference: null, requestSequence: 0, detailRequestSequence: 0, dialogGeneration: 0, mergeRequestSequence: 0, mergeSource: null, mergeCandidates: [], cleanupPreview: null, busyControls: null },
    trash: { items: [], counts: { job: 0, resume: 0, answer: 0 }, loaded: false, selected: null, opener: null },
    attention: { items: [], snapshotSignature: '', loaded: false, unavailable: false, detailRequestSequence: 0 },
    overview: { projection: null, available: false, degraded: false, unavailable: false },
    automation: { projection: null, loaded: false }, accountOperation: { status: null }, trustedFill: { status: null },
    jobCardRenderKeys: new WeakMap(), copyInvocationSequences: new WeakMap(),
  };
  const enumerableState = value => Object.fromEntries(Object.entries(value).filter(([, item]) => !(item instanceof WeakMap)));
  assert.deepEqual(enumerableState(s), enumerableState(expected));
  assert.ok(s.jobCardRenderKeys instanceof WeakMap); assert.ok(s.copyInvocationSequences instanceof WeakMap);
  function independent(left, right, wanted) {
    assert.notEqual(left, right);
    assert.deepEqual(Object.keys(left), Object.keys(wanted));
    for (const key of Object.keys(left)) if (left[key] && typeof left[key] === 'object') independent(left[key], right[key], wanted[key]);
  }
  independent(s, fresh, expected);
  const key = {}; s.jobCardRenderKeys.set(key, 1); s.copyInvocationSequences.set(key, 2);
  assert.equal(fresh.jobCardRenderKeys.has(key), false); assert.equal(fresh.copyInvocationSequences.has(key), false);
  s.profile.drafts.set('x', 1); s.job.dirtyFields.add('x'); s.job.jobs.push({});
  assert.equal(fresh.profile.drafts.size, 0); assert.equal(fresh.job.dirtyFields.size, 0); assert.equal(fresh.job.jobs.length, 0);
}

export async function domReference() {
  const log = [], timers = new Map(), nodes = new Map(); let sequence = 0;
  for (const selector of ['#job-form', '#job-dialog', '#toast', '#connection-dot', '#connection-label']) {
    nodes.set(selector, { textContent: '', classList: {
      remove(value) { log.push(['remove', selector, value]); }, add(value) { log.push(['add', selector, value]); },
      toggle(value, flag) { log.push(['toggle', selector, value, flag]); },
    } });
  }
  await globals({ document: { querySelector(selector) { log.push(['query', selector]); return nodes.get(selector); } },
    clearTimeout(id) { log.push(['clear', id]); timers.delete(id); },
    setTimeout(fn, ms) { log.push(['timer', ms]); timers.set(++sequence, fn); return sequence; } }, () => {
    const state = { overview: { unavailable: false } }, token = {}, dom = createDom(state, token);
    assert.deepEqual(log, [['query', '#job-form'], ['query', '#job-dialog']]);
    assert.equal(dom.form, nodes.get('#job-form')); assert.equal(dom.dialog, nodes.get('#job-dialog')); assert.equal(dom.token, token);
    assert.equal(dom.statusLabel(0), 'saved'); assert.equal(dom.statusLabel('needs_info'), 'needs info'); assert.equal(dom.escapeText(null), '');
    log.length = 0; dom.toast('first'); dom.toast('second');
    assert.deepEqual(log, [['query', '#toast'], ['remove', '#toast', 'hidden'], ['clear', undefined], ['timer', 3500],
      ['query', '#toast'], ['remove', '#toast', 'hidden'], ['clear', 1], ['timer', 3500]]);
    assert.equal(nodes.get('#toast').textContent, 'second'); assert.equal(timers.has(1), false);
    timers.get(2)(); assert.deepEqual(log.at(-1), ['add', '#toast', 'hidden']);
    log.length = 0; state.overview.unavailable = true; dom.setConnection(true); assert.deepEqual(log, []);
    dom.setConnection(false); assert.equal(nodes.get('#connection-label').textContent, 'Connection lost');
    state.overview.unavailable = false; dom.setConnection(true); assert.equal(nodes.get('#connection-label').textContent, 'Canonical store connected');
    const failure = {}; globalThis.document = { querySelector() { throw failure; } };
    assert.throws(() => dom.$('#synthetic'), e => e === failure);
  });
}

export async function fileReference() {
  const events = [], listeners = new Map(), file = {}, failure = {};
  let reader;
  class Reader {
    constructor() { reader = this; events.push('construct'); }
    addEventListener(name, callback) { events.push(name); listeners.set(name, callback); }
    readAsDataURL(value) { assert.equal(value, file); events.push('read'); }
  }
  await globals({ FileReader: Reader }, async () => {
    const success = fileToBase64(file);
    assert.deepEqual(events, ['construct', 'load', 'error', 'read']);
    reader.result = 'data:application/octet-stream;base64,AP+A,discarded'; listeners.get('load')();
    assert.equal(await success, 'AP+A');
    const missing = fileToBase64(file); reader.result = null; listeners.get('load')(); assert.equal(await missing, '');
    const failed = fileToBase64(file); listeners.get('error')();
    await assert.rejects(failed, e => e instanceof Error && e.message === 'The selected file could not be read.');
    Reader.prototype.readAsDataURL = () => { throw failure; };
    await assert.rejects(fileToBase64(file), e => e === failure);
    globalThis.FileReader = class { constructor() { throw failure; } };
    await assert.rejects(fileToBase64(file), e => e === failure);
  });
}
