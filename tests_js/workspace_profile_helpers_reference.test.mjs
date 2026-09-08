import assert from 'node:assert/strict';
import test from 'node:test';
import * as h from '../workspace/lib/helpers.js';

test('profile reference: form patch fixes fields and preserves priority coercion', () => {
  const values = Object.freeze({ role: 'synthetic', resumeId: '', priority: '2', ignored: true });
  const patch = h.formPatch(values);
  assert.deepEqual(Object.keys(patch), ['url', 'role', 'company', 'location', 'workplaceType', 'employmentType', 'compensation', 'notes', 'description', 'resumeId', 'priority']);
  assert.equal(patch.resumeId, null);
  assert.equal(patch.priority, 2);
  assert.equal(patch.location, undefined);
  assert.equal(Object.hasOwn(patch, 'ignored'), false);
  assert.equal(h.formPatch({ priority: true }).priority, 1);
  assert.ok(Number.isNaN(h.formPatch({ priority: 'bad' }).priority));
  assert.throws(() => h.formPatch(null), TypeError);
  assert.throws(() => h.formPatch({ priority: Symbol() }), TypeError);
});

test('profile reference: pointers decode escapes, own keys and primitive boxing', () => {
  const value = { 'a/b': { '~x': 1 }, '': 2, array: [3], text: 'abc' };
  assert.equal(h.pointerValue(value, '/a~1b/~0x'), 1);
  assert.equal(h.pointerValue(value, ''), value);
  assert.equal(h.pointerValue(value, '/'), 2);
  assert.equal(h.pointerValue(value, '/array/0'), 3);
  assert.equal(h.pointerValue(value, '/text/1'), 'b');
  assert.equal(h.pointerValue(Object.create({ hidden: 1 }), '/hidden'), undefined);
  assert.equal(h.pointerValue(null, '/a/b'), undefined);
  assert.throws(() => h.pointerValue(value, null), TypeError);
});

test('profile reference: patches safely retain prototype-named own fields and ordered collisions', () => {
  const payload = Object.freeze({ retained: true });
  const result = h.patchForPaths([['/__proto__/synthetic', 1], ['/a~1b', payload], ['/a~1b', 2], ['/x/y', 3]]);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.hasOwn(result, '__proto__'), true);
  assert.equal(result.__proto__.synthetic, 1);
  assert.equal(result['a/b'], 2);
  assert.deepEqual(result.x, { y: 3 });
  assert.equal({}.synthetic, undefined);
  assert.equal(h.patchForPaths([['/a', payload]]).a, payload);
  assert.deepEqual(h.patchForPaths([['', 99]]), {});
  assert.throws(() => h.patchForPaths([['/a', null], ['/a/b', 2]]), TypeError);
  assert.throws(() => h.patchForPaths(null), TypeError);
});

test('profile reference: overlapping patch paths mutate aliased caller parents and reject frozen parents', () => {
  const payload = { retained: true };
  const patch = h.patchForPaths([['/a', payload], ['/a/b', 2]]);
  assert.equal(patch.a, payload);
  assert.deepEqual(payload, { retained: true, b: 2 });
  const frozen = Object.freeze({ retained: true });
  assert.throws(() => h.patchForPaths([['/a', frozen], ['/a/b', 2]]), TypeError);
  assert.deepEqual(frozen, { retained: true });
});

test('profile reference: conflicts preserve map baselines, structured conflicts and draft order', () => {
  const drafts = new Map([['/a', 2], ['/b', 3], ['/c', { x: 2 }]]);
  assert.deepEqual(h.conflictingPaths({ a: 1, b: 1, c: { x: 1 } }, { a: 2, b: 2, c: { x: 2 } }, drafts), ['/b', '/c']);
  assert.deepEqual(h.conflictingPaths(new Map([['/a', 1]]), { a: 2 }, new Map([['/a', 2]]), new Set(['/a'])), ['/a']);
  assert.deepEqual(h.conflictingPaths({}, {}, [['/a', 1]]), []);
  assert.deepEqual(h.conflictingPaths({ a: NaN }, { a: null }, [['/a', 2]]), []);
  assert.throws(() => h.conflictingPaths({ a: 1n }, { a: 2 }, [['/a', 2]]), TypeError);
  assert.deepEqual([...drafts.keys()], ['/a', '/b', '/c']);
});

test('profile reference: provenance selects longest ancestor or sorted descendant summary', () => {
  const closest = Object.freeze({ source: 'resume', updatedAt: '2020' });
  const records = Object.freeze({ '/a': { source: 'manual' }, '/a/b': closest });
  assert.equal(h.summarizeProvenance(records, '/a/b/c'), closest);
  assert.equal(h.summarizeProvenance(null, '/x'), null);
  assert.deepEqual(h.summarizeProvenance({ '/a/x': { source: 'resume', updatedAt: '2020' }, '/a/y': { source: 'manual', updatedAt: '2022' } }, '/a'),
    { source: 'mixed: manual, resume', updatedAt: '2022' });
  assert.deepEqual(h.summarizeProvenance({ '/a/x': { source: 'resume' } }, '/a'), { source: 'resume', updatedAt: undefined });
  assert.equal(h.summarizeProvenance({ '/ab': closest }, '/a'), null);
  assert.throws(() => h.summarizeProvenance({ '/a/x': null }, '/a'), TypeError);
});

test('profile reference: tags retain duplicates, order and String coercion', () => {
  assert.deepEqual(h.tagsFromInput(' a, ,b,a '), ['a', 'b', 'a']);
  assert.deepEqual(h.tagsFromInput(null), []);
  assert.deepEqual(h.tagsFromInput(0), []);
  assert.deepEqual(h.tagsFromInput(['a', 'b']), ['a', 'b']);
  assert.deepEqual(h.tagsFromInput(Symbol('synthetic')), ['Symbol(synthetic)']);
  assert.throws(() => h.tagsFromInput(Object.create(null)), TypeError);
});

test('U01 resume reference preserves counts and default copy', () => {
  for (const [value, expected] of [
    [undefined, '0 explicitly assigned active jobs.'],
    [{ assignedJobCount: 1, implicitJobCount: 2 }, '1 explicitly assigned active job; 2 active jobs use this default.'],
    [{ assignedJobCount: -1, implicitJobCount: -2 }, '-1 explicitly assigned active jobs; -2 active jobs use this default.'],
    [{ assignedJobCount: '1', implicitJobCount: Infinity }, '0 explicitly assigned active jobs.'],
    [{ assignedJobCount: 0.5, implicitJobCount: 1 }, '0 explicitly assigned active jobs; 1 active job use this default.'],
  ]) assert.equal(h.resumeAssignmentText(value), expected);
  const frozen = Object.freeze({ assignedJobCount: 1, implicitJobCount: 0 });
  h.resumeAssignmentText(frozen);
  assert.deepEqual(frozen, { assignedJobCount: 1, implicitJobCount: 0 });
});

test('U01 resume reference preserves extraction precedence and malformed projections', () => {
  for (const [request, proposal, expected] of [
    [null, null, ['Facts not extracted', 'request', 'neutral']],
    [{ status: 'cancelled' }, null, ['Facts not extracted', 'request', 'neutral']],
    [{ status: 'requested' }, null, ['Waiting for a Job Apply agent', 'cancel', 'waiting']],
    [{ status: 'failed' }, null, ['Fact extraction did not complete', 'retry', 'warning']],
    [{ status: 'stale' }, null, ['The resume changed after this request', 'fresh', 'warning']],
    [{ status: 'completed' }, { status: 'pending', staleReasons: { length: -1 } }, ['Extraction review is no longer current', 'fresh', 'warning']],
    [{ status: 'completed' }, { status: 'pending', staleReasons: [] }, ['Extracted changes need review', 'review', 'review']],
    [{ status: 'future' }, null, ['Extracted facts were applied or reviewed', 'facts', 'complete']],
  ]) {
    const result = h.extractionRequestView(request, proposal);
    assert.deepEqual(result, { label: expected[0], action: expected[1], tone: expected[2] });
    assert.notEqual(result, h.extractionRequestView(request, proposal));
  }
});

test('U01 resume reference preserves grouping coercion and strict response identity', () => {
  for (const [path, expected] of [['/firstName', 'Identity'], ['/email', 'Contact'], ['/location', 'Location'],
    ['/workHistory/0', 'Experience'], ['/education', 'Education'], ['/skills', 'Skills'], ['/githubUrl', 'Links'],
    [null, 'Additional'], [Symbol('x'), 'Additional'], ['skills', 'Additional'], ['prefix/skills', 'Skills']]) {
    assert.equal(h.proposalGroupForPath(path), expected);
  }
  const shared = {};
  assert.equal(h.shouldUseResumeResponse(shared, shared, shared, shared), true);
  assert.equal(h.shouldUseResumeResponse('1', 1, false, false), false);
  assert.equal(h.shouldUseResumeResponse(1, 1, 0, false), false);
  assert.equal(h.shouldUseResumeResponse(NaN, NaN, true, true), false);
});

test('U01 resume reference preserves accessor order and thrown identities', () => {
  const log = [], failure = { synthetic: true };
  const resume = { get assignedJobCount() { log.push('assigned'); return 1; },
    get implicitJobCount() { log.push('implicit'); return 0; } };
  h.resumeAssignmentText(resume);
  assert.deepEqual(log, ['assigned', 'assigned', 'implicit', 'implicit']);
  log.length = 0;
  h.extractionRequestView({ get status() { log.push('status'); return 'requested'; } },
    { get status() { throw failure; } });
  assert.deepEqual(log, ['status', 'status']);
  assert.throws(() => h.resumeAssignmentText({ get assignedJobCount() { throw failure; } }), e => e === failure);
  assert.throws(() => h.extractionRequestView({ get status() { throw failure; } }), e => e === failure);
  assert.throws(() => h.proposalGroupForPath({ [Symbol.toPrimitive](hint) {
    assert.equal(hint, 'string'); throw failure;
  } }), e => e === failure);
  const trap = { [Symbol.toPrimitive]() { throw failure; } };
  assert.equal(h.shouldUseResumeResponse(trap, trap, trap, trap), true);
});
