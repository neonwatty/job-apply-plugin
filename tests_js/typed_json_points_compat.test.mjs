import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PythonText } from '../runtime/contracts/python-text.js';
import { PythonObject } from '../runtime/contracts/python-object.js';
import { parsePythonJson, PythonJsonError } from '../runtime/contracts/raw-json/parser.js';
import { serializePythonScope } from '../runtime/contracts/raw-json/serializer.js';
import { parsePythonPointJson, PythonPointJsonDecodeError, PythonPointJsonValueError } from '../runtime/contracts/raw-json/point-parser.js';
import { serializePythonPointScope, PythonPointJsonCircularError } from '../runtime/contracts/raw-json/point-serializer.js';
import { NumericAtomError, parseNumericAtom } from '../runtime/contracts/raw-json/numeric-atom.js';
import { readJsonObject } from '../runtime/store/read-json-object.js';
import { StoreValidationError } from '../runtime/store/validation.js';

const settings = { intMaxStrDigits: 640, diagnosticProfile: '3.12' };
const text = points => PythonText.fromCodePoints(points);
const parse = raw => parsePythonPointJson(PythonText.fromJavaScript(raw), settings);
const legacy = raw => parsePythonJson(raw, settings);
const cp = raw => Array.from(raw, character => character.codePointAt(0));
const quote = points => [34, ...points, 34];
const pair = [0xd800, 0xdc00];
const scalar = [0x10000];

test('S08 shared parser preserves legacy mixed surrogate values and Map keys', () => {
  const rawPoints = [quote(pair), quote(scalar), cp('"\\ud800\\udc00"'),
    quote([0xd800, ...cp('\\udc00')]), quote([...cp('\\ud800'), 0xdc00])];
  for (const [index, points] of rawPoints.entries()) {
    const raw = points.map(point => String.fromCodePoint(point)).join('');
    assert.equal(legacy(raw), '\ud800\udc00');
    const value = parsePythonPointJson(text(points), settings);
    assert.deepEqual(value.codePoints, index === 1 || index === 2 ? scalar : pair);
    assert.equal(serializePythonScope(legacy(raw)), '"\\ud800\\udc00"');
    assert.equal(serializePythonPointScope(value), '"\\ud800\\udc00"');
  }
  const points = [...cp('{"'), ...pair, ...cp('":1,"'), ...scalar,
    ...cp('":2,"'), 0xd800, ...cp('\\udc00":3}')];
  const raw = points.map(point => String.fromCodePoint(point)).join('');
  const old = legacy(raw), rich = parsePythonPointJson(text(points), settings);
  assert.ok(old instanceof Map);
  assert.equal(old.size, 1);
  assert.equal(old.get('\ud800\udc00').value, 3n);
  assert.ok(rich instanceof PythonObject);
  assert.equal(rich.size, 2);
  assert.equal(rich.get(text(pair)).value, 3n);
  assert.equal(rich.get(text(scalar)).value, 2n);
  assert.equal(serializePythonScope(old), '{"\\ud800\\udc00":3}');
  assert.equal(serializePythonPointScope(rich), '{"\\ud800\\udc00":3,"\\ud800\\udc00":2}');
});

test('S08 legacy errors retain class identity offsets and configuration precedence', async t => {
  // Fixed old parser offsets, independently read from the frozen pre-extraction engine.
  for (const [raw, offset] of [
    ['["😀",?]', 5], ['{"😀":?}', 5], ['"😀" x', 4], ['[1,]', 3], ['{"x":1,}', 7],
    ['"\\u12"', 2], ['"\\q"', 1], ['"\\', 0], ['\ufeff{}', 0],
    ['["\ud800\\udc00",?]', 11], ['["\\ud800\udc00",?]', 11],
  ]) {
    assert.throws(() => legacy(raw), error => {
      assert.ok(error instanceof PythonJsonError);
      assert.equal(error.name, 'PythonJsonError');
      assert.equal(error.reason, 'syntax');
      assert.equal(error.offset, offset);
      assert.equal(error.message, `Invalid JSON at code-point offset ${offset}`);
      return true;
    }, raw);
  }
  assert.throws(() => parsePythonJson(null, { intMaxStrDigits: -1 }), RangeError);
  const directory = await mkdtemp(join(tmpdir(), 's08-json-read-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'document.json');
  await writeFile(path, '{bad');
  await assert.rejects(readJsonObject(path, 'fixture', settings), error => {
    assert.ok(error instanceof StoreValidationError);
    assert.equal(error.message, `cannot read valid fixture JSON at ${path}`);
    return true;
  });
  await writeFile(path, '{"n":' + '9'.repeat(641) + '}');
  await assert.rejects(readJsonObject(path, 'fixture', settings), NumericAtomError);
  await assert.rejects(readJsonObject(path, 'fixture', { intMaxStrDigits: -1 }), RangeError);
  await writeFile(path, '{"n":1}');
  const read = await readJsonObject(path, 'fixture', settings);
  assert.ok(read instanceof Map);
  assert.equal(read.get('n').value, 1n);
});

test('S08 shared numeric parsing preserves digit limits signed zero and nonfinite values', () => {
  const raw = '[9007199254740993,1.0,-0,-0.0,1e999,-1e999,NaN,5e-324]';
  const old = legacy(raw), rich = parse(raw);
  assert.equal(rich[0].value, 9007199254740993n);
  assert.equal(rich[1].kind, 'float');
  assert.equal(rich[2].value, 0n);
  assert.ok(Object.is(rich[3].value, -0));
  assert.equal(rich[4].value, Infinity);
  assert.equal(rich[5].value, -Infinity);
  assert.ok(Number.isNaN(rich[6].value));
  assert.equal(rich[7].value, Number.MIN_VALUE);
  assert.deepEqual(rich, old);
  assert.equal(serializePythonPointScope(rich), '[9007199254740993,1.0,0,-0.0,Infinity,-Infinity,NaN,5e-324]');
  const many = '9'.repeat(641);
  assert.throws(() => legacy(many), error => error instanceof NumericAtomError && error.reason === 'integer-digit-limit');
  assert.throws(() => parse(many), error => {
    assert.ok(error instanceof PythonPointJsonValueError);
    assert.equal(error.name, 'ValueError');
    assert.equal(error.message, 'Exceeds the limit (640 digits) for integer string conversion: value has 641 digits; use sys.set_int_max_str_digits() to increase the limit');
    return true;
  });
  assert.equal(parsePythonPointJson(PythonText.fromJavaScript(many), { ...settings, intMaxStrDigits: 0 }).value, BigInt(many));
  assert.equal(parsePythonJson(many, { intMaxStrDigits: 0 }).value, BigInt(many));
  assert.equal(parsePythonPointJson(PythonText.fromJavaScript('99'), { ...settings, intMaxStrDigits: 2 }).value, 99n);
  assert.throws(() => parsePythonPointJson(PythonText.fromJavaScript('999'), { ...settings, intMaxStrDigits: 2 }), PythonPointJsonValueError);
  for (const raw of ['01', '-01', '+1', '1.', '1e+', '-NaN', '[1.]']) {
    assert.throws(() => legacy(raw), PythonJsonError);
    assert.throws(() => parse(raw), PythonPointJsonDecodeError);
  }
});

test('S08 shared engines handle 2000 levels without recursive traversal', () => {
  for (const kind of ['array', 'alternating']) {
    const opening = [], closing = [];
    for (let index = 0; index < 2000; index++) {
      const object = kind === 'alternating' && index % 2;
      opening.push(object ? '{"x":' : '[');
      closing.unshift(object ? '}' : ']');
    }
    const raw = opening.join('') + 'null' + closing.join('');
    assert.equal(serializePythonScope(legacy(raw)), raw);
    assert.equal(serializePythonPointScope(parse(raw)), raw);
    const invalid = opening.join('') + '?' + closing.join('');
    assert.throws(() => parse(invalid), error => {
      assert.ok(error instanceof PythonPointJsonDecodeError);
      assert.equal(error.pos, opening.join('').length);
      return true;
    });
  }
});

test('S08 shared serializers distinguish active cycles from shared acyclic containers', () => {
  const atom = parseNumericAtom('1', settings), key = text([120]);
  const object = new PythonObject(); object.set(key, atom);
  const graph = [object, object];
  assert.equal(serializePythonPointScope(graph), '[{"x":1},{"x":1}]');
  assert.equal(graph[0], graph[1]);
  assert.equal(object.get(key), atom);
  const array = [], mixed = new PythonObject(); array.push(mixed); mixed.set(key, array);
  assert.throws(() => serializePythonPointScope(array), error => error instanceof PythonPointJsonCircularError && error.message === 'Circular reference detected');
  mixed.delete(key);
  assert.equal(serializePythonPointScope(array), '[{}]');
  const old = [], oldObject = new Map(); old.push(oldObject); oldObject.set('x', old);
  assert.throws(() => serializePythonScope(old), error => error instanceof TypeError && error.message === 'Circular JSON value');
  oldObject.delete('x');
  assert.equal(serializePythonScope([oldObject, oldObject]), '[{},{}]');
});

test('S08 long text and key inputs preserve immutable point identity without spread limits', () => {
  const points = Array.from({ length: 160000 }, (_, index) => index % 2 ? 0xdc00 : 0xd800);
  const document = text([34].concat(points, [34]));
  const rich = parsePythonPointJson(document, settings);
  assert.deepEqual(rich.codePoints, points);
  points[0] = 65;
  assert.equal(rich.codePoints[0], 0xd800);
  const ascii = serializePythonPointScope(rich);
  assert.equal(ascii, '"' + '\\ud800\\udc00'.repeat(80000) + '"');
  const keyPoints = Array.from({ length: 100000 }, () => 97).concat(pair);
  const input = text(cp('{"').concat(keyPoints, cp('":true}')));
  const object = parsePythonPointJson(input, settings);
  assert.equal(object.get(text(keyPoints)), true);
  assert.equal(object.has(text(keyPoints.slice(0, -2).concat(scalar))), false);
  assert.deepEqual(input.codePoints, cp('{"').concat(keyPoints, cp('":true}')));
  assert.equal(serializePythonScope(legacy('"' + '😀'.repeat(80000) + '"')), '"' + '\\ud83d\\ude00'.repeat(80000) + '"');
});
