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

test('required validation runs native resume onboarding through the CLI and Companion', () => {
  const { suites } = JSON.parse(read('config/test-matrix.json'));
  for (const [id, path] of [
    ['node-native-cli', 'tests_js/native_installed_entrypoints.test.mjs'],
    ['node-native-unit', 'tests_js/workspace_native_extractions.test.mjs'],
    ['node-native-browser', 'tests_js/required_companion.test.mjs'],
  ]) {
    const suite = suites.find(row => row.id === id);
    assert.ok(suite?.tiers.includes('full'), id);
    assert.ok(suite.include.includes(path), path);
    assert.ok(read(path));
  }
  const workflow = read('.github/workflows/validate.yml');
  assert.match(workflow, /suite: \[node-native-unit, node-native-cli, node-native-browser\]/);
  assert.doesNotMatch(workflow, /qa:resume-extraction-onboarding/);
});
