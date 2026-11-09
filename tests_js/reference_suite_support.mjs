import assert from 'node:assert/strict';
import { suiteCommand } from '../tools/test-runner/execute.mjs';
import { selectAffected, suiteFiles, tierSuites, validateMatrix } from '../tools/test-runner/matrix.mjs';

const S04 = 'node-reference-s04';
const S05 = 'node-reference-s05';
const LIMIT = 2 * 1024 * 1024;
const GROUPS = [
  [S04, [
    'tests_js/point_persistence_reference.test.mjs',
    'tests_js/point_persistence_baselines.test.mjs',
  ]],
  [S05, [
    'tests_js/point_paths_reference.test.mjs',
    'tests_js/point_paths_parent_reference.test.mjs',
    'tests_js/point_paths_digest_reference.test.mjs',
  ]],
];
const BASELINES = [
  'tests_js/atomic_write_json_reference.test.mjs',
  'tests_js/jsonl_append_reference.test.mjs',
];
const S05_INPUT_TESTS = [
  'tests_js/managed_resume_path_reference.test.mjs',
  'tests_js/posix_path_bytes_reference.test.mjs',
  'tests_js/private_file_digest_reference.test.mjs',
  'tests_js/managed_observation_reference.test.mjs',
];
const DRIVERS = [
  'tools/contracts/point-persistence/reference.py',
  'tools/contracts/point-persistence/support.py',
  'tools/contracts/point-paths/reference.py',
  'tools/contracts/point-paths/fixtures.py',
  'tools/contracts/atomic-write-json/reference.py',
  'tools/contracts/jsonl-append/support.py',
  'tools/contracts/managed-resume-path/reference.py',
  'tools/contracts/private-file-digest/reference.py',
];
const PYTHON = [
  'scripts/job_apply_store/__init__.py',
  'scripts/job_apply_store/io.py',
  'scripts/job_apply_store/constants.py',
  'scripts/job_apply_store/domains/resumes/storage.py',
  'scripts/qa-replay.py',
];
const OLD_PYTHON_OWNERS = [
  'python-qa', 'python-workspace-contracts', 'python-accounts', 'python-core',
  'node-recorder', 'node-renderer', 'node-workspace-other',
];

function isolation(matrix, tracked) {
  assert.deepEqual(validateMatrix(matrix, tracked), []);
  const workspace = matrix.suites.find(suite => suite.id === 'node-workspace-other');
  assert.ok(workspace);
  for (const [id, files] of GROUPS) {
    const suite = matrix.suites.find(value => value.id === id);
    assert.deepEqual(suite, { id, kind: 'node-test', include: files, tiers: ['full'], maxOutputBytes: LIMIT });
    const sorted = [...files].sort();
    assert.deepEqual(suiteFiles(suite, tracked), sorted);
    assert.deepEqual(suiteCommand(suite, tracked), [process.execPath, '--test', '--test-concurrency=1', ...sorted]);
    for (const file of files) {
      assert.ok(tracked.includes(file), `missing reference test ${file}`);
      assert.ok(!suiteFiles(workspace, tracked).includes(file));
      const owners = matrix.suites.filter(value => value.tiers.includes('full') && suiteFiles(value, tracked).includes(file));
      assert.deepEqual(owners.map(value => value.id), [id]);
    }
  }
}

function selected(matrix, tracked, file, required) {
  const result = selectAffected(matrix, tracked, [file]);
  assert.equal(result.fallbackReason, null, `unexpected fallback for ${file}`);
  for (const id of required) assert.ok(result.suiteIds.includes(id), `${file} omitted ${id}`);
}

function fanout(matrix, tracked) {
  for (const [id, files] of GROUPS) {
    for (const file of files) selected(matrix, tracked, file, [id]);
  }
  for (const file of DRIVERS) selected(matrix, tracked, file, ['node-workspace-other', S04, S05]);
  for (const file of PYTHON) selected(matrix, tracked, file, [...OLD_PYTHON_OWNERS, S04, S05]);
  for (const [id, directory, names] of [
    [S04, 's04', ['reference-vectors.json', 'S04.R.json']],
    [S05, 's05', ['reference-vectors.json', 'reference-baselines.json', 'S05.R.json']],
  ]) {
    for (const name of names) selected(matrix, tracked, `docs/migration/evidence/${directory}/${name}`, ['docs-links', id]);
  }
  for (const file of BASELINES) selected(matrix, tracked, file, ['node-workspace-other', S04, S05]);
  for (const file of S05_INPUT_TESTS) selected(matrix, tracked, file, ['node-workspace-other', S05]);
  selected(matrix, tracked, 'tests_js/reference_suite_support.mjs', ['node-runner-fast']);
  for (const file of ['unowned/future.kind', 'config/test-matrix.json', 'tools/migration/tap-evidence.mjs']) {
    const result = selectAffected(matrix, tracked, [file]);
    assert.match(result.fallbackReason, /^(unknown|global) path:/);
    assert.deepEqual(result.suiteIds, tierSuites(matrix, 'full'));
    assert.ok(result.suiteIds.includes(S04) && result.suiteIds.includes(S05));
  }
}

export function assertReferenceSuiteIsolation(matrix, tracked) {
  isolation(matrix, tracked);
  const merged = structuredClone(matrix);
  merged.suites.find(suite => suite.id === S04).include.push(...GROUPS[1][1]);
  merged.suites = merged.suites.filter(suite => suite.id !== S05);
  assert.throws(() => isolation(merged, tracked), assert.AssertionError);
  for (const maxOutputBytes of [LIMIT - 1, LIMIT + 1]) {
    const changed = structuredClone(matrix);
    changed.suites.find(suite => suite.id === S05).maxOutputBytes = maxOutputBytes;
    assert.throws(() => isolation(changed, tracked), assert.AssertionError);
  }
}

export function assertReferenceSuiteFanout(matrix, tracked) {
  fanout(matrix, tracked);
  for (const path of ['tools/contracts/**', 'scripts/**/*.py', 'docs/migration/evidence/s05/**']) {
    const changed = structuredClone(matrix);
    const row = changed.ownership.find(value => value.paths.includes(path));
    assert.ok(row, `missing ownership row for ${path}`);
    row.suites = row.suites.filter(id => id !== S05);
    assert.throws(() => fanout(changed, tracked), assert.AssertionError);
  }
  for (const [id, files] of GROUPS) {
    const omitted = structuredClone(matrix);
    omitted.suites.find(suite => suite.id === id).include = files.slice(1);
    assert.ok(validateMatrix(omitted, tracked).includes(`full inventory count 0 for ${files[0]}`));
    const duplicated = structuredClone(matrix);
    duplicated.suites.find(suite => suite.id === 'node-workspace-other').include.push(files[0]);
    assert.ok(validateMatrix(duplicated, tracked).includes(`full inventory count 2 for ${files[0]}`));
  }
}
