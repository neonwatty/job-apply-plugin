import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { copy, get, int, object, parse, serialize, set, string, text } from '../runtime/contracts/workspace/values.js';

const source = await readFile(new URL('../apps/companion/components/resume-facts-model.ts', import.meta.url), 'utf8');
const emitted = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022,
} }).outputText
  .replaceAll('../../../src/contracts/python-object', new URL('../runtime/contracts/python-object.js', import.meta.url).href)
  .replaceAll('../../../src/contracts/workspace/values', new URL('../runtime/contracts/workspace/values.js', import.meta.url).href);
const model = await import(`data:text/javascript;base64,${Buffer.from(emitted).toString('base64')}`);
const facts = '{"summary":"Before","exact":9007199254740993,"nested":[{"exact":9007199254740995}],"ratio":1.0}';
const raw = `{"revision":9007199254740997,"contentRevision":"sha256:fixture","state":"draft","current":true,
  "facts":${facts},"versions":[{"revision":9007199254740997,"state":"draft","facts":${facts}}]}`;

test('resume fact edits retain exact numbers, nested values, history and request revisions', () => {
  const version = model.factVersion(raw), draft = set(copy(version.facts), 'summary', text('After'));
  const body = object(parse(model.draftBody(draft, 2, version.revision)), 'body');
  const edited = object(get(body, 'facts'), 'facts');
  assert.equal(int(get(body, 'expectedFactRevision')), 9007199254740997n);
  assert.equal(int(get(body, 'expectedResumeRevision')), 2n);
  assert.equal(string(get(edited, 'summary')), 'After');
  assert.equal(int(get(edited, 'exact')), 9007199254740993n);
  assert.equal(serialize(get(edited, 'nested')), '[{"exact":9007199254740995}]');
  assert.equal(serialize(get(edited, 'ratio')), '1.0');
  assert.equal(serialize(version.versions[0].facts), serialize(parse(facts)));
  assert.equal(string(get(version.facts, 'summary')), 'Before');
  assert.equal(model.confirmationBody(version), serialize(parse('{"expectedFactRevision":9007199254740997,"expectedContentRevision":"sha256:fixture"}')));
});

test('resume fact detail rejects malformed revisions and state before exposing an editor', () => {
  for (const revision of ['0', '-1', '1.5', '"2"', 'null']) {
    assert.throws(() => model.factVersion(raw.replace('"revision":9007199254740997', `"revision":${revision}`)));
  }
  assert.throws(() => model.factVersion(raw.replace('"state":"draft"', '"state":"unknown"')));
  assert.throws(() => model.factVersion(raw.replace('"current":true', '"current":"true"')));
});
