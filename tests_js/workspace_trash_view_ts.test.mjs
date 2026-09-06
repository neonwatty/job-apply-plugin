import assert from 'node:assert/strict';
import test from 'node:test';
import * as original from '../workspace/lib/helpers.js';
import * as candidate from '../runtime/workspace-ui/lib/trash-view.js';

function observe(functionName, factory, implementation) {
  const log = [];
  const args = factory(log);
  try {
    const result = implementation[functionName](...args);
    // Compare retained identities without invoking getters on returned items.
    if (functionName === 'filterTrashItems' && Array.isArray(args[0]) && Array.isArray(result)) {
      return { indices: result.map((item) => args[0].indexOf(item)), log };
    }
    return { result, log };
  } catch (error) {
    return { error: error.constructor.name, log };
  }
}

function compare(functionName, factory) {
  assert.deepEqual(observe(functionName, factory, candidate),
    observe(functionName, factory, original), functionName);
}

test('trash TS matches unchanged JS across deterministic generated scalar/count inputs', (t) => {
  const seed = 0x51a7c;
  let state = seed;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const scalars = [undefined, null, false, true, 0, -0, NaN, Infinity, -Infinity,
    '', 'job', 'straße', ' İ ', 1n, Symbol('synthetic'), [], {}, Object.create(null)];
  for (let index = 0; index < 400; index += 1) {
    const value = index < scalars.length ? scalars[index] : (next() - 0x80000000) / (index % 3 === 0 ? 8 : 1);
    compare('typedDeletePhrase', () => [value]);
    const counts = { a: value, b: scalars[next() % scalars.length], c: (next() % 9) - 4 };
    compare('trashBlockerText', () => [{ blockerCounts: counts }]);
    compare('lifecycleErrorText', () => [{ code: index % 11 === 0 ? 'revision_conflict' : 'other', message: value, counts }]);
  }
  t.diagnostic(`seed=${seed}; 400 inputs x 3 helpers = 1200 differential observations`);
});

test('trash TS preserves property access and coercion order including propagated errors', () => {
  for (const failAt of ['', 'blockerCounts', 'ownKeys', 'a', 'b']) {
    compare('trashBlockerText', (log) => {
      const counts = new Proxy({ a: 1, b: 2 }, {
        ownKeys(target) {
          log.push('ownKeys');
          if (failAt === 'ownKeys') throw new RangeError('synthetic');
          return Reflect.ownKeys(target);
        },
        get(target, key) {
          log.push(String(key));
          if (key === failAt) throw new TypeError('synthetic');
          return Reflect.get(target, key);
        },
      });
      return [{ get blockerCounts() {
        log.push('blockerCounts');
        if (failAt === 'blockerCounts') throw new Error('synthetic');
        return counts;
      } }];
    });
  }
  for (const conflict of [true, false]) {
    for (const failAt of ['', 'code', 'counts', 'message', 'coerce']) {
      compare('lifecycleErrorText', (log) => [new Proxy({}, {
        get(_target, key) {
          log.push(String(key));
          if (key === failAt) throw new RangeError('synthetic');
          if (key === 'code') return conflict ? 'revision_conflict' : 'other';
          if (key === 'counts') return { a: 1 };
          if (key === 'message') return { [Symbol.toPrimitive](hint) {
            log.push(`coerce:${hint}`);
            if (failAt === 'coerce') throw new TypeError('synthetic');
            return 'synthetic';
          } };
        },
      })]);
    }
  }
  compare('typedDeletePhrase', (log) => [{ [Symbol.toPrimitive](hint) {
    log.push(hint);
    return 'straße';
  } }]);
  compare('typedDeletePhrase', (log) => [{ [Symbol.toPrimitive](hint) {
    log.push(hint);
    throw new RangeError('synthetic');
  } }]);
});

test('trash TS preserves filtering identities, order, sparse semantics and callback access', () => {
  for (const implementation of [original, candidate]) {
    const first = Object.freeze({ type: 'job' });
    const other = Object.freeze({ type: 'answer' });
    const last = Object.freeze({ type: 'job' });
    const items = Object.freeze([first, , other, last]);
    const filtered = implementation.filterTrashItems(items, 'job');
    assert.deepEqual(filtered, [first, last]);
    assert.equal(filtered[0], first);
    assert.equal(filtered[1], last);
    assert.notEqual(filtered, items);
    assert.deepEqual(implementation.filterTrashItems(items), [first, other, last]);
    assert.equal(1 in items, false);
    assert.equal(items.length, 4);
  }
  for (const filter of [undefined, '', false, 0, 'job', 1, Symbol('synthetic')]) {
    compare('filterTrashItems', (log) => [[0, 1, 2].map((index) => ({ get type() {
      log.push(index);
      if (index === 2) throw new RangeError('synthetic');
      return index === 0 ? 'job' : 1;
    } })), filter]);
    compare('filterTrashItems', () => [[null, undefined, 'job'], filter]);
  }
  compare('filterTrashItems', (log) => [{ filter(callback) {
    log.push('custom-filter');
    return callback({ type: 'job' }) ? 'accepted' : 'rejected';
  } }, 'job']);
  for (const value of [null, undefined, 0, false, '', {}, 'job', 1, true]) {
    compare('filterTrashItems', () => [value]);
  }
});

test('trash TS retains own-enumerable count semantics and leaves frozen inputs unchanged', () => {
  const counts = Object.create({ inherited: 50 });
  counts.visible = 1;
  counts[Symbol('ignored')] = 100;
  Object.defineProperty(counts, 'hidden', { value: 25 });
  Object.freeze(counts);
  const item = Object.freeze({ blockerCounts: counts });
  const error = Object.freeze({ message: 'synthetic', counts });
  for (const implementation of [original, candidate]) {
    assert.equal(implementation.trashBlockerText(item), '1 protected reference');
    assert.equal(implementation.lifecycleErrorText(error), 'synthetic (1 protected reference.)');
  }
  assert.equal(counts.visible, 1);
  assert.deepEqual(Object.keys(counts), ['visible']);
  for (const values of [[Number.MAX_VALUE, Number.MAX_VALUE], [-1, 1], [1n, true, '1'], [NaN, Infinity]]) {
    compare('trashBlockerText', () => [{ blockerCounts: values }]);
    compare('lifecycleErrorText', () => [{ counts: values }]);
  }
});
