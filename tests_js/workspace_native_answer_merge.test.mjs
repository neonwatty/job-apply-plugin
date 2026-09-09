import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { applyAnswerMerge } from '../runtime/contracts/workspace/answer-merge.js';
import { answerKey } from '../runtime/contracts/workspace/answers.js';
import { fromJSON, parse, serialize } from '../runtime/contracts/workspace/values.js';

const at = '2026-09-09T10:00:00Z';
const plain = value => JSON.parse(serialize(value));
const record = (key, question, extra = {}) => ({ key, question, state: 'confirmed', value: `${key}-private`, updatedAt: at, ...extra });
const operation = (extra = {}) => ({ winnerKey: 'winner', sourceKey: 'source', expectedWinnerRevision: 1, expectedSourceRevision: 1, at, ...extra });
const fixture = (winner = {}, source = {}, extra = {}) => ({
  document: { schemaVersion: 1, answers: {
    winner: record('winner', 'Preferred editor?', winner),
    source: record('source', 'Editor preference?', source),
  }, metadata: { updatedAt: 'before' }, redirects: {}, ...extra },
  operation: operation(),
});
function native(input) {
  const document = parse(JSON.stringify(input.document));
  try {
    const result = applyAnswerMerge(document, fromJSON(input.operation));
    return { result: plain(result), document: plain(document) };
  } catch (error) { return { error: error.message }; }
}
function python(fixtures) {
  const run = spawnSync('python3', ['-c', String.raw`
import json,sys
sys.path.insert(0,'scripts')
from job_apply_store.domains.answers.merge import AnswerMergeMixin
from job_apply_store.domains.answers.mutations import AnswerMutationMixin
from job_apply_store.domains.answers.read import AnswerReadMixin
class Oracle(AnswerMergeMixin,AnswerMutationMixin,AnswerReadMixin): pass
results=[]
for item in json.load(sys.stdin):
 try:
  result=Oracle()._apply_answer_merge_locked(item['document'],item['operation'])
  results.append({'result':result,'document':item['document']})
 except Exception as error: results.append({'error':str(error)})
print(json.dumps(results))
`], { cwd: new URL('..', import.meta.url), input: JSON.stringify(fixtures), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test('answer merge matches Python alias, observation, scope, collision and redirect behavior', () => {
  const fixtures = [
    fixture(),
    fixture({ aliases: ['IDE', 'preferred editor'], observationCount: 2, observedAt: '2026-02', lastObservedAt: '2026-06' },
      { aliases: ['ide', ' Editor Preference! ', 'Editor', '!!!', ''], observationCount: 5, observedAt: '2026-01', lastObservedAt: '2026-09', reviewStatus: 'pending' }),
    fixture({ question: ' \u001c', aliases: ['WINNER'], observedAt: '', lastObservedAt: null }, { question: null, aliases: ['OTHER'] }),
    fixture({ observedAt: '\u{10000}', lastObservedAt: '\ue000' }, { observedAt: '\ue000', lastObservedAt: '\u{10000}' }),
    fixture({ scope: { nested: [true, { x: 1 }] } }, { scope: { nested: [1, { x: 1 }] } }),
    fixture({ scope: { nested: [1, { x: false }] } }, { scope: { nested: [1, { x: false }] } }),
    fixture({ deletedAt: at }),
    fixture({}, { deletedAt: at }),
    fixture({ reviewStatus: 'pending' }),
    fixture({ revision: 2 }),
    fixture({}, { revision: 2 }),
  ];
  const collision = fixture();
  collision.document.answers.third = record('third', 'Editor preference?', { deletedAt: at });
  fixtures.push(collision);
  const differentScope = structuredClone(collision);
  differentScope.document.answers.third.scope = { region: 'elsewhere' };
  fixtures.push(differentScope);
  const redirects = fixture({}, {}, { redirects: { retired: { targetKey: 'source', mergedAt: 'older' } } });
  fixtures.push(redirects);
  const retiredKey = answerKey('Editor preference?', fromJSON({}));
  const retiredCollision = fixture();
  retiredCollision.document.answers.third = record('third', 'Different question');
  retiredCollision.document.redirects[retiredKey] = { targetKey: 'third', mergedAt: at };
  fixtures.push(retiredCollision);
  const permittedRedirect = fixture({}, {}, { redirects: { [retiredKey]: { targetKey: 'source', mergedAt: at } } });
  fixtures.push(permittedRedirect);
  const missingWinner = fixture();
  delete missingWinner.document.answers.winner;
  fixtures.push(missingWinner);
  assert.deepEqual(fixtures.map(native), python(fixtures));
});

test('answer merge preserves winner authority and values and replay cannot double observations', () => {
  const input = fixture({ observationCount: 2, source: 'owner', confirmedAt: 'confirmed', rememberedWithConsentAt: 'consent' },
    { observationCount: 7, state: 'sensitive', sensitivity: 'high', rememberedWithConsentAt: 'source-consent', reviewStatus: 'pending' });
  const first = native(input);
  assert.equal(first.result.value, 'winner-private');
  assert.equal(first.result.state, 'confirmed');
  assert.equal(first.result.source, 'owner');
  assert.equal(first.result.rememberedWithConsentAt, 'consent');
  assert.equal(first.result.observationCount, 9);
  assert.equal(first.result.revision, 2);
  assert.ok(!Object.hasOwn(first.document.answers, 'source'));
  const replay = { document: first.document, operation: input.operation };
  assert.deepEqual(native(replay), first);
  const badRevision = structuredClone(replay);
  badRevision.document.answers.winner.revision++;
  const badRedirect = structuredClone(replay);
  badRedirect.document.redirects.source.targetKey = 'other';
  const missingRedirect = structuredClone(replay);
  delete missingRedirect.document.redirects.source;
  const missingWinner = structuredClone(replay);
  delete missingWinner.document.answers.winner;
  const variants = [replay, badRevision, badRedirect, missingRedirect, missingWinner];
  assert.deepEqual(variants.map(native), python(variants));
  for (const invalid of variants.slice(1)) assert.match(native(invalid).error, /cannot be reconciled/);
});

test('answer merge preserves numeric scope equality while separating booleans and exact large revisions', () => {
  const input = fixture({ scope: { nested: [1] } }, { scope: { nested: [1] } });
  const documentText = JSON.stringify(input.document).replace('"nested":[1]', '"nested":[1.0]');
  assert.equal(plain(applyAnswerMerge(parse(documentText), fromJSON(input.operation))).revision, 2);
  const big = fixture({ revision: 'BIG', observationCount: 'BIG' }, { observationCount: 2 });
  const bigDocument = parse(JSON.stringify(big.document).replaceAll('"BIG"', '9007199254740993'));
  const bigOperation = parse(JSON.stringify(operation()).replace('"expectedWinnerRevision":1', '"expectedWinnerRevision":9007199254740993'));
  const result = serialize(applyAnswerMerge(bigDocument, bigOperation));
  assert.ok(result.includes('"revision":9007199254740994'));
  assert.ok(result.includes('"observationCount":9007199254740995'));
});

test('invalid merge identity and revision inputs fail before changing answer records', () => {
  for (const change of [{ winnerKey: '' }, { sourceKey: false }, { sourceKey: 'winner' },
    { expectedWinnerRevision: true }, { expectedSourceRevision: 0 }, { expectedSourceRevision: null }]) {
    const document = fromJSON(fixture().document);
    const before = serialize(document);
    assert.throws(() => applyAnswerMerge(document, fromJSON(operation(change))), /answer merge/);
    assert.equal(serialize(document), before);
  }
});
