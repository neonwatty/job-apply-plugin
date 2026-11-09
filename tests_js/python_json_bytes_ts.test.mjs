import assert from 'node:assert/strict';
import test from 'node:test';
import { PythonText } from '../runtime/contracts/python-text.js';
import { decodePythonJsonBytes, detectPythonJsonEncoding, PythonUnicodeDecodeError } from '../runtime/contracts/python-json-bytes.js';
import { expected, success, failures } from './python_json_bytes_ts_support.mjs';

function observed(inputHex) {
  const bytes = Buffer.from(inputHex, 'hex');
  const detectedEncoding = detectPythonJsonEncoding(bytes);
  try {
    const result = decodePythonJsonBytes(bytes);
    assert.ok(result instanceof PythonText);
    return { inputHex, detectedEncoding,
      outcome: { kind: 'text', codepoints: [...result.codePoints], length: result.length } };
  } catch (error) {
    if (!(error instanceof PythonUnicodeDecodeError)) throw error;
    return { inputHex, detectedEncoding, outcome: { kind: 'error', name: error.name,
      encoding: error.encoding, objectHex: error.object.toString('hex'), start: error.start,
      end: error.end, reason: error.reason, message: error.message } };
  }
}
function verifyRows(rows) {
  for (const row of rows) assert.deepEqual({ id: row.id, ...observed(row.inputHex) }, row, row.id);
}
function errorFor(hex) {
  try { decodePythonJsonBytes(Buffer.from(hex, 'hex')); }
  catch (error) { assert.ok(error instanceof PythonUnicodeDecodeError); return error; }
  assert.fail('Expected a decode error');
}

test('S02.I decoder matches all 82 frozen byte outcomes', () => {
  assert.equal(success.length, 55); assert.equal(failures.length, 27);
  assert.equal(expected.length, 82); assert.equal(new Set(expected.map(row => row.id)).size, 82);
  verifyRows(expected);
});

test('S02.I detection preserves BOM precedence and zero-byte inference', () => {
  for (const row of expected) assert.equal(detectPythonJsonEncoding(Buffer.from(row.inputHex, 'hex')), row.detectedEncoding, row.id);
  assert.equal(detectPythonJsonEncoding(Buffer.from('fffe0000', 'hex')), 'utf-32');
  assert.equal(detectPythonJsonEncoding(Buffer.from('000041', 'hex')), 'utf-8');
  assert.equal(detectPythonJsonEncoding(Buffer.from('0000', 'hex')), 'utf-16-be');
  verifyRows(expected.filter(row => /bom|interior/.test(row.id)));
});

test('S02.I UTF-8 surrogatepass preserves Python codepoint identity', () => {
  verifyRows(expected.filter(row => row.detectedEncoding.startsWith('utf-8')));
  const pair = decodePythonJsonBytes(Buffer.from('eda080edb080', 'hex'));
  const scalar = decodePythonJsonBytes(Buffer.from('f0908080', 'hex'));
  assert.deepEqual(pair.codePoints, [0xd800, 0xdc00]);
  assert.deepEqual(scalar.codePoints, [0x10000]);
  assert.equal(pair.equals(scalar), false);
  assert.notEqual(pair.contentKey(), scalar.contentKey());
  assert.deepEqual(decodePythonJsonBytes(Buffer.from(String.raw`\ud800\udc00`)).codePoints,
    [92, 117, 100, 56, 48, 48, 92, 117, 100, 99, 48, 48]);
});

test('S02.I UTF-16 combines only encoded adjacent surrogate pairs', () => {
  verifyRows(expected.filter(row => row.detectedEncoding.startsWith('utf-16')));
  const paired = decodePythonJsonBytes(Buffer.from('fffe00d800dc', 'hex'));
  assert.deepEqual(paired.codePoints, [0x10000]);
  const highOdd = errorFor('fffe00d841');
  assert.equal(highOdd.start, 4); assert.equal(highOdd.end, 5);
  assert.equal(highOdd.object.toString('hex'), 'fffe00d841');
});

test('S02.I UTF-32 preserves surrogate units and unsigned range failures', () => {
  verifyRows(expected.filter(row => row.detectedEncoding.startsWith('utf-32')));
  assert.deepEqual(decodePythonJsonBytes(Buffer.from('0000feff0000d8000000dc00', 'hex')).codePoints, [0xd800, 0xdc00]);
  assert.deepEqual(decodePythonJsonBytes(Buffer.from('0000feff0010ffff', 'hex')).codePoints, [0x10ffff]);
  // Full unsigned range must not wrap into a negative point or a valid scalar.
  const error = errorFor('0000feffffffffff');
  assert.equal(error.start, 4); assert.equal(error.end, 8);
  assert.equal(error.reason, 'code point not in range(0x110000)');
});

test('S02.I decoding errors preserve object bytes offsets reasons and messages', () => {
  verifyRows(expected.filter(row => row.outcome.kind === 'error'));
  const sig = errorFor('efbbbfff');
  assert.equal(sig.encoding, 'utf-8'); assert.equal(sig.object.toString('hex'), 'ff');
  assert.equal(sig.start, 0); assert.equal(sig.end, 1);
  assert.equal(errorFor('eda0').reason, 'invalid continuation byte');
  assert.equal(errorFor('e282').reason, 'unexpected end of data');
  assert.equal(errorFor('eda0').end, 1); assert.equal(errorFor('e282').end, 2);
  const context = new Error('owned caller context');
  sig.context = context; sig.cause = context;
  assert.equal(sig.context, context); assert.equal(sig.cause, context);
  assert.equal(Object.isFrozen(sig), false);
});

test('S02.I Buffer views and owned error bytes resist caller mutation', () => {
  const backing = Buffer.from('ffeda080edb080ff', 'hex');
  const view = backing.subarray(1, backing.length - 1);
  const before = Buffer.from(backing);
  const result = decodePythonJsonBytes(view);
  assert.deepEqual(backing, before);
  assert.deepEqual(result.codePoints, [0xd800, 0xdc00]);
  backing.fill(0);
  assert.deepEqual(result.codePoints, [0xd800, 0xdc00]);
  const badBacking = Buffer.from('00efbbbfff00', 'hex');
  const badView = badBacking.subarray(1, 5);
  let held;
  try { decodePythonJsonBytes(badView); } catch (error) { held = error; }
  assert.ok(held instanceof PythonUnicodeDecodeError);
  badBacking.fill(0);
  const exposed = held.object; exposed.fill(0);
  assert.notEqual(held.object, held.object);
  assert.equal(held.object.toString('hex'), 'ff');
  assert.equal(held.message, "'utf-8' codec can't decode byte 0xff in position 0: invalid start byte");
  const long = Buffer.alloc(200000, 65);
  const decoded = decodePythonJsonBytes(long);
  assert.equal(decoded.length, 200000); assert.equal(decoded.codePoints.at(-1), 65);
});

test('S02.I invalid JavaScript inputs fail before byte decoding', () => {
  const invalid = [null, undefined, '', 1, NaN, [], [65], {}, new Uint8Array([65]),
    new DataView(new ArrayBuffer(2)), new ArrayBuffer(2), Object.create(Buffer.prototype)];
  for (const value of invalid) {
    assert.throws(() => detectPythonJsonEncoding(value), TypeError);
    assert.throws(() => decodePythonJsonBytes(value), TypeError);
  }
  assert.deepEqual(decodePythonJsonBytes(Buffer.alloc(0)).codePoints, []);
});
