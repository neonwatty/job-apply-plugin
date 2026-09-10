import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fromJSON, parse, serialize } from '../runtime/contracts/workspace/values.js';
import { proposeCleanup } from '../runtime/contracts/workspace/answer-match-cleanup.js';
import { previewAnswerCleanup } from '../runtime/workspace-core/answer-cleanup.js';

const plain = value => JSON.parse(serialize(value));
const capture = callback => {
  try { return { value: callback() }; }
  catch (error) { return { error: error.message }; }
};
const candidate = (answerKey, question, extra = {}) => ({ answerKey, question, aliases: [],
  scope: {}, fieldClass: 'general', sensitivity: 'none', state: 'confirmed', recordStatus: 'active',
  reviewStatus: 'accepted', valueState: 'seen', ...extra });
const pending = (key, question, extra = {}) => candidate(key, question, { reviewStatus: 'pending', ...extra });

function python(operation, items) {
  const result = spawnSync('python3', ['-c', String.raw`
import sys,json,importlib.util
from pathlib import Path
sys.path.insert(0,'scripts')
spec=importlib.util.spec_from_file_location('cleanup_reference','scripts/job-apply-store.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
from job_apply_answer_matching.cleanup import propose_cleanup
store=m.Store(Path('/unused-cleanup-oracle'))
results=[]
for item in json.load(sys.stdin):
 try:
  value=propose_cleanup(candidates=item) if sys.argv[1]=='match' else store._preview_answer_cleanup_document(item)
  results.append({'value':value})
 except Exception as error: results.append({'error':str(error)})
print(json.dumps(results))
`, operation], { cwd: new URL('..', import.meta.url), input: items, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('cleanup matching agrees with Python on policy, compatibility, ambiguity and deterministic ordering', () => {
  const winner = candidate('winner', 'Authorized to work in this country?');
  const duplicate = pending('duplicate', winner.question);
  const fixtures = [[], [winner, duplicate], [duplicate, winner],
    [winner, pending('high', 'Eligible for employment in this nation?')],
    [winner, pending('negated', 'Not authorized to work in this country?')],
    [winner, pending('alias', 'Unrelated question', { aliases: [winner.question] })],
    [winner, candidate('other-winner', winner.question), duplicate],
    [winner, candidate('other-high-winner', 'Eligible for employment in this nation?'), duplicate],
    [winner, pending('z', winner.question), pending('a', winner.question)],
    [candidate('\ue000', 'Other query'), pending('dup-b', 'Other query'),
      candidate('😀', winner.question), duplicate],
    [candidate('unicode', 'Straße ＷＯＲＫ ①'), pending('unicode-duplicate', 'STRASSE work 1')],
  ];
  for (const change of [{ recordStatus: 'deleted' }, { reviewStatus: 'pending' },
    { reviewStatus: 'declined' }, { state: 'inferred' }, { state: 'sensitive' },
    { state: 'missing' }, { valueState: 'missing' }, { valueState: 'unseen' }]) {
    fixtures.push([{ ...winner, ...change }, duplicate]);
  }
  for (const change of [{ recordStatus: 'deleted' }, { reviewStatus: 'accepted' },
    { reviewStatus: 'declined' }, { state: 'missing', valueState: 'missing' },
    { state: 'inferred' }, { scope: { employer: 'other' } },
    { fieldClass: 'authorization' }, { sensitivity: 'high' }]) {
    fixtures.push([winner, { ...duplicate, ...change }]);
  }
  for (const change of [{ recordStatus: 'invalid' }, { reviewStatus: 'invalid' },
    { state: 'invalid' }, { valueState: 'invalid' }, { aliases: [null] },
    { scope: null }, { fieldClass: 'BAD' }, { sensitivity: 'invalid' }]) {
    fixtures.push([{ ...winner, ...change }, duplicate]);
  }
  fixtures.push(null, {}, 'invalid', [null], [winner, winner], [{ ...winner, answerKey: '' }]);
  const actual = fixtures.map(items => capture(() => proposeCleanup(fromJSON(items)).map(plain)));
  assert.deepEqual(actual, python('match', JSON.stringify(fixtures)));
  assert.equal(actual[1].value.length, 1);
  assert.equal(actual[3].value[0].confidenceBand, 'high');
  assert.deepEqual(actual[6].value, []);
  assert.deepEqual(actual[7].value, []);
  assert.deepEqual(actual[8].value.map(item => item.duplicateKey), ['a', 'z']);
});

const record = (key, question, extra = {}) => ({ key, question, aliases: [], scope: {},
  fieldClass: 'general', sensitivity: 'none', state: 'confirmed', value: 'PRIVATE_ANSWER_VALUE',
  source: 'user', revision: 1, ...extra });
const document = records => ({ schemaVersion: 1, answers: Object.fromEntries(records.map(item => [item.key, item])), metadata: {} });

test('preview matches Python tokens, preserves current revisions and omits stored values without mutation', () => {
  const winner = record('winner', 'Café work 😀?');
  const duplicate = record('duplicate', 'Café work 😀?', { reviewStatus: 'pending', revision: 7 });
  const base = document([winner, duplicate]);
  const fixtures = [document([]), base, document([duplicate, winner]),
    document([{ ...winner, revision: 2 }, duplicate]),
    document([winner, duplicate, record('unrelated', null, { revision: 9 })]),
    document([winner, duplicate, record('unrelated', null, { revision: 10 })]),
    document([{ ...winner, value: 'CHANGED_PRIVATE_VALUE' }, duplicate]),
    document([{ ...winner, question: 'Cafe\u0301 work 😀?' }, duplicate]),
    document([{ ...winner, question: '\u007f\u0085\u2028\n"\\ work' },
      { ...duplicate, question: '\u007f\u0085\u2028\n"\\ work' }]),
    document([{ ...winner, scope: { n: 1 } }, { ...duplicate, scope: { n: true } }]),
    document([{ ...winner, sensitivity: 'high' }, { ...duplicate, sensitivity: 'high' }]),
    document([{ ...winner, question: ' ' }, duplicate]),
    document([{ ...winner, aliases: [' ', 'Café work 😀?'] }, duplicate]),
  ];
  const actual = fixtures.map(item => {
    const value = fromJSON(item), before = serialize(value);
    const result = capture(() => plain(previewAnswerCleanup(value)));
    assert.equal(serialize(value), before);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ANSWER_VALUE|CHANGED_PRIVATE_VALUE/);
    if (result.value) {
      assert.equal(result.value.mutated, false);
      assert.match(result.value.previewToken, /^answer-cleanup-v1\.[a-f0-9]{64}$/);
      for (const proposal of result.value.proposals) assert.deepEqual(Object.keys(proposal).sort(),
        ['confidenceBand', 'duplicateKey', 'duplicateQuestion', 'duplicateRevision', 'reasonCodes', 'winnerKey', 'winnerQuestion', 'winnerRevision']);
    }
    return result;
  });
  assert.deepEqual(actual, python('preview', JSON.stringify(fixtures)));
  assert.equal(actual[1].value.previewToken, actual[2].value.previewToken);
  assert.notEqual(actual[1].value.previewToken, actual[3].value.previewToken);
  assert.notEqual(actual[4].value.previewToken, actual[5].value.previewToken);
  assert.equal(actual[1].value.previewToken, actual[6].value.previewToken);
  const raw = JSON.stringify(base).replace('"revision":1', '"revision":900719925474099312345');
  assert.deepEqual(capture(() => plain(previewAnswerCleanup(parse(raw)))), python('preview', `[${raw}]`)[0]);
});

test('preview reports invalid matching metadata without exposing candidate data', () => {
  const value = fromJSON(document([record('winner', 'Question', { fieldClass: 'PRIVATE_BAD_FIELD' }),
    record('duplicate', 'Question', { reviewStatus: 'pending' })]));
  assert.throws(() => previewAnswerCleanup(value), { message: 'answer cleanup preview is invalid' });
});
