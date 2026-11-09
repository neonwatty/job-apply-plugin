import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { endianness } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const reference = fileURLToPath(new URL('../tools/contracts/python-json-bytes/reference.py', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cp = text => Array.from(text, character => character.codePointAt(0));
const quoted = points => [...cp('{"x":"'), ...points, ...cp('"}')];
const success = [
  ['empty', '', 'utf-8', []], ['ascii', '7b2278223a317d', 'utf-8', cp('{"x":1}')],
  ['one-ascii', '41', 'utf-8', [65]], ['one-zero', '00', 'utf-8', [0]],
  ['two-ascii', '4142', 'utf-8', [65, 66]], ['two-be', '0041', 'utf-16-be', [65]],
  ['two-le', '4100', 'utf-16-le', [65]], ['two-zero', '0000', 'utf-16-be', [0]],
  ['three-be-looking', '000041', 'utf-8', [0, 0, 65]], ['three-le-looking', '410000', 'utf-8', [65, 0, 0]],
  ['four-be16', '00410042', 'utf-16-be', [65, 66]], ['four-le16', '41004200', 'utf-16-le', [65, 66]],
  ['four-be32', '00000041', 'utf-32-be', [65]], ['four-le32', '41000000', 'utf-32-le', [65]],
  ['four-zero', '00000000', 'utf-32-be', [0]],
  ['utf8-bom-only', 'efbbbf', 'utf-8-sig', []], ['utf16-le-bom-only', 'fffe', 'utf-16', []],
  ['utf16-be-bom-only', 'feff', 'utf-16', []], ['utf32-le-bom-only', 'fffe0000', 'utf-32', []],
  ['utf32-be-bom-only', '0000feff', 'utf-32', []],
  ['utf8-bom-json', 'efbbbf7b7d', 'utf-8-sig', cp('{}')],
  ['utf16-le-bom-json', 'fffe7b007d00', 'utf-16', cp('{}')],
  ['utf16-be-bom-json', 'feff007b007d', 'utf-16', cp('{}')],
  ['utf32-le-bom-json', 'fffe00007b0000007d000000', 'utf-32', cp('{}')],
  ['utf32-be-bom-json', '0000feff0000007b0000007d', 'utf-32', cp('{}')],
  ['utf8-scalar-boundaries', '7fc280dfbfe0a080efbfbff0908080f48fbfbf', 'utf-8', [0x7f, 0x80, 0x7ff, 0x800, 0xffff, 0x10000, 0x10ffff]],
  ['utf16-le-max-scalar', 'fffeffdbffdf', 'utf-16', [0x10ffff]],
  ['utf16-be-max-scalar', 'feffdbffdfff', 'utf-16', [0x10ffff]],
  ['utf32-le-max-scalar', 'fffe0000ffff1000', 'utf-32', [0x10ffff]],
  ['utf32-be-max-scalar', '0000feff0010ffff', 'utf-32', [0x10ffff]],
  ['utf8-scalar', 'f0908080', 'utf-8', [0x10000]],
  ['utf8-raw-pair', 'eda080edb080', 'utf-8', [0xd800, 0xdc00]],
  ['utf8-high', 'eda080', 'utf-8', [0xd800]], ['utf8-low', 'edb080', 'utf-8', [0xdc00]],
  ['json-scalar', '7b2278223a22f0908080227d', 'utf-8', quoted([0x10000])],
  ['json-raw-pair', '7b2278223a22eda080edb080227d', 'utf-8', quoted([0xd800, 0xdc00])],
  ['json-escaped-pair', '7b2278223a225c75643830305c7564633030227d', 'utf-8', quoted(cp('\\ud800\\udc00'))],
  ['json-raw-high-escaped-low', '7b2278223a22eda0805c7564633030227d', 'utf-8', quoted([0xd800, ...cp('\\udc00')])],
  ['json-escaped-high-raw-low', '7b2278223a225c7564383030edb080227d', 'utf-8', quoted([...cp('\\ud800'), 0xdc00])],
  ['json-pair-scalar-keys', '7b22eda080edb080223a312c22f0908080223a327d', 'utf-8',
    [...cp('{"'), 0xd800, 0xdc00, ...cp('":1,"'), 0x10000, ...cp('":2}')]],
  ['utf16-le-pair', 'fffe00d800dc', 'utf-16', [0x10000]],
  ['utf16-be-pair', 'feffd800dc00', 'utf-16', [0x10000]],
  ['utf16-le-high', 'fffe00d8', 'utf-16', [0xd800]], ['utf16-be-low', 'feffdc00', 'utf-16', [0xdc00]],
  ['utf16-le-high-ascii', 'fffe00d84100', 'utf-16', [0xd800, 65]],
  ['utf16-be-two-highs', 'feffd800d801', 'utf-16', [0xd800, 0xd801]],
  ['utf32-le-pair', 'fffe000000d8000000dc0000', 'utf-32', [0xd800, 0xdc00]],
  ['utf32-be-pair', '0000feff0000d8000000dc00', 'utf-32', [0xd800, 0xdc00]],
  ['utf32-le-scalar', 'fffe000000000100', 'utf-32', [0x10000]],
  ['utf32-be-scalar', '0000feff00010000', 'utf-32', [0x10000]],
  ['utf32-le-high', 'fffe000000d80000', 'utf-32', [0xd800]],
  ['utf32-be-low', '0000feff0000dc00', 'utf-32', [0xdc00]],
  ['utf8-interior-bom', '41efbbbf', 'utf-8', [65, 0xfeff]],
  ['utf16-interior-bom', 'fffe4100fffe', 'utf-16', [65, 0xfeff]],
  ['utf32-interior-bom', '0000feff000000410000feff', 'utf-32', [65, 0xfeff]],
];
const failures = [
  ['partial-utf8-bom', 'efbb', 'utf-8', 'utf-8', 0, 2, 'unexpected end of data'],
  ['single-ff', 'ff', 'utf-8', 'utf-8', 0, 1, 'invalid start byte'],
  ['single-fe', 'fe', 'utf-8', 'utf-8', 0, 1, 'invalid start byte'],
  ['utf8-continuation', '80', 'utf-8', 'utf-8', 0, 1, 'invalid start byte'],
  ['utf8-overlong-two', 'c0af', 'utf-8', 'utf-8', 0, 1, 'invalid start byte'],
  ['utf8-overlong-three', 'e08080', 'utf-8', 'utf-8', 0, 1, 'invalid continuation byte'],
  ['utf8-overlong-four', 'f0808080', 'utf-8', 'utf-8', 0, 1, 'invalid continuation byte'],
  ['utf8-truncated', 'e282', 'utf-8', 'utf-8', 0, 2, 'unexpected end of data'],
  ['utf8-truncated-surrogate', 'eda0', 'utf-8', 'utf-8', 0, 1, 'invalid continuation byte'],
  ['utf8-bad-continuation', 'e228a1', 'utf-8', 'utf-8', 0, 1, 'invalid continuation byte'],
  ['utf8-above-max', 'f4908080', 'utf-8', 'utf-8', 0, 1, 'invalid continuation byte'],
  ['utf8-scalar-then-bad', 'f0908080ff', 'utf-8', 'utf-8', 4, 5, 'invalid start byte'],
  ['utf8-bom-then-bad', 'efbbbfff', 'utf-8-sig', 'utf-8', 0, 1, 'invalid start byte', 'ff'],
  ['utf8-surrogate-then-bad', 'eda080ff', 'utf-8', 'utf-8', 3, 4, 'invalid start byte'],
  ['utf16-le-odd', 'fffe41', 'utf-16', 'utf-16-le', 2, 3, 'truncated data'],
  ['utf16-be-odd', 'feff00', 'utf-16', 'utf-16-be', 2, 3, 'truncated data'],
  ['utf16-le-high-odd', 'fffe00d841', 'utf-16', 'utf-16-le', 4, 5, 'truncated data'],
  ['utf16-be-high-odd', 'feffd80000', 'utf-16', 'utf-16-be', 4, 5, 'truncated data'],
  ['utf16-le-inferred-odd', '4100420043', 'utf-16-le', 'utf-16-le', 4, 5, 'truncated data'],
  ['utf16-be-inferred-odd', '0041004200', 'utf-16-be', 'utf-16-be', 4, 5, 'truncated data'],
  ['utf32-le-truncated', 'fffe0000410000', 'utf-32', 'utf-32-le', 4, 7, 'truncated data'],
  ['utf32-be-truncated', '0000feff000041', 'utf-32', 'utf-32-be', 4, 7, 'truncated data'],
  ['utf32-le-above-max', 'fffe000000001100', 'utf-32', 'utf-32-le', 4, 8, 'code point not in range(0x110000)'],
  ['utf32-be-above-max', '0000feff00110000', 'utf-32', 'utf-32-be', 4, 8, 'code point not in range(0x110000)'],
  ['utf32-le-inferred-above-max', '4100000000001100', 'utf-32-le', 'utf-32-le', 4, 8, 'code point not in range(0x110000)'],
  ['utf32-be-inferred-above-max', '0000004100110000', 'utf-32-be', 'utf-32-be', 4, 8, 'code point not in range(0x110000)'],
  ['utf32-le-scalar-then-truncated', 'fffe00000000010041', 'utf-32', 'utf-32-le', 8, 9, 'truncated data'],
];
const expected = [
  ...success.map(([id, inputHex, detectedEncoding, codepoints]) => ({ id, inputHex, detectedEncoding,
    outcome: { kind: 'text', codepoints, length: codepoints.length } })),
  ...failures.map(([id, inputHex, detectedEncoding, encoding, start, end, reason, objectHex = inputHex]) => {
    const location = end - start === 1
      ? `byte 0x${objectHex.slice(start * 2, start * 2 + 2)} in position ${start}`
      : `bytes in position ${start}-${end - 1}`;
    return { id, inputHex, detectedEncoding, outcome: { kind: 'error', name: 'UnicodeDecodeError',
      encoding, objectHex, start, end, reason, message: `'${encoding}' codec can't decode ${location}: ${reason}` } };
  }),
].sort((a, b) => a.id.localeCompare(b.id));
const moduleNames = ['json', 'codecs', 'encodings', 'encodings.utf_8', 'encodings.utf_8_sig',
  'encodings.utf_16', 'encodings.utf_16_le', 'encodings.utf_16_be',
  'encodings.utf_32', 'encodings.utf_32_le', 'encodings.utf_32_be'];
const probe = `import importlib,json,pathlib,sys
names=${JSON.stringify(moduleNames)}
print(json.dumps({'executable':str(pathlib.Path(sys.executable).resolve()),
 'modules':{name:str(pathlib.Path(importlib.import_module(name).__file__).resolve()) for name in names},
 'nativeOrigin':importlib.import_module('_codecs').__spec__.origin}))`;
function run(executable, args, input = '') {
  return spawnSync(executable, ['-I', '-B', ...args], { input, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
}
function verify(executable, t) {
  const result = run(executable, [reference]);
  if (result.error?.code === 'ENOENT' && executable !== 'python3') {
    t.skip('Required interpreter alias unavailable; this profile remains unobserved'); return;
  }
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  const receipt = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(receipt).sort(), ['cases', 'nativeCodecs', 'profile', 'schemaVersion', 'scope', 'stdlib']);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.scope, 'detect-encoding-and-surrogatepass-decode-only');
  assert.deepEqual(Object.keys(receipt.profile).sort(), ['byteOrder', 'executablePath', 'executableSha256', 'implementation', 'platform', 'python']);
  assert.equal(receipt.profile.implementation, 'CPython');
  assert.equal(receipt.profile.platform, process.platform);
  assert.equal(receipt.profile.byteOrder, endianness() === 'LE' ? 'little' : 'big');
  assert.match(receipt.profile.python, /^3\.(12|13|14)\.\d+$/);
  if (executable !== 'python3') assert.ok(receipt.profile.python.startsWith(executable.slice(6) + '.'));
  const provenance = run(executable, ['-c', probe]);
  assert.ifError(provenance.error); assert.equal(provenance.status, 0, provenance.stderr); assert.equal(provenance.stderr, '');
  const selected = JSON.parse(provenance.stdout);
  assert.equal(receipt.profile.executablePath, selected.executable);
  assert.equal(receipt.profile.executableSha256, hash(readFileSync(selected.executable)));
  assert.deepEqual(Object.keys(receipt.stdlib).sort(), [...moduleNames].sort());
  for (const name of moduleNames) {
    assert.deepEqual(receipt.stdlib[name], { path: selected.modules[name], sha256: hash(readFileSync(selected.modules[name])) });
  }
  assert.deepEqual(receipt.nativeCodecs, { origin: selected.nativeOrigin,
    sha256: selected.nativeOrigin === 'built-in' ? null : hash(readFileSync(selected.nativeOrigin)) });
  assert.equal(expected.length, 82); assert.equal(new Set(expected.map(row => row.id)).size, 82);
  assert.deepEqual([...receipt.cases].sort((a, b) => a.id.localeCompare(b.id)), expected);
  t.diagnostic(`${receipt.profile.python}: 82 fixed byte inputs; default python3 may repeat an explicit profile`);
}

// Literal top-level test names are stable binding targets for later migration receipts.
test('S02.R byte decoding reference: default CPython', t => verify('python3', t));
test('S02.R byte decoding reference: CPython 3.12', t => verify('python3.12', t));
test('S02.R byte decoding reference: CPython 3.13', t => verify('python3.13', t));
test('S02.R byte decoding reference: CPython 3.14', t => verify('python3.14', t));
test('S02.R byte decoding reference rejects external input', () => {
  for (const [args, input] of [[[reference, '--external'], ''], [[reference], 'external']]) {
    const result = run('python3', args, input);
    assert.ifError(result.error); assert.equal(result.status, 2); assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'python_json_bytes_reference_input_rejected\n');
  }
});
