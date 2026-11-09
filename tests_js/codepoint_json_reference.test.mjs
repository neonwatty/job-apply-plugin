import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { endianness } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const reference = fileURLToPath(new URL('../tools/contracts/codepoint-json/reference.py', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cp = text => Array.from(text, character => character.codePointAt(0));
const pair = [0xd800, 0xdc00], scalar = [0x10000];
const escaped = cp(String.raw`\ud800\udc00`);
const quoted = points => [34, ...points, 34];
const text = points => ({ kind: 'text', points });
const integer = decimal => ({ kind: 'integer', decimal: String(decimal) });
const float = hex => ({ kind: 'float', hex });
const array = items => ({ kind: 'array', items });
const object = entries => ({ kind: 'object', entries });
const oneFloat = float('0x1.0000000000000p+0');
const threeFloat = float('0x1.8000000000000p+1');
const pairAscii = String.raw`"\ud800\udc00"`;
// Inputs and expected typed outcomes are fixed here independently of the Python driver.
const successes = [
  ['raw-pair', quoted(pair), text(pair), pairAscii, text(scalar)],
  ['scalar', quoted(scalar), text(scalar), pairAscii],
  ['escaped-pair', quoted(escaped), text(scalar), pairAscii],
  ['raw-high-escaped-low', quoted([0xd800, ...cp(String.raw`\udc00`)]), text(pair), pairAscii, text(scalar)],
  ['escaped-high-raw-low', quoted([...cp(String.raw`\ud800`), 0xdc00]), text(pair), pairAscii, text(scalar)],
  ['separated-escapes', quoted(cp(String.raw`\ud800X\udc00`)), text([0xd800, 88, 0xdc00]), String.raw`"\ud800X\udc00"`],
  ['escaped-backslash', quoted(cp(String.raw`\\ud800\\udc00`)), text(escaped), String.raw`"\\ud800\\udc00"`],
  ['lone-high', quoted([0xd800]), text([0xd800]), String.raw`"\ud800"`],
  ['lone-low', quoted([0xdc00]), text([0xdc00]), String.raw`"\udc00"`],
  ['reverse-pair', quoted([0xdc00, 0xd800]), text([0xdc00, 0xd800]), String.raw`"\udc00\ud800"`],
  ['maximum-escaped', quoted(cp(String.raw`\uDBFF\uDFFF`)), text([0x10ffff]), String.raw`"\udbff\udfff"`],
  ['key-pair-scalar-overwrite', [...cp('{"'), ...pair, ...cp('":1,"'), ...scalar,
    ...cp('":2,"'), ...escaped, ...cp('":3.0}')],
    object([[pair, integer(1)], [scalar, threeFloat]]), String.raw`{"\ud800\udc00":1,"\ud800\udc00":3.0}`,
    object([[scalar, threeFloat]])],
  ['mixed-key-overwrite', [...cp('{"'), ...pair, ...cp('":1,"'), 0xd800,
    ...cp(String.raw`\udc00`), ...cp('":2,"x":true}')],
    object([[pair, integer(2)], [cp('x'), { kind: 'boolean', value: true }]]),
    String.raw`{"x":true,"\ud800\udc00":2}`,
    object([[cp('x'), { kind: 'boolean', value: true }], [scalar, integer(2)]])],
  ['key-sort-boundaries', [...cp('{"'), 0x10ffff, ...cp('":6,"'), 0x10000,
    ...cp('":5,"'), 0xe000, ...cp('":4,"'), 0xdc00, ...cp('":3,"'),
    0xd800, ...cp('":2,"'), 0xd7ff, ...cp('":1}')],
    object([[0x10ffff, 6], [0x10000, 5], [0xe000, 4], [0xdc00, 3], [0xd800, 2], [0xd7ff, 1]]
      .map(([key, value]) => [[key], integer(value)])),
    String.raw`{"\ud7ff":1,"\ud800":2,"\udc00":3,"\ue000":4,"\ud800\udc00":5,"\udbff\udfff":6}`,
    object([[0xd7ff, 1], [0xd800, 2], [0xdc00, 3], [0xe000, 4], [0x10000, 5], [0x10ffff, 6]]
      .map(([key, value]) => [[key], integer(value)]))],
  ['numeric-composition', [...cp('["'), ...pair,
    ...cp('",9007199254740993,1.0,-0.0,1e999,-1e999,NaN,true,false,null]')],
    array([text(pair), integer('9007199254740993'), oneFloat, float('-0x0.0p+0'), float('inf'),
      float('-inf'), float('nan'), { kind: 'boolean', value: true }, { kind: 'boolean', value: false }, { kind: 'null' }]),
    String.raw`["\ud800\udc00",9007199254740993,1.0,-0.0,Infinity,-Infinity,NaN,true,false,null]`,
    array([text(scalar), integer('9007199254740993'), oneFloat, float('-0x0.0p+0'), float('inf'),
      float('-inf'), float('nan'), { kind: 'boolean', value: true }, { kind: 'boolean', value: false }, { kind: 'null' }])],
  ['shared-text-values', [...cp('["'), ...pair, ...cp('",{"x":"'), ...scalar, ...cp('"}]')],
    array([text(pair), object([[cp('x'), text(scalar)]])]), String.raw`["\ud800\udc00",{"x":"\ud800\udc00"}]`,
    array([text(scalar), object([[cp('x'), text(scalar)]])])],
  ['integer-limit-accepted', cp('9'.repeat(640)), integer('9'.repeat(640)), '9'.repeat(640)],
];
const failures = [
  ['bad-after-pair', [...cp('["'), ...pair, ...cp('",?]')], 'Expecting value', 6, 1, 7],
  ['bad-after-scalar', [...cp('["'), ...scalar, ...cp('",?]')], 'Expecting value', 5, 1, 6],
  ['bad-after-escaped-pair', cp(String.raw`["\ud800\udc00",?]`), 'Expecting value', 16, 1, 17],
  ['bad-multiline', [...cp('[\n"'), ...pair, ...cp('",\n?]')], 'Expecting value', 8, 3, 1],
  ['bad-key-colon', [...cp('{"'), ...pair, ...cp('" 1}')], "Expecting ':' delimiter", 6, 1, 7],
  ['bad-escape', [34, ...pair, ...cp(String.raw`\q`), 34], String.raw`Invalid \escape`, 3, 1, 4],
  ['bad-unicode-escape', [34, ...pair, ...cp(String.raw`\u12x4`), 34], String.raw`Invalid \uXXXX escape`, 4, 1, 5],
  ['bad-control', [34, ...pair, 1, 34], 'Invalid control character at', 3, 1, 4],
  ['unterminated', [34, ...pair], 'Unterminated string starting at', 0, 1, 1],
  ['extra-data', [34, ...pair, 34, 32, 48], 'Extra data', 5, 1, 6],
  ['text-bom', [0xfeff, ...cp('{}')], 'Unexpected UTF-8 BOM (decode using utf-8-sig)', 0, 1, 1],
  ['missing-value', cp('{"x":}'), 'Expecting value', 5, 1, 6],
  ['empty', [], 'Expecting value', 0, 1, 1],
];
const byteCases = [
  ['bytes-raw-pair', '22eda080edb08022', 'utf-8', pair],
  ['bytes-scalar', '22f090808022', 'utf-8', scalar],
  ['bytes-escaped-pair', '225c75643830305c756463303022', 'utf-8', escaped, scalar],
  ['bytes-utf8-bom', 'efbbbf22eda080edb08022', 'utf-8-sig', pair],
  ['bytes-utf16-pair', 'fffe220000d800dc2200', 'utf-16', scalar],
  ['bytes-utf32-pair', 'fffe00002200000000d8000000dc000022000000', 'utf-32', pair],
];
function syntaxRow([id, documentPoints, reason, position, line, column]) {
  return { id, documentPoints, inputHex: null, detectedEncoding: null,
    outcome: { kind: 'error', name: 'JSONDecodeError', reason, position, line, column, documentPoints,
      message: `${reason}: line ${line} column ${column} (char ${position})` } };
}
function expectedCases(version) {
  const trailing = !version.startsWith('3.12.')
    ? ['trailing-comma', cp('[1,]'), 'Illegal trailing comma before end of array', 2, 1, 3]
    : ['trailing-comma', cp('[1,]'), 'Expecting value', 3, 1, 4];
  return [
    ...successes.map(([id, documentPoints, value, ascii, asciiReload = value]) => ({ id,
      documentPoints, inputHex: null, detectedEncoding: null, outcome: { kind: 'value', value, ascii, asciiReload } })),
    ...[...failures, trailing].map(syntaxRow),
    { id: 'integer-limit-rejected', documentPoints: cp('9'.repeat(641)), inputHex: null, detectedEncoding: null,
      outcome: { kind: 'error', name: 'ValueError', message: 'Exceeds the limit (640 digits) for integer string conversion: value has 641 digits; use sys.set_int_max_str_digits() to increase the limit' } },
    ...byteCases.map(([id, inputHex, detectedEncoding, source, valuePoints = source]) => ({ id,
      inputHex, detectedEncoding, documentPoints: quoted(source), outcome: { kind: 'value',
        value: text(valuePoints), ascii: pairAscii, asciiReload: text(scalar) } })),
  ].sort((a, b) => a.id.localeCompare(b.id));
}
const serializerExpected = [
  { id: 'shared-array', outcome: { kind: 'value', ascii: String.raw`[["\ud800\udc00"],["\ud800\udc00"]]`,
    value: array([array([text(pair)]), array([text(pair)])]), sameChildIdentity: true } },
  ...['cycle-array', 'cycle-object'].map(id => ({ id,
    outcome: { kind: 'error', name: 'ValueError', message: 'Circular reference detected' } })),
];
const moduleNames = ['json', 'json.decoder', 'json.encoder', 'json.scanner', 'codecs',
  'encodings', 'encodings.utf_8', 'encodings.utf_8_sig', 'encodings.utf_16', 'encodings.utf_32'];
const probe = `import importlib,json,pathlib,platform,sys
names=${JSON.stringify(moduleNames)}
print(json.dumps({'executable':str(pathlib.Path(sys.executable).resolve()),'python':platform.python_version(),
 'modules':{n:str(pathlib.Path(importlib.import_module(n).__file__).resolve()) for n in names},
 'native':{n:importlib.import_module(n).__spec__.origin for n in ['_json','_codecs']}}))`;
function run(executable, args, input = '') {
  return spawnSync(executable, ['-I', '-B', ...args], { input, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
}
function verify(executable, t) {
  const result = run(executable, [reference]);
  if (result.error?.code === 'ENOENT' && executable !== 'python3') {
    t.skip('Required interpreter alias unavailable; profile unobserved'); return;
  }
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  const receipt = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(receipt).sort(), ['cases', 'native', 'profile', 'schemaVersion', 'scope', 'serializers', 'stdlib']);
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.scope, 'fixed-composed-codepoint-json');
  const observed = run(executable, ['-c', probe]);
  assert.ifError(observed.error); assert.equal(observed.status, 0, observed.stderr); assert.equal(observed.stderr, '');
  const selected = JSON.parse(observed.stdout);
  assert.match(selected.python, /^3\.(12|13|14)\.\d+$/);
  if (executable !== 'python3') assert.ok(selected.python.startsWith(executable.slice(6) + '.'));
  assert.deepEqual(receipt.profile, { python: selected.python, implementation: 'CPython', platform: process.platform,
    byteOrder: endianness() === 'LE' ? 'little' : 'big', intMaxStrDigits: 640,
    executablePath: selected.executable, executableSha256: hash(readFileSync(selected.executable)) });
  assert.deepEqual(Object.keys(receipt.stdlib).sort(), [...moduleNames].sort());
  for (const name of moduleNames) assert.deepEqual(receipt.stdlib[name], {
    path: selected.modules[name], sha256: hash(readFileSync(selected.modules[name])) });
  assert.deepEqual(Object.keys(receipt.native).sort(), ['_codecs', '_json']);
  for (const [name, origin] of Object.entries(selected.native)) assert.deepEqual(receipt.native[name], {
    origin, sha256: origin === 'built-in' ? null : hash(readFileSync(origin)) });
  const expected = expectedCases(selected.python);
  assert.equal(expected.length, 38); assert.equal(new Set(expected.map(row => row.id)).size, 38);
  assert.deepEqual(receipt.cases.map(row => row.id).sort(), expected.map(row => row.id).sort());
  for (const row of expected) assert.deepEqual(receipt.cases.find(item => item.id === row.id), row, row.id);
  assert.deepEqual(receipt.serializers, serializerExpected);
  t.diagnostic(`${selected.python}: 38 fixed documents and 3 serializer graphs; default may duplicate a profile`);
}

test('S03.R composed codepoint JSON reference: default CPython', t => verify('python3', t));
test('S03.R composed codepoint JSON reference: CPython 3.12', t => verify('python3.12', t));
test('S03.R composed codepoint JSON reference: CPython 3.13', t => verify('python3.13', t));
test('S03.R composed codepoint JSON reference: CPython 3.14', t => verify('python3.14', t));
test('S03.R composed codepoint JSON reference rejects caller input', () => {
  for (const [args, input] of [[[reference, '--external'], ''], [[reference], 'external']]) {
    const result = run('python3', args, input);
    assert.ifError(result.error); assert.equal(result.status, 2); assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'codepoint_json_reference_input_rejected\n');
  }
});
