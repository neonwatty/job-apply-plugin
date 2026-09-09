import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { parse, serialize, object } from '../runtime/contracts/workspace/values.js';

const source = await readFile(new URL('../apps/companion/components/extraction-model.ts', import.meta.url), 'utf8');
const emitted = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
  .replaceAll('../../../src/contracts/python-object', new URL('../runtime/contracts/python-object.js', import.meta.url).href)
  .replaceAll('../../../src/contracts/workspace/values', new URL('../runtime/contracts/workspace/values.js', import.meta.url).href);
const model = await import(`data:text/javascript;base64,${Buffer.from(emitted).toString('base64')}`);
const record = raw => object(parse(raw), 'record');
const proposal = model.proposalSnapshot(`{
  "id":"proposal-one", "revision":9007199254740993, "liveProfileRevision":9007199254740995,
  "candidate":{"contact":{"name":"New"},"a/b":{"~key":9007199254740997}},
  "pendingPaths":["/contact/name","/a~1b/~0key"],
  "currentValues":{"/contact/name":{"exists":false,"value":null},"/a~1b/~0key":{"exists":true,"value":1}},
  "replacementScopes":{"/contact/name":{"path":"/contact","value":"Old contact"}}
}`);

test('candidate pointer traversal unescapes segments without rounding extracted numbers', () => {
  assert.equal(serialize(model.candidateValue(proposal, '/a~1b/~0key')), '9007199254740997');
  assert.throws(() => model.candidateValue(proposal, '/missing'), /missing/);
});

test('review retains exact proposal and profile revisions and requires replacement consent', () => {
  assert.throws(() => model.reviewMutation(proposal, { '/contact/name': 'use_extracted' }, []), /Confirm replacement/);
  const body = model.reviewMutation(proposal, { '/contact/name': 'use_extracted', '/a~1b/~0key': 'keep_current' }, ['/contact/name']);
  assert.match(body, /"expectedRevision":9007199254740993/);
  assert.match(body, /"expectedProfileRevision":9007199254740995/);
  assert.deepEqual(JSON.parse(body).replacementConfirmations, { '/contact/name': '/contact' });
  assert.deepEqual(JSON.parse(model.reviewMutation(proposal, { '/contact/name': 'keep_current' }, ['/contact/name'])).replacementConfirmations, {});
});

test('reapply drops resolved choices while retaining only still pending decisions', () => {
  const latest = record('{"pendingPaths":["/a~1b/~0key"]}');
  assert.deepEqual(model.reapplyChoices({ '/contact/name': 'use_extracted', '/a~1b/~0key': 'keep_current' }, latest), { '/a~1b/~0key': 'keep_current' });
  assert.throws(() => model.reviewMutation(proposal, { '/gone': 'keep_current' }, []), /Invalid review/);
  assert.throws(() => model.reviewMutation(proposal, {}, []), /at least one/);
});

test('request, cancel and retry serialize only their exact revision contracts', () => {
  const resume = record('{"id":"resume-one","revision":9007199254740993}');
  const request = record('{"requestId":"request-one","revision":9007199254740995}');
  assert.equal(model.requestMutation(resume), '{"expectedResumeRevision":9007199254740993,"resumeId":"resume-one"}');
  assert.equal(model.requestMutation(resume, request, 'cancel'), '{"expectedRevision":9007199254740995}');
  assert.equal(model.requestMutation(resume, request, 'retry'), '{"expectedResumeRevision":9007199254740993,"expectedRevision":9007199254740995}');
});

test('malformed proposals and list responses fail before displaying a review', () => {
  assert.throws(() => model.proposalSnapshot('{"id":"p","revision":true,"liveProfileRevision":1}'), /revision/);
  assert.throws(() => model.extractionList('{"requests":{}}', 'requests'), /Invalid requests/);
});
