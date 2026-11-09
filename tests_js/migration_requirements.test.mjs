import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRequirements, missingRequirementCoverage } from '../tools/migration/requirements.mjs';

function fixture() {
  const hash = 'a'.repeat(64);
  const context = { nodes: new Set(['UI0']), surfaces: new Set(['helper']), platforms: new Set(['node-local']),
    files: new Map([['workspace/helper.js', hash]]), suites: new Map([['workspace', new Set(['tests_js/helper.test.mjs'])]]),
    testIds: new Map([['tests_js/helper.test.mjs', new Set(['helper fixed expectations'])]]) };
  const requirement = { id: 'helper.valid', family: 'UI0', surfaceIds: ['helper'], category: 'valid',
    applicability: { status: 'required' }, platformCells: ['node-local'],
    oracleFiles: [{ path: 'workspace/helper.js', sha256: hash }], expectedArtifacts: ['test-log'],
    testBindings: [{ suiteId: 'workspace', file: 'tests_js/helper.test.mjs', testId: 'helper fixed expectations',
      command: ['node', '--test', 'tests_js/helper.test.mjs'], timeoutMs: 30000, maxOutputBytes: 65536 }] };
  return { context, requirement };
}
test('requirements define registered work without inventing passing results', () => {
  const { context, requirement } = fixture();
  assert.deepEqual(validateRequirements([requirement], context), []);
  assert.equal(missingRequirementCoverage(context.surfaces, [requirement]).length, 9);
  assert.ok(missingRequirementCoverage(context.surfaces, [requirement]).includes('helper:interruption'));
  requirement.status = 'passed';
  assert.ok(validateRequirements([requirement], context).length);
});
test('unknown, missing, stale and unregistered requirement bindings fail', () => {
  for (const mutate of [
    (item) => { item.oracleFiles[0].sha256 = 'b'.repeat(64); },
    (item) => { item.surfaceIds = ['unknown']; },
    (item) => { item.family = 'UNKNOWN'; },
    (item) => { item.platformCells = []; },
    (item) => { item.category = 'happy-only'; },
    (item) => { item.testBindings[0].file = 'unregistered.test.mjs'; },
    (item) => { item.testBindings[0].command = 'node --test'; },
    (item) => { item.testBindings[0].command = ['node', '-e', 'process.exit(0)']; },
    (item) => { item.testBindings[0].testId = 'fabricated'; },
    (item) => { item.testBindings[0].timeoutMs = 0; },
    (item) => { item.testBindings[0].maxOutputBytes = Infinity; },
    (item) => { item.testBindings = []; },
    (item) => { item.expectedArtifacts = []; },
  ]) {
    const { context, requirement } = fixture(); mutate(requirement);
    assert.ok(validateRequirements([requirement], context).length);
  }
});
test('inapplicability requires independently attributed rationale and bound source', () => {
  const { context, requirement } = fixture();
  requirement.applicability = { status: 'inapplicable', rationale: 'No helper-owned filesystem operations',
    reviewer: 'independent reviewer', sourcePaths: ['workspace/helper.js'] };
  requirement.testBindings = [];
  requirement.expectedArtifacts = [];
  assert.deepEqual(validateRequirements([requirement], context), []);
  requirement.applicability.sourcePaths = ['unreviewed.js'];
  assert.ok(validateRequirements([requirement], context).length);
  requirement.applicability = { status: 'skipped' };
  assert.ok(validateRequirements([requirement], context).length);
});
test('malformed requirement structures return errors without throwing', () => {
  const { context, requirement } = fixture();
  requirement.applicability = { status: 'inapplicable', rationale: 'synthetic', reviewer: 'reviewer', sourcePaths: ['x'] };
  requirement.testBindings = [];
  requirement.expectedArtifacts = [];
  for (const value of [null, {}, 'invalid', [null]]) {
    requirement.oracleFiles = value;
    assert.ok(validateRequirements([requirement], context).length);
  }
  assert.ok(validateRequirements([requirement], {}).length);
  assert.equal(missingRequirementCoverage(['helper'], [null, { surfaceIds: null }]).length, 10);
});
test('duplicate IDs and missing categories cannot complete coverage', () => {
  const { context, requirement } = fixture();
  assert.ok(validateRequirements([requirement, requirement], context).length);
  const categories = ['valid', 'invalid', 'missing', 'noop', 'privacy', 'conflict', 'concurrency', 'interruption', 'recovery', 'platform'];
  const requirements = categories.map((category) => ({ ...requirement, id: category, category }));
  assert.deepEqual(missingRequirementCoverage(context.surfaces, requirements), []);
  assert.equal(missingRequirementCoverage(new Set(['helper', 'new']), requirements).length, 10);
});
