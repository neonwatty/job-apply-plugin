import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const reference = fileURLToPath(new URL('../tools/contracts/json-ingress/stdin-reference.py', import.meta.url));
const primary = process.platform === 'win32' ? 'python' : 'python3';
const interpreters = [primary, 'python3.12', 'python3.13', 'python3.14'];
const profiles = new Set();
const expectedIds = ['object', 'bom', 'non-ascii', 'invalid-byte-string', 'invalid-byte-outside',
  'surrogate-utf8', 'escaped-surrogate', 'duplicate-key', 'newlines', 'raw-string-crlf',
  'non-object', 'utf16-bom', 'nested-64', 'nested-2000'];
const expectedHex = {
  object: '7b7d', bom: 'efbbbf7b7d', 'non-ascii': '7b2273223a22c3a9f09f9880227d',
  'invalid-byte-string': '7b2273223a22ff227d', 'invalid-byte-outside': 'ff7b7d',
  'surrogate-utf8': '7b2273223a22eda080227d', 'escaped-surrogate': '7b2273223a225c7564383030227d',
  'duplicate-key': '7b2261223a312c225c7530303631223a312e307d',
  newlines: '0d0a7b0d0a2273223a2261227d0d0a',
  'raw-string-crlf': '7b2273223a22610d0a62227d', 'non-object': '5b5d',
  'utf16-bom': 'fffe7b007d00',
  'nested-64': '7b2261223a' + '5b'.repeat(64) + '6e756c6c' + '5d'.repeat(64) + '7d',
  'nested-2000': '7b2261223a' + '5b'.repeat(2000) + '6e756c6c' + '5d'.repeat(2000) + '7d',
};

function expected(id, family) {
  if (['bom', 'invalid-byte-outside', 'raw-string-crlf', 'non-object', 'utf16-bom'].includes(id)) {
    return { ok: false, error: family === 'store' ? 'StoreError' : 'PolicyError',
      message: id === 'non-object' ? 'input must be a JSON object' : 'input is not a readable JSON object' };
  }
  const values = {
    object: '{}', 'non-ascii': '{"s":"\\u00e9\\ud83d\\ude00"}',
    'invalid-byte-string': '{"s":"\\udcff"}',
    'surrogate-utf8': '{"s":"\\udced\\udca0\\udc80"}',
    'escaped-surrogate': '{"s":"\\ud800"}', 'duplicate-key': '{"a":1.0}',
    newlines: '{"s":"a"}', 'nested-64': '{"a":' + '['.repeat(64) + 'null' + ']'.repeat(64) + '}',
    'nested-2000': '{"a":' + '['.repeat(2000) + 'null' + ']'.repeat(2000) + '}',
  };
  return { ok: true, serialized: values[id] };
}

for (const executable of interpreters) {
  test(`actual pipe stdin through production readers: ${executable}`, (t) => {
    const result = spawnSync(executable, ['-I', reference], {
      input: '', encoding: 'utf8', timeout: 15000, maxBuffer: 128 * 1024,
    });
    if (result.error?.code === 'ENOENT' && executable !== primary) {
      t.skip('Interpreter executable unavailable; no stdin profile acceptance');
      return;
    }
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const receipt = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(receipt).sort(), ['cases', 'inputModel', 'schemaVersion']);
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.inputModel, 'actual-pipe-stdin-isolated-python');
    assert.equal(receipt.cases.length, 28);
    assert.deepEqual(receipt.cases.map(({ family, id }) => `${family}:${id}`),
      ['store', 'policy'].flatMap(family => expectedIds.map(id => `${family}:${id}`)));
    for (const item of receipt.cases) {
      assert.deepEqual(Object.keys(item).sort(), ['family', 'id', 'inputHex', 'outcome', 'provenance']);
      assert.equal(item.inputHex, expectedHex[item.id], item.id);
      assert.equal(item.provenance.implementation, 'CPython');
      assert.match(item.provenance.python, /^3\.\d+\.\d+$/);
      const family = item.provenance.python.split('.').slice(0, 2).join('.');
      const unicode = { '3.12': '15.0.0', '3.13': '15.1.0', '3.14': '16.0.0' }[family];
      assert.ok(unicode, 'unfrozen interpreter family');
      assert.equal(item.provenance.unicode, unicode, 'unfrozen Unicode profile');
      assert.equal(item.provenance.utf8Mode, 0, 'unfrozen UTF-8 mode');
      if (executable !== primary) {
        assert.equal(item.provenance.python.split('.').slice(0, 2).join('.'), executable.slice(6));
      }
      assert.equal(item.provenance.stdinIsatty, false);
      // An unobserved encoding/error profile must fail instead of borrowing these expectations.
      assert.equal(item.provenance.stdinEncoding, 'utf-8', 'unfrozen stdin encoding');
      assert.equal(item.provenance.stdinErrors, 'surrogateescape', 'unfrozen stdin error profile');
      assert.equal(item.provenance.recursionLimit, 1000);
      assert.deepEqual(item.outcome, expected(item.id, item.family), `${item.family}:${item.id}`);
    }
    const provenance = receipt.cases[0].provenance;
    t.diagnostic(JSON.stringify({ ...provenance, cases: 28, repeatedProfile: profiles.has(provenance.python) }));
    profiles.add(provenance.python);
  });
}

test('stdin reference refuses caller input and arguments', () => {
  for (const [args, input] of [[['--input', 'synthetic-rejected'], ''], [[], 'synthetic-rejected']]) {
    const result = spawnSync(primary, ['-I', reference, ...args], {
      input, encoding: 'utf8', timeout: 3000, maxBuffer: 4096,
    });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'reference_input_rejected\n');
  }
});
