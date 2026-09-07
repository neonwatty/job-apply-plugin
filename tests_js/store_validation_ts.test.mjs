import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parsePythonJson } from '../runtime/contracts/raw-json/parser.js';
import { requireObject, validateVersion, StoreValidationError } from '../runtime/store/validation.js';

const reference = fileURLToPath(new URL('../tools/contracts/store-validation/reference.py', import.meta.url));
const primary = process.platform === 'win32' ? 'python' : 'python3';
const profiles = new Set();
function verifyValidation(executable, t) {
    const result = spawnSync(executable, ['-I', reference], {
      input: '', encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024,
    });
    if (result.error?.code === 'ENOENT' && executable !== primary) {
      t.skip('Interpreter unavailable; reference profile remains unverified');
      return;
    }
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.cases.length, 78);
    t.diagnostic(`CPython ${receipt.python}: 78 fixed cases; duplicate profile=${profiles.has(receipt.python)}`);
    profiles.add(receipt.python);
    for (const item of receipt.cases) {
      const value = parsePythonJson(item.raw, { intMaxStrDigits: 4300 });
      let actual;
      try {
        const document = requireObject(value, item.label);
        assert.equal(document, value);
        validateVersion(document, item.label);
        actual = { ok: true };
      } catch (error) {
        assert.ok(error instanceof StoreValidationError);
        actual = { ok: false, message: error.message };
      }
      assert.deepEqual(actual, item.outcome, item.raw);
    }
}

if (process.platform === 'win32') {
  test('document validation matches authoritative Python: python', t => verifyValidation(primary, t));
} else {
  test('document validation matches authoritative Python: python3', t => verifyValidation(primary, t));
}
test('document validation matches authoritative Python: python3.12', t => verifyValidation('python3.12', t));
test('document validation matches authoritative Python: python3.13', t => verifyValidation('python3.13', t));
test('document validation matches authoritative Python: python3.14', t => verifyValidation('python3.14', t));

test('document validation preserves all entries and typed atom identities', () => {
  const document = parsePythonJson('{"schemaVersion":1,"other":1.0}', { intMaxStrDigits: 4300 });
  const before = [...document.entries()];
  assert.equal(requireObject(document, 'profile'), document);
  validateVersion(document, 'profile');
  assert.deepEqual([...document.entries()], before);
  for (const [key, value] of before) assert.equal(document.get(key), value);
});

test('fixed reference refuses caller arguments and input', () => {
  for (const [args, input] of [[['ignored'], ''], [[], 'caller data']]) {
    const result = spawnSync(primary, ['-I', reference, ...args], {
      input, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'reference_input_rejected\n');
  }
});
