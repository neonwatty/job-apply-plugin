import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PythonText, PythonUnicodeEncodeError } from '../runtime/contracts/python-text.js';

const driver = fileURLToPath(new URL('../tools/contracts/python-text/reference.py', import.meta.url));
const ids = ['empty', 'ascii', 'scalar', 'literal-pair', 'high', 'low', 'scalar-before-error',
  'surrogate-run', 'separate-errors', 'unicode', 'below-surrogate', 'above-surrogate'];
function encoded(text) {
  try { return { hex: text.encodeUtf8().toString('hex') }; }
  catch (error) {
    assert.ok(error instanceof PythonUnicodeEncodeError);
    assert.equal(error.object, text);
    assert.ok(Object.isFrozen(error.object));
    return { error: { name: error.name, encoding: error.encoding, start: error.start,
      end: error.end, reason: error.reason, message: error.message } };
  }
}
for (const executable of ['python3', 'python3.12', 'python3.13', 'python3.14']) {
  test(`PythonText matches frozen builtin reference: ${executable}`, t => {
    const run = spawnSync(executable, ['-I', driver], { input: '', encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
    if (run.error?.code === 'ENOENT' && executable !== 'python3') return t.skip('Interpreter executable alias unavailable');
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.profile.implementation, 'CPython');
    assert.equal(receipt.profile.platform, process.platform);
    assert.match(receipt.profile.python, /^3\.(12|13|14)\.\d+$/);
    if (executable !== 'python3') assert.ok(receipt.profile.python.startsWith(`${executable.slice(6)}.`));
    const probe = spawnSync(executable, ['-I', '-c', 'import pathlib\nimport sys\nprint(pathlib.Path(sys.executable).resolve())'],
      { encoding: 'utf8', timeout: 3000, maxBuffer: 4096 });
    assert.ifError(probe.error);
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(receipt.profile.executablePath, probe.stdout.trim());
    assert.equal(receipt.profile.executableSha256,
      createHash('sha256').update(readFileSync(receipt.profile.executablePath)).digest('hex'));
    assert.deepEqual(receipt.cases.map(row => row.id), ids);
    const values = new Map(receipt.cases.map(row => [row.id, PythonText.fromCodePoints(row.points)]));
    for (const row of receipt.cases) {
      const value = values.get(row.id);
      assert.deepEqual(value.codePoints, row.points);
      assert.equal(value.length, row.length);
      assert.deepEqual(encoded(value), row.utf8);
    }
    assert.equal(receipt.comparisons.length, 12);
    for (const [left, leftId] of ids.entries()) {
      assert.equal(receipt.comparisons[left].length, 12);
      for (const [right, rightId] of ids.entries()) {
        const a = values.get(leftId);
        const b = values.get(rightId);
        const expected = receipt.comparisons[left][right];
        assert.equal(a.compare(b), expected);
        assert.equal(a.equals(b), expected === 0);
        assert.equal(a.contentKey() === b.contentKey(), expected === 0);
      }
    }
    assert.equal(receipt.joins.length, 3);
    for (const row of receipt.joins) {
      const joined = values.get(row.left).concat(values.get(row.right));
      assert.deepEqual(joined.codePoints, row.points);
      assert.deepEqual(encoded(joined), row.utf8);
    }
    t.diagnostic(`${receipt.profile.python}: 12 texts, 144 comparisons, three joins; duplicate default version is not an independent profile`);
  });
}

test('PythonText retains distinct pair/scalar identities across construction and concatenation', () => {
  const scalar = PythonText.fromJavaScript('\u{10000}');
  const pair = PythonText.fromCodePoints([0xd800, 0xdc00]);
  assert.deepEqual(scalar.codePoints, [0x10000]);
  assert.deepEqual(PythonText.fromJavaScript('\ud800').codePoints, [0xd800]);
  assert.equal(scalar.equals(pair), false);
  assert.notEqual(scalar.contentKey(), pair.contentKey());
  const joined = PythonText.fromCodePoints([0xd800]).concat(PythonText.fromCodePoints([0xdc00]));
  assert.equal(joined.equals(pair), true);
  assert.notEqual(joined, pair);
  assert.equal(joined.contentKey(), pair.contentKey());
  assert.notEqual(PythonText.fromCodePoints([1, 35]).contentKey(), PythonText.fromCodePoints([18, 3]).contentKey());
  assert.equal(pair.concat().equals(pair), true);
  assert.equal(PythonText.fromCodePoints([-0]).equals(PythonText.fromCodePoints([0])), true);
  assert.equal(Object.is(PythonText.fromCodePoints([-0]).codePoints[0], -0), false);
});

test('PythonText defensively freezes content and preserves immutable error originals', () => {
  const input = [65, 0xd800, 0xdc00];
  const text = PythonText.fromCodePoints(input);
  input[1] = 66;
  assert.deepEqual(text.codePoints, [65, 0xd800, 0xdc00]);
  assert.ok(Object.isFrozen(text));
  assert.ok(Object.isFrozen(text.codePoints));
  assert.throws(() => { text.codePoints[1] = 66; }, TypeError);
  assert.throws(() => text.codePoints.push(66), TypeError);
  assert.throws(() => { text.codePoints = []; }, TypeError);
  assert.throws(() => { text.length = 0; }, TypeError);
  assert.throws(() => text.encodeUtf8(), error => {
    assert.ok(error instanceof PythonUnicodeEncodeError);
    assert.equal(error.object, text);
    const context = new Error("synthetic context");
    error.cause = context;
    assert.equal(error.cause, context);
    assert.deepEqual(error.object.codePoints, [65, 0xd800, 0xdc00]);
    return true;
  });
  const scalar = PythonText.fromCodePoints([65]);
  const bytes = scalar.encodeUtf8();
  bytes[0] = 66;
  assert.equal(scalar.encodeUtf8().toString('hex'), '41');
});

test('PythonText rejects malformed runtime inputs and implicit conversion', () => {
  for (const value of [null, undefined, 'a', new Uint32Array([65]), {}, 65]) {
    assert.throws(() => PythonText.fromCodePoints(value), TypeError);
  }
  for (const value of [NaN, Infinity, -1, 0x110000, 1.5]) {
    assert.throws(() => PythonText.fromCodePoints([value]), RangeError);
  }
  for (const value of ['65', null, undefined, 65n]) {
    assert.throws(() => PythonText.fromCodePoints([value]), TypeError);
  }
  assert.throws(() => PythonText.fromCodePoints(new Array(1)), TypeError);
  for (const value of [null, undefined, 65, new String('a')]) {
    assert.throws(() => PythonText.fromJavaScript(value), TypeError);
  }
  const text = PythonText.fromCodePoints([65]);
  for (const value of [null, {}, 'a', Object.create(PythonText.prototype)]) {
    assert.throws(() => text.equals(value), TypeError);
    assert.throws(() => text.compare(value), TypeError);
    assert.throws(() => text.concat(value), TypeError);
  }
  assert.throws(() => String(text), TypeError);
  assert.throws(() => `${text}`, TypeError);
  assert.throws(() => Number(text), TypeError);
  assert.throws(() => text.toString(), TypeError);
  assert.throws(() => JSON.stringify(text), TypeError);
});

test('PythonText UTF8 boundary bytes and long concatenation avoid argument-stack limits', () => {
  const boundary = PythonText.fromCodePoints([0x7f, 0x80, 0x7ff, 0x800, 0xffff, 0x10000, 0x10ffff]);
  assert.equal(boundary.encodeUtf8().toString('hex'), '7fc280dfbfe0a080efbfbff0908080f48fbfbf');
  const long = PythonText.fromCodePoints(Array(200000).fill(0x10000));
  const joined = long.concat(PythonText.fromCodePoints([65]));
  assert.equal(joined.length, 200001);
  assert.equal(joined.compare(long), 1);
  const bytes = joined.encodeUtf8();
  assert.equal(bytes.length, 800001);
  for (let index = 0; index < 800000; index += 4) {
    assert.equal(bytes.readUInt32BE(index), 0xf0908080);
  }
  assert.equal(bytes[800000], 65);
  assert.equal(joined.equals(PythonText.fromCodePoints([...Array(200000).fill(0x10000), 65])), true);
});
