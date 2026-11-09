import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { evaluateGate } from '../tools/ci/gate.mjs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
test('required workflows use the native matrix without Python jobs or bootstrap', () => {
  for (const path of ['.github/workflows/validate.yml', '.github/workflows/release.yml']) {
    const source = read(path);
    assert.doesNotMatch(source, /setup-python|python3?\s|python-shards|windows-store-workspace/);
    assert.match(source, /node-version: ['"]22['"]/);
  }
  const matrix = JSON.parse(read('config/test-matrix.json'));
  assert.equal(matrix.runtime, 'typescript');
  assert.equal(matrix.suites.some(suite => suite.kind === 'python-unittest'), false);
  assert.ok(matrix.referenceTests.some(entry => entry.path.includes('atomic_write_json_ts')));
  assert.match(read('.github/workflows/python-migration-once.yml'), /workflow_dispatch:/);
  assert.doesNotMatch(read('.github/workflows/python-migration-once.yml'), /pull_request:|push:|schedule:/);
});
test('aggregate gate rejects failures, cancellation, skips and missing required jobs', () => {
  for (const result of ['failure','cancelled','skipped','']) {
    assert.equal(evaluateGate({ policy: { result } }, ['policy']).ok, false);
  }
  assert.equal(evaluateGate({}, ['policy']).ok, false);
  assert.equal(evaluateGate({ policy: { result: 'success' } }, ['policy']).ok, true);
});
