import assert from 'node:assert/strict';
import test from 'node:test';
import * as source from '../workspace/lib/helpers.js';
import * as target from '../runtime/workspace-ui/lib/profile-view.js';

function observe(api, name, factory) {
  const log = [];
  const args = factory(log);
  try { return { result: api[name](...args), log }; }
  catch (error) { return { error: error.constructor.name, log }; }
}
function compare(name, factory) { assert.deepEqual(observe(target, name, factory), observe(source, name, factory), name); }

test('profile helpers preserve errors for absent patch entries and drafts', () => {
  for (const api of [source, target]) {
    assert.throws(() => api.patchForPaths(), TypeError);
    assert.throws(() => api.patchForPaths(null), TypeError);
    assert.throws(() => api.patchForPaths([undefined]), TypeError);
    assert.throws(() => api.patchForPaths([null]), TypeError);
    assert.throws(() => api.conflictingPaths({}, {}), TypeError);
    assert.throws(() => api.conflictingPaths({}, {}, null), TypeError);
    assert.throws(() => api.conflictingPaths({}, {}, [undefined]), TypeError);
    assert.deepEqual(api.patchForPaths([]), {});
    assert.deepEqual(api.conflictingPaths({}, {}, []), []);
  }
});

test('profile TS covers six exports with fixed ordinary and coercive cases', () => {
  for (const priority of [undefined, null, false, true, '', '2', 'bad', 2n, Symbol('synthetic')]) compare('formPatch', () => [{ role: 'job', resumeId: '', priority }]);
  compare('formPatch', () => [null]);
  for (const pointer of ['', '/', '/a~1b/~0x', '/array/0', '/text/1', '/missing', null]) {
    compare('pointerValue', () => [{ 'a/b': { '~x': 1 }, '': 2, array: [3], text: 'abc' }, pointer]);
  }
  compare('pointerValue', () => [Object.create({ hidden: 1 }), '/hidden']);
  for (const entries of [[['/a/b', 1], ['/a/b', 2]], [['/__proto__/x', 1]], [['', 9]], [['/a', null], ['/a/b', 1]]]) {
    compare('patchForPaths', () => [structuredClone(entries)]);
  }
  compare('conflictingPaths', () => [{ a: 1, b: { x: 1 } }, { a: 2, b: { x: 2 } }, [['/a', 2], ['/b', { x: 2 }]]]);
  compare('conflictingPaths', () => [new Map([['/a', 1]]), { a: 2 }, new Map([['/a', 2]]), new Set(['/a'])]);
  compare('conflictingPaths', () => [{ a: 1n }, { a: 2 }, [['/a', 2]]]);
  for (const records of [null, {}, { '/a': { source: 'manual' } },
    { '/a/x': { source: 'resume', updatedAt: '2020' }, '/a/y': { source: 'manual', updatedAt: '2022' } }, { '/a/x': null }]) {
    compare('summarizeProvenance', () => [records, '/a']);
  }
  for (const value of [null, 0, false, ' a, ,b,a ', ['a', 'b'], Symbol('synthetic'), Object.create(null)]) compare('tagsFromInput', () => [value]);
});

test('profile TS preserves getter/coercion and custom iteration behavior', () => {
  for (const failAt of ['', 'role', 'priority']) compare('formPatch', (log) => [new Proxy({}, { get(_target, key) {
    log.push(String(key)); if (key === failAt) throw new RangeError('synthetic'); return key === 'priority' ? 1 : '';
  } })]);
  compare('pointerValue', (log) => [{ get a() { log.push('a'); return { get b() { log.push('b'); return 2; } }; } }, '/a/b']);
  compare('patchForPaths', (log) => [{ *[Symbol.iterator]() {
    log.push('first'); yield ['/a', 1]; log.push('second'); yield ['/b', 2];
  } }]);
  for (const fail of [false, true]) compare('tagsFromInput', (log) => [{ [Symbol.toPrimitive](hint) {
    log.push(hint); if (fail) throw new TypeError('synthetic'); return 'a,b';
  } }]);
  compare('summarizeProvenance', (log) => [{ get '/a/x'() { log.push('record'); return {
    get source() { log.push('source'); return 'resume'; }, get updatedAt() { log.push('time'); return 'now'; },
  }; } }, '/a']);
});

test('profile TS preserves patch alias mutation, failure boundaries and provenance identity', () => {
  for (const api of [source, target]) {
    const payload = { retained: true };
    const patch = api.patchForPaths([['/a', payload], ['/a/b', 2]]);
    assert.equal(patch.a, payload);
    assert.deepEqual(payload, { retained: true, b: 2 });
    const frozen = Object.freeze({ retained: true });
    assert.throws(() => api.patchForPaths([['/a', frozen], ['/a/b', 2]]), TypeError);
    assert.deepEqual(frozen, { retained: true });
    const record = Object.freeze({ source: 'manual', updatedAt: 'now' });
    assert.equal(api.summarizeProvenance(Object.freeze({ '/a': record }), '/a/b'), record);
    const result = api.patchForPaths([['/__proto__/synthetic', true]]);
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.equal(Object.hasOwn(result, '__proto__'), true);
    assert.equal({}.synthetic, undefined);
    const drafts = Object.freeze([Object.freeze(['/a', 2])]);
    assert.deepEqual(api.conflictingPaths(Object.freeze({ a: 1 }), Object.freeze({ a: 3 }), drafts), ['/a']);
    assert.deepEqual(drafts, [['/a', 2]]);
  }
});
