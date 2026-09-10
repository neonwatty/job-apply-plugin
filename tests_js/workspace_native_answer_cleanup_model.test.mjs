import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../apps/companion/components/answer-cleanup-model.ts', import.meta.url), 'utf8');
const emitted = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
  .replaceAll('../../../src/contracts/workspace/values', new URL('../runtime/contracts/workspace/values.js', import.meta.url).href);
const model = await import(`data:text/javascript;base64,${Buffer.from(emitted).toString('base64')}`);
const pair = {
  winnerKey: 'accepted', duplicateKey: 'pending', confidenceBand: 'exact',
  reasonCodes: ['match_exact_question', 'cleanup_merge_proposed'],
  winnerRevision: 1, duplicateRevision: 2,
  winnerQuestion: 'Work authorization?', duplicateQuestion: 'Work authorization?',
};
const response = proposals => ({ proposals, previewToken: `answer-cleanup-v1.${'a'.repeat(64)}`, mutated: false });

test('cleanup preview accepts empty results and preserves lossless positive revisions', () => {
  assert.deepEqual(model.cleanupPreview(JSON.stringify(response([]))), { previewToken: response([]).previewToken, pairs: [] });
  const raw = JSON.stringify(response([pair])).replace('"winnerRevision":1', '"winnerRevision":9007199254740993');
  const result = model.cleanupPreview(raw).pairs;
  assert.equal(result[0].winnerRevision, 9007199254740993n);
  assert.equal(result[0].duplicateRevision, 2n);
  assert.equal('previewToken' in result[0], false);
  assert.match(model.cleanupExplanation(result[0]), /matches exactly/);
  assert.match(model.cleanupExplanation({ ...result[0], confidenceBand: 'high' }), /similarity in meaning/);
});

test('cleanup preview rejects open or malformed response envelopes without returning partial results', () => {
  for (const invalid of [
    null, [], {}, { ...response([]), extra: true }, { ...response([]), mutated: true },
    { ...response([]), mutated: null }, { ...response([]), proposals: {} },
    { ...response([]), previewToken: 'answer-cleanup-v1.short' },
    { ...response([]), previewToken: `answer-cleanup-v1.${'a'.repeat(64)}\n` },
    { ...response([]), previewToken: null },
  ]) assert.throws(() => model.cleanupPreview(JSON.stringify(invalid)));
  assert.throws(() => model.cleanupPreview('{broken'));
});

test('cleanup proposal closed shape rejects values, missing fields, nonstrings and invalid confidence', () => {
  const missing = { ...pair };
  delete missing.winnerQuestion;
  for (const invalid of [null, missing, { ...pair, value: 'private' },
    ...['winnerKey', 'duplicateKey', 'winnerQuestion', 'duplicateQuestion'].map(field => ({ ...pair, [field]: 7 })),
    ...['none', 'uncertain', null].map(confidenceBand => ({ ...pair, confidenceBand })),
    { ...pair, reasonCodes: 'match_exact_question' }, { ...pair, reasonCodes: [null] },
  ]) assert.throws(() => model.cleanupPreview(JSON.stringify(response([pair, invalid]))));
});

test('cleanup revisions reject boolean, float, exponent, string, zero and negative forms', () => {
  for (const field of ['winnerRevision', 'duplicateRevision']) {
    for (const invalid of ['true', '1.0', '1e1', '"1"', '0', '-1', 'null']) {
      const raw = JSON.stringify(response([pair])).replace(new RegExp(`"${field}":\\d+`), `"${field}":${invalid}`);
      assert.throws(() => model.cleanupPreview(raw), `${field}=${invalid}`);
    }
  }
});


test('cleanup approval has the exact owner-confirmed shape and lossless revisions', () => {
  const raw = JSON.stringify(response([pair])).replace('"winnerRevision":1', '"winnerRevision":9007199254740993');
  const preview = model.cleanupPreview(raw);
  const body = model.cleanupApproval(preview, preview.pairs[0]);
  assert.match(body, /"winnerRevision":9007199254740993/);
  const decoded = JSON.parse(body);
  assert.deepEqual(Object.keys(decoded).sort(), ['approval', 'ownerConfirmed']);
  assert.equal(decoded.ownerConfirmed, true);
  assert.deepEqual(Object.keys(decoded.approval).sort(), [
    'duplicateKey', 'duplicateRevision', 'previewToken', 'winnerKey', 'winnerRevision',
  ]);
  assert.equal(decoded.approval.previewToken, response([]).previewToken);
  assert.equal(decoded.approval.winnerKey, 'accepted');
  assert.equal(decoded.approval.duplicateKey, 'pending');
  assert.equal(decoded.approval.duplicateRevision, 2);
  assert.throws(() => model.cleanupApproval(preview, { ...preview.pairs[0] }));
});

test('cleanup approval requires a successful persisted answer response', () => {
  assert.equal(model.cleanupApproved('{"approved":true,"result":{"revision":9007199254740993}}'), undefined);
  for (const invalid of [null, {}, { approved: false, result: { revision: 1 } },
    { approved: true, result: {} }, { approved: true, result: { revision: 0 } },
    { approved: true, result: { revision: 1 }, extra: true },
  ]) assert.throws(() => model.cleanupApproved(JSON.stringify(invalid)));
});
