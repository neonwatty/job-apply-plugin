import assert from 'node:assert/strict';
import test from 'node:test';
import * as source from '../workspace/lib/helpers.js';
import * as target from '../runtime/workspace-ui/lib/activity-view.js';

function observe(api, name, factory) {
  const log = [];
  const args = factory(log);
  try {
    const result = api[name](...args);
    if (name === 'newestCanonicalJob') return { identity: result === args[0] ? 'current' : result === args[1] ? 'incoming' : 'other', log };
    if (name === 'filterJobs' && Array.isArray(args[0]) && Array.isArray(result)) return { indices: result.map((item) => args[0].indexOf(item)), log };
    return { result, log };
  } catch (error) { return { error: error.constructor.name, log }; }
}
function compare(name, factory) { assert.deepEqual(observe(target, name, factory), observe(source, name, factory), name); }

test('activity gates retain absent job results and suppress unchanged queue membership', () => {
  for (const api of [source, target]) {
    assert.equal(api.newestCanonicalJob(undefined, undefined), undefined);
    assert.equal(api.newestCanonicalJob(null, null), null);
    assert.equal(api.newestCanonicalJob(null, undefined), undefined);
    assert.equal(api.newestCanonicalJob(undefined, null), null);
    assert.equal(api.shouldUseActivityResponse(undefined, undefined, null), false);
    assert.equal(api.attentionAnnouncement({ items: [] }, { items: [] }), '');
    assert.equal(api.attentionAnnouncement(
      { items: [{ jobId: 'a', reasonCode: 'needs_information', label: 'before' }] },
      { items: [{ jobId: 'a', reasonCode: 'needs_information', label: 'after' }] },
    ), '');
    assert.equal(api.attentionAnnouncement(
      { items: [{ jobId: 'a', reasonCode: 'needs_information' }] },
      { items: [{ jobId: 'a', reasonCode: 'browser_action_required' }] },
    ), 'Needs Attention queue updated. 1 job now require action.');
  }
});

test('activity TS covers twelve exports with ordinary, missing and invalid inputs', () => {
  for (const status of ['saved', 'needs_info', 'ready', 'in_progress', 'awaiting_review', 'applied', 'closed', 'unknown', null, '__proto__', 'toString']) {
    compare('transitionsFor', () => [status]);
    compare('canMarkReadyFrom', () => [status]);
    compare('filterJobs', () => [[{ status, role: 'Engineer', company: 'Synthetic' }, { status: 'saved', role: 123 }], ' eng ', status]);
  }
  for (const action of ['import_resume', 'review_facts', 'resolve_attention', 'handoff_ready_job', 'capture_job', 'prepare_job', '__proto__', 'constructor', null]) {
    compare('ownerBetaNextStep', () => [action]);
  }
  for (const revision of [undefined, null, -2, 0, 1, 2, 1.5, '2', NaN, Infinity]) {
    compare('shouldUseActivityResponse', () => [{ job: { revision } }, { revision: 1 }, { revision: '99' }]);
    compare('newestCanonicalJob', () => [{ id: 'a', revision: 1 }, { id: 'a', revision }]);
  }
  for (const value of [null, undefined, {}, { job: { status: 'saved' } }, { history: [1n] }]) {
    compare('activitySignature', () => [value]);
    compare('activityAnnouncement', () => [{ job: { status: 'saved' } }, value]);
    compare('attentionMembershipSignature', () => [value]);
    compare('attentionAnnouncement', () => [{ items: [{}] }, value]);
    compare('attentionMissingInformationText', () => [value]);
    compare('attentionBlockerSummary', () => [value]);
  }
  compare('activityAnnouncement', () => [{ job: { status: 'saved' }, history: [] },
    { job: { status: 'needs_info' }, claim: { state: 'active' }, session: { updatedAt: 'now', step: 'review' }, history: [{}] }]);
  for (const count of [-2, 0, 1, '1', Infinity]) compare('attentionMissingInformationText', () => [{ reasonCode: 'needs_information', missingInformationCount: count }]);
  for (const reason of ['browser_action_required', 'other']) compare('attentionBlockerSummary', () => [{ reasonCode: reason,
    session: { blockers: [{ type: 'browser_handoff', code: 'unsupported-control' }, { type: 'information', code: 'owner-input-required' }] } }]);
});

test('activity TS preserves custom callbacks/returns, access order and thrown errors', () => {
  for (const name of ['transitionsFor', 'ownerBetaNextStep']) compare(name, (log) => [{ [Symbol.toPrimitive](hint) { log.push(hint); return 'toString'; } }]);
  for (const fail of [false, true]) compare('filterJobs', (log) => [{ filter(callback) {
    log.push('filter');
    if (fail) throw new RangeError('synthetic');
    return callback({ role: 'job' }) ? 'custom-result' : 'no';
  } }, 'job']);
  compare('filterJobs', (log) => [[{ status: 'closed', get role() { log.push('role'); throw Error('unused'); } }], 'job', 'saved']);
  compare('attentionMembershipSignature', (log) => [{ items: { map(callback) {
    log.push('map'); return [callback({ jobId: 'j', reasonCode: 'x' })];
  } } }]);
  for (const name of ['activitySignature', 'attentionBlockerSummary', 'attentionMissingInformationText', 'shouldUseActivityResponse']) {
    for (const stop of ['', 'job', 'session', 'reasonCode']) compare(name, (log) => [new Proxy({}, {
      get(_target, key) { log.push(String(key)); if (key === stop) throw new TypeError('synthetic'); return undefined; },
    })]);
  }
  for (const items of [[null], [undefined], {}, 'bad']) {
    compare('attentionMembershipSignature', () => [{ items }]);
    compare('attentionBlockerSummary', () => [{ session: { blockers: items } }]);
  }
});

test('activity TS retains array/record identities and avoids mutating frozen inputs', () => {
  const first = Object.freeze({ role: 'job', status: 'saved' });
  const second = Object.freeze({ role: 'other', status: 'saved' });
  const jobs = Object.freeze([first, , second]);
  const result = target.filterJobs(jobs, 'job');
  assert.equal(result[0], first);
  assert.notEqual(result, jobs);
  assert.equal(1 in jobs, false);
  const incoming = Object.freeze({ id: 'a', revision: 1 });
  assert.equal(target.newestCanonicalJob(Object.freeze({ id: 'a', revision: 1 }), incoming), incoming);
  for (const api of [source, target]) {
    const firstTransitions = api.transitionsFor('saved');
    assert.notEqual(firstTransitions, api.transitionsFor('saved'));
    const firstStep = api.ownerBetaNextStep('import_resume');
    assert.notEqual(firstStep, api.ownerBetaNextStep('import_resume'));
  }
});
