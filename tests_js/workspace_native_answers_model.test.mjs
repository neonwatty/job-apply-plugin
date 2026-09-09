import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { parse, serialize, object, get, set, text, copy, has } from '../runtime/contracts/workspace/values.js';

const source = await readFile(new URL('../apps/companion/components/answer-model.ts', import.meta.url), 'utf8');
const emitted = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
  .replaceAll('../../../src/contracts/python-object', new URL('../runtime/contracts/python-object.js', import.meta.url).href)
  .replaceAll('../../../src/contracts/workspace/values', new URL('../runtime/contracts/workspace/values.js', import.meta.url).href);
const model = await import(`data:text/javascript;base64,${Buffer.from(emitted).toString('base64')}`);
const record = raw => object(parse(raw), 'answer');

test('ordinary field edits retain hidden values as absent and preserve untouched rich values', () => {
  const base = record('{"key":"a","revision":1,"question":"Question","state":"sensitive","valueRedacted":true,"scope":{"huge":9007199254740993,"float":1.0},"aliases":["Alias"]}');
  const draft = model.answerDraft(base);
  assert.equal(has(draft, 'value'), false);
  const next = set(copy(draft), 'question', text('Revised question'));
  const body = model.answerMutation(base, next, false);
  assert.deepEqual(JSON.parse(body).patch, { question: 'Revised question' });
  assert.equal(get(next, 'scope'), get(draft, 'scope'));
  assert.match(serialize(get(next, 'scope')), /9007199254740993/);
  assert.match(serialize(get(next, 'scope')), /1\.0/);
  assert.equal(has(object(get(record(body), 'patch'), 'patch'), 'value'), false);
});

test('selective reapply retains remote untouched value and local field changes', () => {
  const base = record('{"key":"a","revision":1,"question":"Question","value":9007199254740993,"state":"confirmed","scope":{"remote":"before"}}');
  const draft = set(model.answerDraft(base), 'question', text('Local question'));
  const latest = record('{"key":"a","revision":2,"question":"Remote question","value":9007199254740995,"state":"confirmed","scope":{"remote":"after"}}');
  const reapplied = model.reapplyAnswer(base, draft, latest);
  assert.equal(serialize(get(reapplied, 'value')), '9007199254740995');
  const mutation = model.answerMutation(latest, reapplied, false);
  assert.deepEqual(JSON.parse(mutation), { expectedRevision: 2, patch: { question: 'Local question' }, rememberSensitive: false });
});

test('intentional hidden value replacement is isolated in a consent-bearing mutation', () => {
  const base = record('{"key":"a","revision":7,"question":"Question","state":"sensitive","valueRedacted":true}');
  const draft = set(model.answerDraft(base), 'value', text('Replacement'));
  assert.deepEqual(JSON.parse(model.answerMutation(base, draft, true)), {
    expectedRevision: 7, patch: { value: 'Replacement' }, rememberSensitive: true,
  });
});
test('field type changes remain intentional edits including boolean-to-number scope changes', () => {
  const base = record('{"key":"a","revision":1,"scope":{"flag":true},"value":1}');
  const draft = model.answerDraft(base);
  set(draft, 'scope', parse('{"flag":1}'));
  set(draft, 'value', parse('1.0'));
  const body = model.answerMutation(base, draft, false);
  assert.deepEqual(JSON.parse(body).patch.scope, { flag: 1 });
  assert.match(body, /"value":1\.0/);
});

test('new answers default to confirmed user facts without edit revision or explicit identity', () => {
  const draft = model.newAnswerDraft();
  assert.equal(serialize(get(draft, 'state')), '"confirmed"');
  assert.equal(serialize(get(draft, 'source')), '"user"');
  set(draft, 'question', text('Portfolio rating'));
  set(draft, 'value', parse('9007199254740993'));
  set(draft, 'scope', parse('{"rating":1.0}'));
  // Existing identity/review metadata must never turn create into overwrite.
  set(draft, 'key', text('existing-key'));
  set(draft, 'revision', parse('9'));
  set(draft, 'reviewStatus', text('pending'));
  const body = model.answerCreateMutation(draft, false);
  const payload = record(body), answer = object(get(payload, 'answer'), 'answer');
  assert.equal(has(payload, 'expectedRevision'), false);
  for (const field of ['key', 'revision', 'reviewStatus']) assert.equal(has(answer, field), false);
  assert.equal(serialize(get(answer, 'value')), '9007199254740993');
  assert.equal(serialize(get(answer, 'scope')), '{"rating":1.0}');
  assert.equal(get(payload, 'rememberSensitive'), false);
});

test('create consent is explicit and each new draft starts fresh', () => {
  const draft = model.newAnswerDraft();
  set(draft, 'question', text('Private answer'));
  set(draft, 'state', text('sensitive'));
  set(draft, 'value', text('Retained only with consent'));
  assert.equal(get(record(model.answerCreateMutation(draft, true)), 'rememberSensitive'), true);
  assert.equal(serialize(get(model.newAnswerDraft(), 'question')), '""');
  assert.equal(get(record(model.answerCreateMutation(model.newAnswerDraft(), false)), 'rememberSensitive'), false);
});
