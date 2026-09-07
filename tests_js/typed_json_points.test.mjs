import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PythonText } from '../runtime/contracts/python-text.js';
import { PythonObject } from '../runtime/contracts/python-object.js';
import { decodePythonJsonBytes, detectPythonJsonEncoding, PythonUnicodeDecodeError } from '../runtime/contracts/python-json-bytes.js';
import { parsePythonPointJson, parsePythonPointJsonBytes, PythonPointJsonDecodeError, PythonPointJsonValueError } from '../runtime/contracts/raw-json/point-parser.js';
import { serializePythonPointScope, PythonPointJsonCircularError } from '../runtime/contracts/raw-json/point-serializer.js';

// Normative data was fixed independently before the implementation activation.
const hashes = {
  'composed-reference-vectors.json': '1ccb7cdb553cd70a1f6107904b595c4a9c9ea720e9d8c5cbc48955233f280e7b',
  'additional-reference-vectors.json': '500ce6a2f35ac9f9e0bfe9ec8a676d0aa1165687a768f53e3bffeacf5048225d',
};
function fixture(name) {
  const bytes = readFileSync(new URL(`../docs/migration/evidence/s08/${name}`, import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), hashes[name]);
  const value = JSON.parse(bytes);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.profiles.length, 3);
  return value;
}
const composed = fixture('composed-reference-vectors.json');
const additional = fixture('additional-reference-vectors.json');
const pointText = points => PythonText.fromCodePoints(points);
const options = (version, limit = 640) => ({ diagnosticProfile: version.split('.').slice(0, 2).join('.'), intMaxStrDigits: limit });

// Independent binary64 projection, not the scope formatter under test.
function floatHex(value) {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value < 0 ? '-inf' : 'inf';
  const buffer = new ArrayBuffer(8), view = new DataView(buffer);
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0), sign = bits >> 63n ? '-' : '';
  const exponent = Number(bits >> 52n & 2047n), fraction = bits & 0xfffffffffffffn;
  if (!exponent && !fraction) return `${sign}0x0.0p+0`;
  const power = exponent ? exponent - 1023 : -1022;
  return `${sign}0x${exponent ? 1 : 0}.${fraction.toString(16).padStart(13, '0')}p${power >= 0 ? '+' : ''}${power}`;
}
function typed(value) {
  if (value === null) return { kind: 'null' };
  if (typeof value === 'boolean') return { kind: 'boolean', value };
  if (value instanceof PythonText) return { kind: 'text', points: [...value.codePoints] };
  if (Array.isArray(value)) return { kind: 'array', items: value.map(typed) };
  if (value instanceof PythonObject) return { kind: 'object', entries: value.entries().map(([key, item]) => [[...key.codePoints], typed(item)]) };
  if (value.kind === 'int') return { kind: 'integer', decimal: value.value.toString() };
  assert.equal(value.kind, 'float');
  return { kind: 'float', hex: floatHex(value.value) };
}
function outcome(row, settings) {
  const document = pointText(row.documentPoints);
  try {
    const value = row.inputHex == null ? parsePythonPointJson(document, settings)
      : parsePythonPointJsonBytes(Buffer.from(row.inputHex, 'hex'), settings);
    const ascii = serializePythonPointScope(value);
    return { kind: 'value', value: typed(value), ascii,
      asciiReload: typed(parsePythonPointJson(PythonText.fromJavaScript(ascii), settings)) };
  } catch (error) {
    if (error instanceof PythonPointJsonDecodeError) {
      assert.deepEqual(error.doc.codePoints, document.codePoints);
      assert.equal(error.name, 'JSONDecodeError');
      return { kind: 'error', name: error.name, message: error.message, reason: error.msg,
        position: error.pos, line: error.lineno, column: error.colno, documentPoints: [...error.doc.codePoints] };
    }
    assert.ok(error instanceof PythonPointJsonValueError);
    return { kind: 'error', name: error.name, message: error.message };
  }
}
function assertRows(rows, version, count) {
  assert.equal(rows.length, count);
  assert.equal(new Set(rows.map(row => row.id)).size, count);
  for (const row of rows) {
    assert.ok(row.documentPoints.every(point => Number.isInteger(point) && point >= 0 && point <= 0x10ffff));
    assert.deepEqual(outcome(row, options(version, row.intMaxStrDigits ?? 640)), row.outcome, `${version}:${row.id}`);
  }
}

test('S08 point parser preserves all 38 independently fixed document outcomes', () => {
  for (const profile of composed.profiles) assertRows(profile.cases, profile.version, 38);
});

test('S08 point parser preserves all 48 supplemental diagnostic and numeric outcomes', () => {
  for (const profile of additional.profiles) assertRows(profile.receipt.cases, profile.receipt.profile.version, 48);
});

test('S08 point objects preserve ordered content keys and numeric identities', () => {
  for (const profile of composed.profiles) {
    const row = profile.cases.find(item => item.id === 'key-pair-scalar-overwrite');
    const value = parsePythonPointJson(pointText(row.documentPoints), options(profile.version));
    assert.ok(value instanceof PythonObject);
    assert.equal(value.size, 2);
    const entries = value.entries();
    assert.deepEqual(entries.map(([key]) => [...key.codePoints]), [[0xd800, 0xdc00], [0x10000]]);
    assert.equal(value.get(pointText([0xd800, 0xdc00])).value, 1n);
    assert.equal(value.get(pointText([0x10000])).kind, 'float');
    assert.equal(value.get(pointText([0x10000])).value, 3);
    assert.equal(value.entries()[0][0], entries[0][0]);
  }
  const object = parsePythonPointJson(PythonText.fromJavaScript('{"":0,"\\u0000":1,"__proto__":2,"constructor":3}'), options('3.12'));
  assert.deepEqual(object.entries().map(([key]) => [...key.codePoints]), [[], [0], Array.from('__proto__', c => c.codePointAt(0)), Array.from('constructor', c => c.codePointAt(0))]);
  assert.equal(object.get(pointText([0])).value, 1n);
});

test('S08 point diagnostics preserve exact documents coordinates and profile differences', () => {
  for (const profile of composed.profiles) {
    for (const row of profile.cases.filter(item => item.outcome.name === 'JSONDecodeError')) {
      const document = pointText(row.documentPoints);
      assert.throws(() => parsePythonPointJson(document, options(profile.version)), error => {
        assert.ok(error instanceof PythonPointJsonDecodeError);
        assert.equal(error.doc, document);
        assert.equal(error.name, 'JSONDecodeError');
        assert.equal(error.message, row.outcome.message);
        assert.equal(error.pos, row.outcome.position);
        assert.equal(error.lineno, row.outcome.line);
        assert.equal(error.colno, row.outcome.column);
        error.context = new Error('outer');
        assert.equal(error.context.message, 'outer');
        assert.ok(Object.isFrozen(error.doc.codePoints));
        return true;
      });
    }
  }
});

test('S08 point byte composition preserves decoding errors and codepoint identity', () => {
  const rows = composed.profiles[0].cases.filter(row => row.inputHex !== null);
  assert.equal(rows.length, 6);
  for (const row of rows) {
    const owner = Buffer.concat([Buffer.from([0xff]), Buffer.from(row.inputHex, 'hex'), Buffer.from([0xff])]);
    const view = owner.subarray(1, owner.length - 1);
    assert.equal(detectPythonJsonEncoding(view), row.detectedEncoding);
    assert.deepEqual(decodePythonJsonBytes(view).codePoints, row.documentPoints);
    const parsed = parsePythonPointJsonBytes(view, options('3.12'));
    owner.fill(0);
    assert.deepEqual(typed(parsed), row.outcome.value);
  }
  for (const [hex, encoding, objectHex, start, end, reason, message] of [
    ['ff', 'utf-8', 'ff', 0, 1, 'invalid start byte', "'utf-8' codec can't decode byte 0xff in position 0: invalid start byte"],
    ['efbbbfff', 'utf-8', 'ff', 0, 1, 'invalid start byte', "'utf-8' codec can't decode byte 0xff in position 0: invalid start byte"],
    ['fffe2200ff', 'utf-16-le', 'fffe2200ff', 4, 5, 'truncated data', "'utf-16-le' codec can't decode byte 0xff in position 4: truncated data"],
  ]) {
    const input = Buffer.from(hex, 'hex');
    assert.throws(() => parsePythonPointJsonBytes(input, options('3.12')), error => {
      assert.ok(error instanceof PythonUnicodeDecodeError);
      assert.deepEqual([error.encoding, error.object.toString('hex'), error.start, error.end, error.reason, error.message],
        [encoding, objectHex, start, end, reason, message]);
      input.fill(0); error.object.fill(0);
      assert.equal(error.object.toString('hex'), objectHex);
      return true;
    });
  }
  const invalidJson = Buffer.from('22eda080edb080222030', 'hex');
  assert.throws(() => parsePythonPointJsonBytes(invalidJson, options('3.12')), error => {
    assert.ok(error instanceof PythonPointJsonDecodeError);
    assert.equal(error.pos, 5);
    assert.deepEqual(error.doc.codePoints, [34, 0xd800, 0xdc00, 34, 32, 48]);
    return true;
  });
});

test('S08 point serializer preserves all three frozen graph outcomes and ASCII reload distinctions', () => {
  assert.equal(composed.serializers.length, 3);
  const shared = [pointText([0xd800, 0xdc00])], graph = [shared, shared];
  assert.equal(graph[0], graph[1]);
  const expected = composed.serializers.find(row => row.id === 'shared-array').outcome;
  assert.equal(expected.sameChildIdentity, true);
  assert.deepEqual(typed(graph), expected.value);
  assert.equal(serializePythonPointScope(graph), expected.ascii);
  assert.deepEqual(graph[0][0].codePoints, [0xd800, 0xdc00]);
  const array = []; array.push(array);
  const object = new PythonObject(); object.set(PythonText.fromJavaScript('self'), object);
  for (const [id, value] of [['cycle-array', array], ['cycle-object', object]]) {
    const expectedError = composed.serializers.find(row => row.id === id).outcome;
    assert.throws(() => serializePythonPointScope(value), error => {
      assert.ok(error instanceof PythonPointJsonCircularError);
      assert.equal(error.name, expectedError.name);
      assert.equal(error.message, expectedError.message);
      error.context = null;
      return true;
    });
  }
});

test('S08 point API rejects invalid runtime inputs without implicit conversion', () => {
  for (const value of [undefined, null, '', [], {}, 1, Object.create(PythonText.prototype)]) {
    assert.throws(() => parsePythonPointJson(value, options('3.12')), TypeError);
  }
  for (const value of [undefined, null, '', [], {}, new Uint8Array([48]), new ArrayBuffer(1), Object.create(Buffer.prototype)]) {
    assert.throws(() => parsePythonPointJsonBytes(value, options('3.12')), TypeError);
  }
  const text = PythonText.fromJavaScript('0');
  for (const config of [undefined, null, 1, 'options']) assert.throws(() => parsePythonPointJson(text, config), TypeError);
  for (const limit of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '640', null]) {
    assert.throws(() => parsePythonPointJson(null, { intMaxStrDigits: limit, diagnosticProfile: '3.12' }), RangeError);
  }
  for (const profile of [undefined, null, 12, {}, '3.11', '3.12.13']) {
    assert.throws(() => parsePythonPointJson(text, { intMaxStrDigits: 640, diagnosticProfile: profile }), TypeError);
  }
  let called = false;
  const deceptive = { toString() { called = true; return 'null'; }, toJSON() { called = true; return null; } };
  for (const value of [undefined, 1, 1n, 'text', new Map(), deceptive, { kind: 'int', value: 1, scope: '1' }]) {
    assert.throws(() => serializePythonPointScope(value), TypeError);
  }
  assert.equal(called, false);
  class AlternateText extends PythonText {
    get codePoints() { throw new Error('untrusted codePoints'); }
    get length() { throw new Error('untrusted length'); }
    compare() { throw new Error('untrusted compare'); }
    contentKey() { throw new Error('untrusted contentKey'); }
  }
  const document = new AlternateText([110, 117, 108, 108]);
  assert.equal(parsePythonPointJson(document, options('3.12')), null);
  const invalid = new AlternateText([91, 10, 63, 93]);
  assert.throws(() => parsePythonPointJson(invalid, options('3.12')), error => {
    assert.ok(error instanceof PythonPointJsonDecodeError);
    assert.equal(error.doc, invalid);
    assert.deepEqual([error.pos, error.lineno, error.colno], [2, 2, 1]);
    return true;
  });
  class AlternateObject extends PythonObject {
    entries() { throw new Error('untrusted entries'); }
  }
  const object = new AlternateObject();
  object.set(new AlternateText([98]), true);
  object.set(new AlternateText([97]), false);
  assert.equal(serializePythonPointScope(object), '{"a":false,"b":true}');
  assert.equal(serializePythonPointScope(new AlternateText([0xd800, 0xdc00])), '"\\ud800\\udc00"');
});
