import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const emit = source => ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022,
} }).outputText;
const data = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const contracts = data(emit(await readFile(new URL('../apps/companion/components/contracts.ts', import.meta.url), 'utf8')));
const source = await readFile(new URL('../apps/companion/components/job-transition-model.ts', import.meta.url), 'utf8');
const model = await import(data(emit(source).replaceAll("'./contracts'", JSON.stringify(contracts))));
const job = { id: 'job-one', revision: 7, status: 'saved', url: 'https://example.org/job' };

test('targets follow Python transitions without granting direct in_progress authority', () => {
  for (const [status, expected] of [
    ['saved', ['needs_info', 'ready', 'closed']],
    ['needs_info', ['saved', 'ready', 'closed']],
    ['ready', ['saved', 'needs_info', 'closed']],
    ['in_progress', ['needs_info', 'awaiting_review', 'closed']],
    ['awaiting_review', ['applied', 'closed']],
    ['applied', ['closed']], ['closed', ['saved']], ['unknown', []], ['__proto__', []],
  ]) assert.deepEqual(model.transitionTargets({ ...job, status }), expected);
  assert.deepEqual(model.transitionTargets({ ...job, deletedAt: '2026-01-01' }), []);
});

test('payload binds current revision and rejects unsupported transitions or malformed identity', () => {
  assert.deepEqual(JSON.parse(model.transitionBody(job, 'ready')), { status: 'ready', expectedRevision: 7 });
  for (const target of ['saved', 'applied', 'in_progress', 'wat'])
    assert.throws(() => model.transitionBody(job, target), /transition/i);
  for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN])
    assert.throws(() => model.transitionBody({ ...job, revision }, 'ready'), /revision/i);
  assert.throws(() => model.transitionBody({ ...job, id: '' }, 'ready'), /identity/i);
});

test('applied requires explicit personal submission confirmation and omits consent elsewhere', () => {
  const review = { ...job, status: 'awaiting_review' };
  assert.throws(() => model.transitionBody(review, 'applied'), /personally submitted/i);
  assert.deepEqual(JSON.parse(model.transitionBody(review, 'applied', '', true)), {
    status: 'applied', expectedRevision: 7, userConfirmed: true,
  });
  assert.deepEqual(JSON.parse(model.transitionBody(job, 'ready', 'expired', true)), {
    status: 'ready', expectedRevision: 7,
  });
  assert.match(model.transitionConfirmation(review, 'applied'), /personally submitted/i);
  assert.match(model.transitionConfirmation(job, 'ready'), /local status/i);
  assert.match(model.transitionConfirmation(job, 'ready'), /preflight/i);
});

test('closing requires one of the five canonical outcomes', () => {
  for (const outcome of ['rejected', 'withdrawn', 'expired', 'duplicate', 'not_interested'])
    assert.deepEqual(JSON.parse(model.transitionBody(job, 'closed', outcome)), {
      status: 'closed', expectedRevision: 7, closedOutcome: outcome,
    });
  for (const outcome of ['', 'other', 'applied'])
    assert.throws(() => model.transitionBody(job, 'closed', outcome), /outcome/i);
});

test('acknowledgement must decode a full job with matching identity, target, and advanced revision', () => {
  const result = { ...job, revision: 8, status: 'ready', notes: 'Preserved' };
  assert.deepEqual(model.transitionAcknowledgement(JSON.stringify(result), job, 'ready'), result);
  for (const bad of [{ ...result, id: 'other' }, { ...result, revision: 7 },
    { ...result, status: 'saved' }, { status: 'ready' }, { job: result }])
    assert.throws(() => model.transitionAcknowledgement(JSON.stringify(bad), job, 'ready'));
  assert.throws(() => model.transitionAcknowledgement('not json', job, 'ready'));
});

test('conflict and ambiguous failure require refresh without claiming a successful write', () => {
  const conflict = model.transitionFailure({ status: 409, message: 'conflict' });
  assert.match(conflict, /changed|claim/i);
  assert.match(conflict, /refresh/i);
  assert.match(model.transitionFailure(new Error('Timeout')), /refresh/i);
  assert.match(model.transitionFailure(new Error('job is not ready')), /job is not ready/i);
});
