import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';
import { validateAnswerSession } from '../runtime/contracts/workspace/answer-session-validation.js';
import { PendingAnswersService } from '../runtime/workspace-core/pending-answers.js';

const source = await readFile(new URL('../apps/companion/components/pending-answer-model.ts', import.meta.url), 'utf8');
const emitted = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
  .replaceAll('../../../src/contracts/workspace/values', new URL('../runtime/contracts/workspace/values.js', import.meta.url).href);
const model = await import(`data:text/javascript;base64,${Buffer.from(emitted).toString('base64')}`);
const field = { reference: 'portfolio', question: 'Portfolio URL?', resolutionEligible: true, answerKey: 'portfolio-key', answerRevision: 3, answerSensitivity: 'none' };
const job = { id: 'job/a', role: 'Developer', company: 'Example', status: 'needs_info', jobRevision: 1, sessionRevision: 2, pendingInformation: [field] };
const listing = value => JSON.stringify({ jobs: [value], mutated: false });

test('pending question listing preserves large revisions and emits only explicit approval authority', () => {
  const raw = listing(job).replace('"jobRevision":1', '"jobRevision":9007199254740993')
    .replace('"sessionRevision":2', '"sessionRevision":9007199254740995')
    .replace('"answerRevision":3', '"answerRevision":9007199254740997');
  const [snapshot] = model.pendingAnswers(raw);
  assert.equal(snapshot.jobRevision, 9007199254740993n);
  assert.equal(snapshot.sessionRevision, 9007199254740995n);
  assert.equal(snapshot.pendingInformation[0].answerRevision, 9007199254740997n);
  const body = model.pendingAnswerResolution(snapshot, snapshot.pendingInformation[0]);
  assert.match(body, /"expectedJobRevision":9007199254740993/);
  assert.match(body, /"expectedSessionRevision":9007199254740995/);
  assert.match(body, /"expectedAnswerRevision":9007199254740997/);
  assert.deepEqual(Object.keys(JSON.parse(body)).sort(), ['expectedAnswerRevision', 'expectedJobRevision', 'expectedSessionRevision', 'ownerConfirmed', 'reference']);
  assert.equal(JSON.parse(body).ownerConfirmed, true);
  assert.equal(JSON.parse(body).reference, field.reference);
});

test('closed pending projection rejects accidental values, malformed revisions and invalid eligibility', () => {
  for (const invalid of [
    { ...job, value: 'private' },
    { ...job, status: 'ready' },
    { ...job, jobRevision: 0 },
    { ...job, sessionRevision: true },
    { ...job, pendingInformation: [{ ...field, value: 'private' }] },
    { ...job, pendingInformation: [{ ...field, resolutionEligible: 'yes' }] },
    { ...job, pendingInformation: [{ ...field, answerRevision: null }] },
    { ...job, pendingInformation: [{ ...field, sensitive: true }] },
    { ...job, pendingInformation: [{ ...field, answerSensitivity: 'unknown' }] },
    { ...job, pendingInformation: [{ reference: 'x', resolutionEligible: true }] },
  ]) assert.throws(() => model.pendingAnswers(listing(invalid)));
  assert.throws(() => model.pendingAnswers(listing(job).replace('"jobRevision":1', '"jobRevision":1.0')));
  assert.throws(() => model.pendingAnswers('{"jobs":[],"mutated":true}'));
  assert.throws(() => model.pendingAnswers('{"jobs":[],"mutated":false,"private":"hidden"}'));
});

test('unresolved questions without a saved answer remain visible without mutation authority', () => {
  const [snapshot] = model.pendingAnswers(listing({ ...job, pendingInformation: [{ reference: 'missing', resolutionEligible: false }] }));
  assert.equal(snapshot.pendingInformation[0].question, undefined);
  assert.throws(() => model.pendingAnswerResolution(snapshot, snapshot.pendingInformation[0]));
  const [eligible] = model.pendingAnswers(listing(job));
  assert.throws(() => model.pendingAnswerResolution(eligible, { ...eligible.pendingInformation[0] }));
});

test('successful resolution requires a closed confirmed response and valid projected remaining questions', () => {
  const response = { job: { id: job.id, status: 'ready', revision: 2 }, session: { revision: 3, pendingInformation: [] }, resolved: true, ready: true };
  assert.equal(model.pendingAnswerResolved(JSON.stringify(response)), true);
  assert.equal(model.pendingAnswerResolved(JSON.stringify({ ...response, ready: false })), false);
  for (const invalid of [
    { ...response, resolved: false },
    { ...response, ready: 'true' },
    { ...response, private: 'secret' },
    { ...response, job: { ...response.job, value: 'secret' } },
    { ...response, session: { ...response.session, revision: 0 } },
    { ...response, session: { ...response.session, pendingInformation: [{ ...field, value: 'secret' }] } },
  ]) assert.throws(() => model.pendingAnswerResolved(JSON.stringify(invalid)));
});


test('valid nullable stored questions pass the service projection and use the display fallback', async () => {
  const session = {
    schemaVersion: 1, applicationId: 'nullable-question', status: 'active',
    pendingFields: [{ reference: `pending_${'e'.repeat(32)}`, question: null, answerKey: null }],
  };
  const persisted = fromJSON(session);
  validateAnswerSession(persisted);
  const service = new PendingAnswersService({
    pendingAnswerTransaction: operation => operation({
      jobs: fromJSON({ jobs: { 'nullable-question': { id: 'nullable-question', status: 'needs_info', revision: 1 } } }),
      answers: fromJSON({ schemaVersion: 1, answers: {}, metadata: {}, redirects: {} }),
      sessions: [persisted],
    }),
  });
  const raw = serialize(await service.list());
  assert.equal(JSON.parse(raw).jobs[0].pendingInformation[0].question, null);
  const [snapshot] = model.pendingAnswers(raw);
  assert.equal(snapshot.pendingInformation[0].question, undefined);
  assert.equal(snapshot.pendingInformation[0].answerKey, undefined);
  assert.equal(snapshot.pendingInformation[0].resolutionEligible, false);
  assert.equal(model.pendingAnswerResolved(JSON.stringify({
    job: { id: 'nullable-question', status: 'needs_info', revision: 2 },
    session: { revision: 3, pendingInformation: JSON.parse(raw).jobs[0].pendingInformation },
    resolved: true, ready: false,
  })), false);
  // State has a stricter enum check after optional-string validation; null is invalid.
  assert.throws(() => validateAnswerSession(fromJSON({
    ...session, pendingFields: [{ ...session.pendingFields[0], state: null }],
  })), /state is unsupported/);
  assert.throws(() => model.pendingAnswers(listing({
    ...job, pendingInformation: [{ ...field, state: null }],
  })));
});
