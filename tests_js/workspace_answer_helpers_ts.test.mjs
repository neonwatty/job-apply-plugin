import assert from 'node:assert/strict';
import test from 'node:test';
import * as source from '../workspace/lib/helpers.js';
import * as target from '../runtime/workspace-ui/lib/answer-view.js';

function observation(api, name, factory) {
  const log = [];
  const args = factory(log);
  try { return { result: api[name](...args), log }; }
  catch (error) { return { error: error.constructor.name, log }; }
}
function compare(name, factory) {
  assert.deepEqual(observation(target, name, factory), observation(source, name, factory), name);
}

test('answer request gates reject stale selections, keys, sequences and generations exactly', () => {
  for (const api of [source, target]) {
    assert.equal(api.answerNeedsFreshConsent(), false);
    assert.equal(api.answerNeedsFreshConsent(undefined, undefined, true), true);
    assert.equal(api.canRefreshAnswerDraft({ key: 'old' }, { key: 'new' }), false);
    assert.equal(api.canRefreshAnswerDraft(null, { key: 'old' }), false);
    assert.equal(api.canRefreshAnswerDraft({ key: 'old' }, null), false);
    assert.equal(api.canApplyAnswerReveal({ key: 'new' }, 'old', { key: 'old' }), false);
    assert.equal(api.canApplyAnswerReveal({ key: 'old' }, 'old', { key: 'new' }), false);
    assert.equal(api.canApplyAnswerReveal({ key: 'old' }, 'new', { key: 'old' }), false);
    assert.equal(api.canApplyAnswerReveal(null, 'old', { key: 'old' }), false);
    assert.equal(api.canApplyAnswerReveal({ key: 'old' }, 'old', null), false);
    assert.equal(api.canApplyAnswerDialogResponse({ key: 'new' }, 'old', 1, 1), false);
    assert.equal(api.canApplyAnswerDialogResponse({ key: 'old' }, 'new', 1, 1), false);
    assert.equal(api.canApplyAnswerDialogResponse({ key: 'old' }, 'old', 1, 2), false);
    assert.equal(api.canApplyAnswerDialogResponse({ key: 'old' }, 'old', 1, '1'), false);
    assert.equal(api.canApplyAnswerDialogMutation({ key: 'new' }, 'old', 1, 1), false);
    assert.equal(api.canApplyAnswerDialogMutation({ key: 'old' }, 'new', 1, 1), false);
    assert.equal(api.canApplyAnswerDialogMutation({ key: 'old' }, 'old', 1, 2), false);
    assert.equal(api.canApplyAnswerDialogMutation({ key: 'old' }, 'old', 1, '1'), false);
    assert.equal(api.canApplyAnswerDialogMutation(null, 'old', 1, 1), false);
    for (const closed of [false, 0, '', null]) {
      assert.equal(api.canApplyAnswerDialogResponse({ key: 'old' }, 'old', 1, 1, closed), false);
      assert.equal(api.canApplyAnswerDialogMutation({ key: 'old' }, 'old', 1, 1, closed), closed);
    }
  }
});

test('answer TS covers all nine reference exports across ordinary and coercive inputs', () => {
  const values = [undefined, null, false, true, 0, -0, NaN, '', 'a', 1, 1n, Symbol('synthetic')];
  for (const value of values) {
    compare('answerNeedsFreshConsent', () => [value, value, value]);
    compare('answerSummary', () => [{ valueRedacted: value, hasValue: !value }]);
    compare('canRevealAnswer', () => [{ valueRedacted: true, deletedAt: value }]);
    compare('canRefreshAnswerDraft', () => [{ key: value }, { key: value }]);
    compare('canApplyAnswerReveal', () => [{ key: value }, value, { key: value, redirectedFrom: value }]);
    compare('canApplyAnswerDialogResponse', () => [{ key: value }, value, value, value, value]);
    compare('canApplyAnswerDialogMutation', () => [{ key: value }, value, value, value, value]);
    compare('answerApiPath', () => [value, value]);
    compare('sameAnswerScope', () => [value, {}]);
  }
  for (const value of [null, undefined, {}, [], Object.create(null)]) {
    compare('answerSummary', () => [value]);
    compare('canRevealAnswer', () => [value]);
    compare('canRefreshAnswerDraft', () => [value, {}]);
    compare('canApplyAnswerReveal', () => [value, null, value]);
  }
  for (const key of ['é😀', '\ud800', 'a/b?', '', '日本語']) compare('answerApiPath', () => [key, '../synthetic?x']);
});

test('answer TS preserves getter access order, short circuits and coercion errors', () => {
  const names = ['answerSummary', 'canRevealAnswer', 'canRefreshAnswerDraft', 'canApplyAnswerReveal',
    'canApplyAnswerDialogResponse', 'canApplyAnswerDialogMutation'];
  for (const name of names) for (const stop of ['', 'key', 'deletedAt', 'hasValue', 'redirectedFrom']) {
    compare(name, (log) => {
      const record = (label) => new Proxy({}, { get(_object, key) {
        log.push(`${label}:${String(key)}`);
        if (key === stop) throw new RangeError('synthetic');
        return key === 'key' ? 'a' : key === 'deletedAt' ? null : false;
      } });
      if (name === 'canRefreshAnswerDraft') return [record('first'), record('second')];
      if (name === 'canApplyAnswerReveal') return [record('first'), 'a', record('second')];
      if (name.includes('Dialog')) return [record('first'), 'a', 1, 1, true];
      return [record('first')];
    });
  }
  for (const fail of [false, true]) compare('answerApiPath', (log) => [{ [Symbol.toPrimitive](hint) {
    log.push(hint);
    if (fail) throw new TypeError('synthetic');
    return 'é';
  } }, 'reveal']);
});

test('answer TS scope retains JS JSON semantics, getter order, toJSON and failures', () => {
  for (const factory of [
    () => [{ b: { z: 1, a: [2, 3] }, a: null }, { a: null, b: { a: [2, 3], z: 1 } }],
    () => [[, 1], [null, 1]], () => [{ a: undefined }, {}],
    () => [{ a: NaN, b: -0 }, { a: null, b: 0 }],
    () => [new Date(0), {}], () => [Object.create({ inherited: 1 }), {}],
    () => [{ a: 1n }, {}],
    () => { const cycle = {}; cycle.self = cycle; return [cycle, {}]; },
    (log) => [{ get b() { log.push('b'); return 2; }, get a() { log.push('a'); return 1; } }, { a: 1, b: 2 }],
    (log) => [{ get a() { log.push('a'); throw new RangeError('synthetic'); } }, {}],
    (log) => [{ toJSON(key) { log.push(`toJSON:${key}`); return { converted: true }; } }, { converted: true }],
    (log) => { const array = [1]; array.map = function(callback) { log.push('custom-map'); return [callback(2)]; }; return [array, [2]]; },
  ]) compare('sameAnswerScope', factory);
  const frozen = Object.freeze({ a: Object.freeze([1, 2]) });
  assert.equal(target.sameAnswerScope(frozen, { a: [1, 2] }), true);
  assert.deepEqual(frozen, { a: [1, 2] });
});
