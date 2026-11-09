import assert from 'node:assert/strict';
import test from 'node:test';
import { PythonObject } from '../runtime/contracts/python-object.js';
import { fromLegacyMap, toLegacyMap } from '../runtime/contracts/python-object-legacy.js';
import { PythonText } from '../runtime/contracts/python-text.js';
import { text, pairs, points, unchanged, HostileText } from './python_object_ts_support.mjs';

test('S01 content-equal keys retain first identity and insertion order', () => {
  const first = text('alpha'), equal = text('alpha'), middle = text('middle');
  assert.notEqual(first, equal);
  const object = new PythonObject();
  assert.equal(object.set(first, 1), object);
  object.set(middle, 2).set(equal, 3);
  assert.equal(object.size, 2);
  assert.equal(object.get(text('alpha')), 3);
  assert.equal(object.entries()[0][0], first);
  assert.equal(object.entries()[1][0], middle);
  assert.deepEqual(pairs(object), [[[97,108,112,104,97],3], [[109,105,100,100,108,101],2]]);
  for (const key of ['__proto__', 'constructor', 'toString']) object.set(text(key), key);
  assert.equal(object.get(text('__proto__')), '__proto__');
});

test('S01 literal pair scalar lone empty and NUL keys remain distinct', () => {
  const keys = [[0x10000], [0xd800,0xdc00], [], [0xe000], [0xd800], [0xdc00], [0], [97]];
  const object = new PythonObject();
  keys.forEach((key, index) => object.set(text(key), index));
  assert.equal(object.size, 8);
  keys.forEach((key, index) => assert.equal(object.get(text(key)), index));
  assert.deepEqual(points(object), keys);
  const sorted = object.entries().map(([key]) => key).sort((a,b) => a.compare(b));
  assert.deepEqual(sorted.map(key => Array.from(key.codePoints)),
    [[],[0],[97],[0xd800],[0xd800,0xdc00],[0xdc00],[0xe000],[0x10000]]);
  assert.deepEqual(points(object), keys);
});

test('S01 deletion returns presence and reinsertion preserves dictionary order', () => {
  const object = new PythonObject(), oldB = text('b'), newB = text('b');
  object.set(text('a'), 1).set(oldB, 2).set(text('c'), 3);
  assert.equal(object.delete(text('b')), true);
  assert.equal(object.delete(text('b')), false);
  object.set(newB, 4).set(text('a'), 5);
  assert.deepEqual(pairs(object), [[[97],5],[[99],3],[[98],4]]);
  assert.equal(object.entries()[2][0], newB);
  const before = object.entries();
  assert.equal(object.delete(text('missing')), false);
  assert.deepEqual(object.entries(), before);
});

test('S01 missing lookup differs from present null and undefined', () => {
  const object = new PythonObject(), fallback = {};
  object.set(text('present'), null).set(text('undefined'), undefined);
  assert.equal(object.has(text('missing')), false);
  assert.equal(object.has(text('present')), true);
  assert.equal(object.has(text('undefined')), true);
  assert.equal(object.get(text('missing')), undefined);
  assert.equal(object.get(text('missing'), fallback), fallback);
  assert.equal(object.get(text('present'), false), null);
  assert.equal(object.get(text('undefined'), fallback), undefined);
  assert.equal(object.size, 2);
});

test('S01 opaque values retain numeric shared and cyclic identity', () => {
  const object = new PythonObject(), integer = { kind: 'int', value: 1n }, float = { kind: 'float', value: 1 };
  const values = [null, false, true, integer, float, -0, 9007199254740993n, '', [], new PythonObject()];
  values.forEach((value, index) => object.set(text(String(index)), value));
  values.forEach((value, index) => assert.ok(Object.is(object.get(text(String(index))), value)));
  const shared = [];
  object.set(text('first'), shared).set(text('second'), shared);
  object.get(text('first')).push(7);
  assert.equal(object.get(text('second')), shared);
  assert.deepEqual(shared, [7]);
  object.set(text('self'), object).set(text('alias'), object);
  assert.equal(object.get(text('self')), object);
  assert.equal(object.get(text('alias')), object.get(text('self')));
});

test('S01 entry snapshots protect structure while retaining value references', () => {
  const object = new PythonObject(), key = text('a'), value = [];
  object.set(key, value);
  const before = object.entries(), second = object.entries();
  assert.notEqual(before, second); assert.notEqual(before[0], second[0]);
  assert.ok(Object.isFrozen(before)); assert.ok(Object.isFrozen(before[0]));
  assert.throws(() => before.push([text('b'), 2]), TypeError);
  assert.throws(() => { before[0][0] = text('b'); }, TypeError);
  assert.throws(() => { before[0][1] = []; }, TypeError);
  before[0][1].push(7);
  assert.equal(object.get(key), value); assert.deepEqual(value, [7]);
  object.set(key, 3).set(text('b'), 4).delete(key);
  assert.equal(before.length, 1); assert.equal(before[0][0], key); assert.equal(before[0][1], value);
  assert.deepEqual(pairs(object), [[[98],4]]);
  assert.deepEqual(Reflect.ownKeys(object), []);
  assert.throws(() => JSON.stringify(object), TypeError);
  assert.throws(() => JSON.stringify(new PythonObject()), TypeError);
});

test('S01 runtime key validation cannot forge content identity', () => {
  const object = new PythonObject(), genuine = new HostileText([97]);
  object.set(genuine, 1).set(text('a'), 2);
  assert.equal(object.get(genuine), 2); assert.equal(object.get(text('a')), 2);
  assert.equal(object.entries()[0][0], genuine);
  for (const invalid of [null, undefined, 'a', 1, {}, Object.create(PythonText.prototype),
    { contentKey: () => 'python-text:61' }, new Proxy(text('a'), {})]) {
    for (const operation of [() => object.set(invalid, 9), () => object.get(invalid),
      () => object.has(invalid), () => object.delete(invalid)]) unchanged(object, operation);
  }
  assert.throws(() => PythonObject.prototype.entries.call(Object.create(PythonObject.prototype)), TypeError);
  assert.equal(object.delete(genuine), true);
});

test('S01 legacy Map ingress preserves representable keys and value identity', () => {
  const source = new Map(), shared = [];
  for (const key of ['', '\0', 'a', '\ud800', '\udc00', '\ud800\udc00']) source.set(key, shared);
  source.set('self', source);
  source[Symbol.iterator] = () => { throw new Error('custom iterator'); };
  source.entries = () => { throw new Error('custom entries'); };
  const object = fromLegacyMap(source);
  assert.deepEqual(points(object), [[],[0],[97],[0xd800],[0xdc00],[0x10000],[115,101,108,102]]);
  assert.equal(object.get(text('self')), source);
  assert.equal(object.get(text('a')), shared);
  shared.push(7); assert.deepEqual(object.get(text('a')), [7]);
  source.set('later', 9); assert.equal(object.has(text('later')), false);
  object.set(text('other'), 8); assert.equal(source.has('other'), false);
  for (const invalid of [null, {}, Object.create(Map.prototype), new Proxy(new Map(), {})]) {
    assert.throws(() => fromLegacyMap(invalid), TypeError);
  }
  const invalid = new Map([['valid', shared], [1, 2]]), before = Array.from(invalid);
  assert.throws(() => fromLegacyMap(invalid), TypeError);
  assert.deepEqual(Array.from(invalid), before); assert.equal(invalid.get('valid'), shared);
});

test('S01 legacy Map egress rejects lossy pairs without source mutation', () => {
  const object = new PythonObject(), shared = [];
  for (const key of [[],[0],[0xd800],[0xdc00],[0x10000],[0xd800,97,0xdc00]]) object.set(text(key), shared);
  object.set(new HostileText([98]), shared).set(text('self'), object);
  const legacy = toLegacyMap(object);
  assert.deepEqual(Array.from(legacy.keys()), ['', '\0', '\ud800', '\udc00', '\ud800\udc00', '\ud800a\udc00', 'b', 'self']);
  assert.equal(legacy.get('self'), object); assert.equal(legacy.get('b'), shared);
  legacy.delete('b'); assert.equal(object.has(text('b')), true);
  object.set(text('later'), 3); assert.equal(legacy.has('later'), false);
  for (const reverse of [false, true]) {
    const lossy = new PythonObject(), keys = [[0xd800,0xdc00],[0x10000]];
    if (reverse) keys.reverse();
    keys.forEach((key,index) => lossy.set(text(key), index));
    unchanged(lossy, () => toLegacyMap(lossy));
  }
  for (const invalid of [null, {}, Object.create(PythonObject.prototype), new Proxy(object, {})]) {
    assert.throws(() => toLegacyMap(invalid), TypeError);
  }
});

test('S01 large keys avoid argument-spread limits and retain exact lookup', () => {
  const large = Array(200000).fill(97); large[100000] = 0x10000;
  const object = new PythonObject(), key = text(large);
  object.set(key, 7);
  assert.equal(object.get(text(large)), 7);
  const legacy = toLegacyMap(object), string = Array.from(legacy.keys())[0];
  assert.equal(string.length, 200001); assert.equal(legacy.get(string), 7);
  assert.deepEqual(points(fromLegacyMap(legacy)), [large]);
  const across = [...Array(4095).fill(97), 0xd800, 0xdc00, 98];
  const lossy = new PythonObject().set(text(across), 8);
  unchanged(lossy, () => toLegacyMap(lossy));
});
