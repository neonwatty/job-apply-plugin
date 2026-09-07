import assert from 'node:assert/strict';
import test from 'node:test';
import * as h from '../workspace/lib/helpers.js';

test('answer reference: consent and summary retain truthiness and precedence', () => {
  assert.equal(h.answerNeedsFreshConsent('ordinary', 'none', true), false);
  assert.equal(h.answerNeedsFreshConsent('sensitive', 'none', 'value'), true);
  assert.equal(h.answerNeedsFreshConsent('ordinary', undefined, 1), true);
  assert.equal(h.answerNeedsFreshConsent('sensitive', 'secret', 0), false);
  assert.equal(h.answerSummary({ valueRedacted: 'yes', hasValue: true }), 'Sensitive value hidden — reveal explicitly to view');
  assert.equal(h.answerSummary({ hasValue: [] }), 'Value retained');
  assert.equal(h.answerSummary({}), 'No retained value');
  assert.throws(() => h.answerSummary(null), TypeError);
  assert.equal(h.canRevealAnswer({ valueRedacted: true }), true);
  assert.equal(h.canRevealAnswer({ valueRedacted: true, deletedAt: null }), true);
  assert.equal(h.canRevealAnswer({ valueRedacted: true, deletedAt: '' }), false);
  assert.equal(h.canRevealAnswer(null), false);
});

test('answer reference: identity and request gates preserve strict comparison and short circuits', () => {
  assert.equal(h.canRefreshAnswerDraft({}, {}), true);
  assert.equal(h.canRefreshAnswerDraft(null, {}), false);
  assert.equal(h.canRefreshAnswerDraft({ key: 1 }, { key: '1' }), false);
  assert.equal(h.canApplyAnswerReveal({ key: 'a' }, 'a', { key: 'a' }), true);
  assert.equal(h.canApplyAnswerReveal({ key: 'a' }, 'a', { key: 'a', redirectedFrom: [] }), false);
  assert.equal(h.canApplyAnswerReveal({ key: 'a' }, 'b', { get key() { throw Error('unused'); } }), false);
  assert.equal(h.canApplyAnswerDialogResponse({ key: 'a' }, 'a', 1, 1), true);
  assert.equal(h.canApplyAnswerDialogResponse({ key: 'a' }, 'a', 1, '1'), false);
  assert.equal(h.canApplyAnswerDialogResponse(null, 'a', 1, 1, false), false);
  assert.equal(h.canApplyAnswerDialogMutation(null, null, 2, 2), true);
  assert.equal(h.canApplyAnswerDialogMutation({}, undefined, 2, 2), false);
  assert.equal(h.canApplyAnswerDialogMutation({ key: 'a' }, 'a', 2, 2, 0), 0);
  assert.equal(h.canApplyAnswerDialogMutation({ key: 'a' }, 'a', 2, 2, ''), '');
});

test('answer reference: API keys use UTF8 URL-safe base64 and unescaped action suffix', () => {
  assert.equal(h.answerApiPath('a/b?'), '/api/answers/by-key/YS9iPw');
  assert.equal(h.answerApiPath('é😀', 'reveal'), '/api/answers/by-key/w6nwn5iA/reveal');
  assert.equal(h.answerApiPath('\ud800'), '/api/answers/by-key/77-9');
  assert.equal(h.answerApiPath(''), '/api/answers/by-key/');
  assert.equal(h.answerApiPath(null, '../synthetic?x'), '/api/answers/by-key/bnVsbA/../synthetic?x');
  assert.equal(h.answerApiPath(0, 0), '/api/answers/by-key/MA');
  assert.throws(() => h.answerApiPath(Object.create(null)), TypeError);
});

test('answer reference: scope comparison preserves JSON coercions and never promises Python equivalence', () => {
  const left = Object.freeze({ b: Object.freeze({ z: 1, a: [2, 3] }), a: null });
  assert.equal(h.sameAnswerScope(left, { a: null, b: { a: [2, 3], z: 1 } }), true);
  assert.equal(h.sameAnswerScope({ a: [1, 2] }, { a: [2, 1] }), false);
  assert.equal(h.sameAnswerScope(false, null), true);
  assert.equal(h.sameAnswerScope({ a: undefined }, {}), true);
  assert.equal(h.sameAnswerScope({ a: NaN }, { a: null }), true);
  assert.equal(h.sameAnswerScope({ a: -0 }, { a: 0 }), true);
  assert.equal(h.sameAnswerScope([, 1], [null, 1]), true);
  assert.equal(h.sameAnswerScope(new Date(0), {}), true);
  assert.equal(h.sameAnswerScope(Object.create({ a: 1 }), {}), true);
  assert.throws(() => h.sameAnswerScope({ a: 1n }, {}), TypeError);
  const cyclic = {}; cyclic.a = cyclic;
  assert.throws(() => h.sameAnswerScope(cyclic, {}), RangeError);
  assert.deepEqual(left, { b: { z: 1, a: [2, 3] }, a: null });
});
