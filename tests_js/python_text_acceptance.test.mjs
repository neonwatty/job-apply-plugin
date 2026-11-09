import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseTaskTap } from '../tools/migration/tap-evidence.mjs';

const retainedNames = [
  'PythonText retains distinct pair/scalar identities across construction and concatenation',
  'PythonText defensively freezes content and preserves immutable error originals',
  'PythonText rejects malformed runtime inputs and implicit conversion',
  'PythonText UTF8 boundary bytes and long concatenation avoid argument-stack limits',
];
const expectedNames = ['python3', 'python3.12', 'python3.13', 'python3.14']
  .map(executable => `PythonText matches frozen builtin reference: ${executable}`).concat(retainedNames);
let capture;
function childEvidence(t, name) {
  if (!capture) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_')));
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap',
      fileURLToPath(new URL('./python_text_ts.test.mjs', import.meta.url))], {
      env, encoding: 'utf8', timeout: 100000, maxBuffer: 524288,
    });
    const childTap = result.stdout ?? '';
    t.diagnostic(`Child TAP SHA256 ${createHash('sha256').update(childTap).digest('hex')}`);
    t.diagnostic(childTap);
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, '');
    const parsed = parseTaskTap(result.stdout);
    assert.ok(parsed, 'Child TAP must be complete, flat, passing and free of skips/cancellations/TODOs');
    assert.deepEqual(parsed.names, expectedNames);
    assert.equal(parsed.tests, 8);
    capture = parsed;
    t.diagnostic('Validated all eight unchanged child tests');
  }
  assert.ok(capture.names.includes(name));
}
// Retain the original four public witness identities. All eight child cases are
// strictly validated once, and their complete output is preserved as diagnostics.
test('PythonText retains distinct pair/scalar identities across construction and concatenation', t => {
  childEvidence(t, retainedNames[0]);
});
test('PythonText defensively freezes content and preserves immutable error originals', t => {
  childEvidence(t, retainedNames[1]);
});
test('PythonText rejects malformed runtime inputs and implicit conversion', t => {
  childEvidence(t, retainedNames[2]);
});
test('PythonText UTF8 boundary bytes and long concatenation avoid argument-stack limits', t => {
  childEvidence(t, retainedNames[3]);
});
