import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const reference = fileURLToPath(new URL('../tools/contracts/json-ingress/reference.py', import.meta.url));
const primary = process.platform === 'win32' ? 'python' : 'python3';
const byteIds = [
  'utf8', 'utf8-bom', 'utf16le', 'utf16be', 'utf32le', 'utf32be',
  'utf16-bom', 'utf32-bom', 'surrogatepass', 'invalid-utf8',
  'newlines', 'raw-string-crlf', 'non-object',
];
const success = (serialized) => ({ ok: true, serialized });
const failure = (error, message) => message === undefined
  ? { ok: false, error } : { ok: false, error, message };

function expectedByte(id, ingress) {
  const bytes = ingress === 'bytes-decoder' || ingress === 'http-wrapper';
  let decoded;
  if (id === 'invalid-utf8' || (!bytes && ['surrogatepass', 'utf16-bom', 'utf32-bom'].includes(id))) {
    decoded = failure('UnicodeDecodeError');
  } else if (id === 'raw-string-crlf' || (!bytes && !['utf8', 'newlines', 'non-object'].includes(id))) {
    decoded = failure('JSONDecodeError');
  } else {
    decoded = success(id === 'non-object' ? '[]' : id === 'surrogatepass'
      ? '{"s":"\\ud800"}' : id === 'newlines' ? '{"s":"a"}' : '{}');
  }
  if (ingress === 'document-wrapper') {
    if (!decoded.ok) return failure('StoreError', 'cannot read valid fixture JSON at synthetic-document');
    if (id === 'non-object') return failure('StoreError', 'fixture must be a JSON object');
  }
  if (ingress === 'stdin-wrapper') {
    if (decoded.error === 'JSONDecodeError') return failure('StoreError', 'input is not a readable JSON object');
    if (id === 'non-object') return failure('StoreError', 'input must be a JSON object');
  }
  if (ingress === 'http-wrapper' && (!decoded.ok || id === 'non-object')) {
    return { ok: false, error: 'HTTP', status: 400, message: id === 'non-object'
      ? 'request body must be a JSON object' : 'request body must be valid JSON' };
  }
  return decoded;
}

function keys(value, expected) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}

for (const executable of [primary, 'python3.12', 'python3.13', 'python3.14']) {
  test(`fixed ingress behavior: ${executable}`, (t) => {
    const result = spawnSync(executable, ['-I', reference], {
      input: '', encoding: 'utf8', timeout: 10000, maxBuffer: 128 * 1024,
    });
    if (result.error?.code === 'ENOENT' && executable !== primary) {
      t.skip('Interpreter alias unavailable; profile remains unverified in this run');
      return;
    }
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const receipt = JSON.parse(result.stdout);
    keys(receipt, ['schemaVersion', 'provenance', 'coverage', 'cases']);
    assert.equal(receipt.schemaVersion, 1);
    keys(receipt.provenance, ['implementation', 'python', 'unicode', 'stdinEncoding', 'stdinErrors', 'recursionLimit']);
    assert.equal(receipt.provenance.implementation, 'CPython');
    assert.match(receipt.provenance.python, /^3\.\d+\.\d+$/);
    assert.match(receipt.provenance.unicode, /^\d+\.\d+\.\d+$/);
    assert.equal(receipt.provenance.stdinEncoding, 'utf-8');
    assert.equal(receipt.provenance.stdinErrors, 'strict');
    assert.ok(Number.isSafeInteger(receipt.provenance.recursionLimit));
    assert.deepEqual(receipt.coverage, {
      byteInputs: 13, scopeInputs: 6, jsonlInputs: 6,
      wrapperCases: 45, decoderCases: 26, branchCases: 6,
    });
    const expected = [];
    for (const id of byteIds) {
      for (const ingress of ['bytes-decoder', 'utf8-text-decoder', 'document-wrapper', 'stdin-wrapper', 'http-wrapper']) {
        expected.push({ id, ingress, outcome: expectedByte(id, ingress) });
      }
    }
    for (const id of ['object', 'text-bom', 'whitespace', 'nbsp-prefix', 'non-object', 'escaped-surrogate']) {
      expected.push({ id, ingress: 'scope-wrapper', outcome:
        ['text-bom', 'nbsp-prefix', 'non-object'].includes(id)
          ? failure('StoreError', 'scope must be a JSON object')
          : success(id === 'escaped-surrogate' ? '{"s":"\\ud800"}' : '{}') });
    }
    for (const id of ['empty', 'ascii', 'nbsp', 'em-space', 'bom', 'object']) {
      expected.push({ id, ingress: 'jsonl-branch', outcome: id === 'bom'
        ? failure('JSONDecodeError') : id === 'object' ? success('{}') : { ok: true, skipped: true } });
    }
    // Deep equality closes every case/outcome schema and excludes arbitrary paths,
    // exception strings or accidentally emitted application data.
    assert.deepEqual(receipt.cases, expected);
    t.diagnostic(`${receipt.provenance.python}/Unicode ${receipt.provenance.unicode}: 77 outcomes; 45 wrapper, 26 decoder, 6 branch`);
  });
}

test('ingress reference rejects arguments and stdin without emitting values', () => {
  for (const [args, input] of [[['--input', 'private-canary'], ''], [[], 'private-canary']]) {
    const result = spawnSync(primary, ['-I', reference, ...args], {
      input, encoding: 'utf8', timeout: 10000, maxBuffer: 128 * 1024,
    });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'reference_input_rejected\n');
  }
});
