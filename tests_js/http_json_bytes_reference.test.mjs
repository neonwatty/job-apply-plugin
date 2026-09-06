import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { endianness } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const driver = fileURLToPath(new URL('../tools/contracts/http-json-bytes/reference.py', import.meta.url));
const paths = ['scripts/job_apply_workspace/http.py', 'scripts/job_apply_workspace/__init__.py',
  'scripts/job_apply_store/normalization.py', 'scripts/job_apply_store/domains/coordinator/persistence.py'];
const root = new URL('../', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
const cp = text => Array.from(text, character => character.codePointAt(0));
const string = points => ({ kind: 'string', codepoints: points });
const integer = value => ({ kind: 'int', decimal: String(value) });
const object = entries => ({ kind: 'object', entries: entries.map(([key, value]) => ({ key, value })) });
const valueObject = points => object([[[120], string(points)]]);
const fixtures = [];
const add = (id, body, value, options = {}) => fixtures.push({ id, body, value, ...options });
const hex = value => Buffer.from(value, 'hex');
const wrap = bytes => Buffer.concat([Buffer.from('{"x":"'), bytes, Buffer.from('"}')]);
for (const [id, bytes, points] of [
  ['raw-pair', hex('eda080edb080'), [0xd800, 0xdc00]],
  ['escaped-pair', Buffer.from('\\ud800\\udc00'), [0x10000]],
  ['scalar', hex('f0908080'), [0x10000]],
  ['raw-high', hex('eda080'), [0xd800]], ['raw-low', hex('edb080'), [0xdc00]],
  ['escaped-high', Buffer.from('\\ud800'), [0xd800]], ['escaped-low', Buffer.from('\\udc00'), [0xdc00]],
  ['raw-high-escaped-low', Buffer.concat([hex('eda080'), Buffer.from('\\udc00')]), [0xd800, 0xdc00]],
  ['escaped-high-raw-low', Buffer.concat([Buffer.from('\\ud800'), hex('edb080')]), [0xd800, 0xdc00]],
]) add(id, wrap(bytes), valueObject(points));
const twoKeys = (left, right) => Buffer.concat([Buffer.from('{"'), left, Buffer.from('":1,"'), right, Buffer.from('":2}')]);
const separateKeys = object([[[0xd800, 0xdc00], integer(1)], [[0x10000], integer(2)]]);
add('pair-scalar-keys', twoKeys(hex('eda080edb080'), hex('f0908080')), separateKeys);
add('escaped-scalar-keys', twoKeys(Buffer.from('\\ud800\\udc00'), hex('f0908080')), object([[[0x10000], integer(2)]]));
add('raw-escaped-pair-keys', twoKeys(hex('eda080edb080'), Buffer.from('\\ud800\\udc00')), separateKeys);
const text = '{"x":"\u{10000}"}';
const le16 = Buffer.from(text, 'utf16le');
const be16 = Buffer.from(le16).swap16();
const le32 = Buffer.alloc(cp(text).length * 4);
cp(text).forEach((point, index) => le32.writeUInt32LE(point, index * 4));
for (const [id, bytes] of [
  ['utf-8-sig', Buffer.concat([hex('efbbbf'), Buffer.from(text)])],
  ['utf-16', endianness() === 'LE' ? Buffer.concat([hex('fffe'), le16]) : Buffer.concat([hex('feff'), be16])], ['utf-16-le', le16], ['utf-16-be', be16],
  ['utf-32', endianness() === 'LE' ? Buffer.concat([hex('fffe0000'), le32]) : Buffer.concat([hex('0000feff'), Buffer.from(le32).swap32()])], ['utf-32-le', le32], ['utf-32-be', Buffer.from(le32).swap32()],
]) add(id, bytes, valueObject([0x10000]));
add('utf16-lone-high', hex('fffe7b002200780022003a00220000d822007d00'), valueObject([0xd800]));
add('utf32-lone-high', hex('fffe00007b0000002200000078000000220000003a0000002200000000d80000220000007d000000'), valueObject([0xd800]));
const invalid = 'request body must be valid JSON';
for (const [id, bytes, message] of [
  ['invalid-ff', wrap(hex('ff')), invalid], ['overlong', wrap(hex('c080')), invalid],
  ['truncated-utf8', wrap(hex('e282')), invalid], ['invalid-utf32', hex('fffe000000001100'), invalid],
  ['odd-utf16', hex('fffe7b'), invalid], ['invalid-json', Buffer.from('{"x":}'), invalid],
  ['array', Buffer.from('[]'), 'request body must be a JSON object'], ['empty', Buffer.alloc(0), invalid],
]) add(id, bytes, null, { status: 400, message });
const empty = Buffer.from('{}');
add('wrong-content-type', empty, null, { contentType: 'application/json; charset=utf-8', status: 415, message: 'Content-Type must be application/json', noRead: true });
for (const [id, length] of [['missing-length', null], ['malformed-length', 'bad'], ['negative-length', '-1']]) {
  add(id, empty, null, { length, status: 411, message: 'a valid Content-Length is required', noRead: true });
}
add('oversize', empty, null, { length: '65537', status: 413, message: 'request body is too large', noRead: true });
add('length-whitespace-plus', empty, object([]), { length: ' +2 ' });
add('length-short', Buffer.from('{}tail'), object([]), { length: '2' });
add('length-long', empty, object([]), { length: '99' });
add('short-read', Buffer.from('{"x":1}'), null, { readLimit: 2, status: 400, message: invalid });
add('read-error', empty, null, { readError: true });

function comparePoints(left, right) {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}
function spelling(value, spaces) {
  if (value.kind === 'string') return [34, ...value.codepoints, 34];
  if (value.kind === 'int') return cp(value.decimal);
  const result = [123];
  const entries = [...value.entries].sort((a, b) => comparePoints(a.key, b.key));
  entries.forEach((entry, index) => {
    if (index) result.push(...cp(spaces ? ', ' : ','));
    result.push(34, ...entry.key, 34, ...cp(spaces ? ': ' : ':'), ...spelling(entry.value, spaces));
  });
  result.push(125);
  return result;
}
function checkRow(row, fixture) {
  keys(row, ['id', 'inputHex', 'headers', 'readLimit', 'readError', 'reads', 'remainingHex', 'httpErrors', 'outcome', 'downstream']);
  assert.equal(row.id, fixture.id);
  assert.equal(row.inputHex, fixture.body.toString('hex'));
  const headers = { 'Content-Type': fixture.contentType ?? 'application/json' };
  const length = fixture.length === undefined ? String(fixture.body.length) : fixture.length;
  if (length !== null) headers['Content-Length'] = length;
  assert.deepEqual(row.headers, headers);
  assert.equal(row.readLimit, fixture.readLimit ?? null);
  assert.equal(row.readError, fixture.readError ?? false);
  assert.deepEqual(row.reads, fixture.noRead ? [] : [Number(length)]);
  const consumed = fixture.noRead || fixture.readError ? 0 : Math.min(fixture.body.length, Number(length), fixture.readLimit ?? Infinity);
  assert.equal(row.remainingHex, fixture.body.subarray(consumed).toString('hex'));
  assert.deepEqual(row.httpErrors, fixture.status ? [{ status: fixture.status, message: fixture.message }] : []);
  assert.deepEqual(row.outcome, fixture.readError ? { kind: 'error', error: { name: 'OSError', errno: 5 } }
    : { kind: 'value', value: fixture.value ?? { kind: 'null' } });
  if (!fixture.value) return assert.equal(row.downstream, null);
  keys(row.downstream, ['canonicalCodepoints', 'persisted']);
  assert.deepEqual(row.downstream.canonicalCodepoints, spelling(fixture.value, false));
  const encodedPoints = [...spelling(fixture.value, true), 10];
  const start = encodedPoints.findIndex(point => point >= 0xd800 && point <= 0xdfff);
  if (start < 0) {
    assert.deepEqual(row.downstream.persisted, { kind: 'bytes', hex: Buffer.from(String.fromCodePoint(...encodedPoints)).toString('hex') });
  } else {
    let end = start + 1;
    while (end < encodedPoints.length && encodedPoints[end] >= 0xd800 && encodedPoints[end] <= 0xdfff) end++;
    assert.deepEqual(row.downstream.persisted, { kind: 'error', error: { name: 'UnicodeEncodeError',
      encoding: 'utf-8', start, end, reason: 'surrogates not allowed', objectCodepoints: encodedPoints } });
  }
}

for (const executable of ['python3', 'python3.12', 'python3.13', 'python3.14']) {
  test(`HTTP raw JSON byte reference: ${executable}`, t => {
    const run = spawnSync(executable, ['-I', driver], { encoding: 'utf8', input: '', timeout: 10000, maxBuffer: 2 ** 20 });
    if (run.error?.code === 'ENOENT' && executable !== 'python3') return t.skip('Interpreter executable alias unavailable');
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    const receipt = JSON.parse(run.stdout);
    keys(receipt, ['schemaVersion', 'scope', 'profile', 'sourceHashes', 'stdlibHashes', 'maxBodyBytes', 'cases']);
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.scope, 'extracted-production-methods-no-route-integration');
    assert.equal(receipt.maxBodyBytes, 65536);
    keys(receipt.profile, ['implementation', 'python', 'platform', 'byteorder', 'executable', 'executableSha256', 'nativeJson']);
    assert.equal(receipt.profile.byteorder, endianness() === 'LE' ? 'little' : 'big');
    assert.equal(receipt.profile.executableSha256, hash(readFileSync(receipt.profile.executable)));
    keys(receipt.profile.nativeJson, ['origin', 'sha256']);
    assert.equal(receipt.profile.nativeJson.sha256, receipt.profile.nativeJson.origin === 'built-in'
      ? null : hash(readFileSync(receipt.profile.nativeJson.origin)));
    assert.equal(receipt.profile.implementation, 'CPython');
    assert.equal(receipt.profile.platform, process.platform);
    assert.match(receipt.profile.python, /^3\.(12|13|14)\.\d+$/);
    if (executable !== 'python3') assert.ok(receipt.profile.python.startsWith(`${executable.slice(6)}.`));
    keys(receipt.sourceHashes, paths);
    for (const path of paths) assert.equal(receipt.sourceHashes[path], hash(readFileSync(new URL(path, root))));
    const libraries = spawnSync(executable, ['-I', '-c',
      `import json
import json.decoder
import json.encoder
import json.scanner
import _json
import sys
import hashlib
import pathlib
modules = [("json", json), ("json.decoder", json.decoder), ("json.encoder", json.encoder), ("json.scanner", json.scanner)]
hashes = {name: hashlib.sha256(pathlib.Path(module.__file__).read_bytes()).hexdigest()
          for name, module in modules}
print(json.dumps({"hashes": hashes, "executable": str(pathlib.Path(sys.executable).resolve()),
                  "origin": _json.__spec__.origin}))`],
    { encoding: 'utf8', timeout: 3000, maxBuffer: 4096 });
    assert.ifError(libraries.error);
    assert.equal(libraries.status, 0, libraries.stderr);
    const provenance = JSON.parse(libraries.stdout);
    assert.deepEqual(receipt.stdlibHashes, provenance.hashes);
    assert.equal(receipt.profile.executable, provenance.executable);
    assert.equal(receipt.profile.nativeJson.origin, provenance.origin);
    assert.deepEqual(receipt.cases.map(row => row.id), fixtures.map(row => row.id));
    receipt.cases.forEach((row, index) => checkRow(row, fixtures[index]));
    t.diagnostic(`${receipt.profile.python}: ${fixtures.length} cases; repeated default version adds no independent profile`);
  });
}

test('HTTP raw JSON reference rejects caller arguments and stdin', () => {
  for (const [args, input] of [[['--path', 'synthetic'], ''], [[], 'synthetic']]) {
    const run = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', driver, ...args], { encoding: 'utf8', input, timeout: 3000 });
    assert.ifError(run.error);
    assert.equal(run.status, 2);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, 'http_json_bytes_input_rejected\n');
  }
});
