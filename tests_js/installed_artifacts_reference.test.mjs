import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const driver = fileURLToPath(new URL('../tools/contracts/installed-artifacts/reference.py', import.meta.url));
const source = new URL('../scripts/smoke/artifacts.py', import.meta.url);
const fixed = ['.codex-plugin/plugin.json', 'scripts/job-apply-store.py',
  'scripts/job-apply-task.py', 'scripts/job-apply-attempt.py', 'scripts/job-apply-workspace.py',
  'skills/answer-memory/SKILL.md', 'skills/job-apply/SKILL.md'];
const trees = ['runtime', 'scripts/job_apply_store', 'scripts/job_apply_workspace', 'workspace'];
const files = [...fixed, 'runtime/nested/codec.js', 'scripts/job_apply_store/io.py',
  'scripts/job_apply_workspace/handler.py', 'workspace/app.js'].sort();
const cases = [
  ['inventory-normal', 'inventory', null],
  ['inventory-extra-runtime', 'inventory', 'extra-runtime'],
  ['inventory-extra-outside', 'inventory', 'extra-outside'],
  ['inventory-empty-trees', 'inventory', 'empty-trees'],
  ['inventory-missing-fixed', 'inventory', 'missing-fixed'],
  ['inventory-missing-tree', 'inventory', 'missing-tree'],
  ['inventory-fixed-directory', 'inventory', 'fixed-directory'],
  ['inventory-tree-file', 'inventory', 'tree-file'],
  ['inventory-ancestor-file', 'inventory', 'ancestor-file'],
  ['inventory-fixed-link', 'inventory', 'fixed-link'],
  ['inventory-ancestor-link', 'inventory', 'ancestor-link'],
  ['inventory-nested-directory-link', 'inventory', 'nested-directory-link'],
  ['inventory-nested-file-link', 'inventory', 'nested-file-link'],
  ['inventory-dangling-link', 'inventory', 'dangling-link'],
  ['inventory-root-link', 'inventory', null],
  ['inventory-nested-fifo', 'inventory', 'nested-fifo'],
  ['verify-normal', 'verify', null],
  ['verify-tamper', 'verify', 'tamper'],
  ['verify-extra-runtime', 'verify', 'extra-runtime'],
  ['verify-extra-outside', 'verify', 'extra-outside'],
  ['verify-mode', 'verify', 'mode'],
  ['verify-empty-dir', 'verify', 'empty-dir'],
  ['verify-missing-fixed', 'verify', 'missing-fixed'],
  ['verify-missing-nested', 'verify', 'missing-nested'],
  ['copy-empty', 'copy', null],
  ['copy-empty-trees', 'copy', 'source-empty-trees'],
  ['copy-overwrite', 'copy', 'tamper'],
  ['copy-extra-retained', 'copy', 'extra-runtime'],
  ['copy-directory-rejected', 'copy', 'fixed-directory'],
  ['copy-link-rejected', 'copy', 'fixed-link'],
  ['copy-ancestor-rejected', 'copy', 'ancestor-link'],
  ['copy-dangling-ancestor', 'copy', 'dangling-ancestor'],
  ['copy-source-invalid', 'copy', 'source-invalid'],
];
const errors = {
  'inventory-missing-fixed': 'critical package artifact is missing: scripts/job-apply-store.py',
  'inventory-missing-tree': 'critical package artifact is missing: runtime',
  'inventory-fixed-directory': 'critical package artifact is not a regular file: scripts/job-apply-store.py',
  'inventory-tree-file': 'critical package tree is not a directory: runtime',
  'inventory-ancestor-file': 'critical package ancestor is not a directory: skills/answer-memory/SKILL.md',
  'inventory-fixed-link': 'critical package path contains a symlink: scripts/job-apply-store.py',
  'inventory-ancestor-link': 'critical package path contains a symlink: scripts/job-apply-store.py',
  'inventory-nested-directory-link': 'critical package tree contains a symlink: runtime/nested/linked',
  'inventory-nested-file-link': 'critical package tree contains a symlink: runtime/nested/linked.js',
  'inventory-dangling-link': 'critical package path contains a symlink: scripts/job-apply-store.py',
  'inventory-nested-fifo': 'critical package artifact is not a regular file: runtime/nested/pipe',
  'verify-tamper': 'synthetic bytes differ for scripts/job-apply-store.py',
  'verify-extra-runtime': 'synthetic critical package inventory differs',
  'verify-missing-fixed': 'critical package artifact is missing: scripts/job-apply-store.py',
  'verify-missing-nested': 'synthetic critical package inventory differs',
  'copy-directory-rejected': 'critical package destination is not a regular file: scripts/job-apply-store.py',
  'copy-link-rejected': 'critical package path contains a symlink: scripts/job-apply-store.py',
  'copy-ancestor-rejected': 'critical package path contains a symlink: scripts/job-apply-attempt.py',
  'copy-dangling-ancestor': 'critical package path contains a symlink: scripts/job-apply-attempt.py',
  'copy-source-invalid': 'critical package artifact is missing: scripts/job-apply-store.py',
};
const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
const hash = value => createHash('sha256').update(value).digest('hex');
function snapshot(rows) {
  assert.ok(Array.isArray(rows) && rows.length >= 5);
  const paths = rows.map(row => row.path);
  assert.equal(new Set(paths).size, paths.length);
  assert.deepEqual(paths, [...paths].sort());
  assert.equal(rows[0].path, '.');
  for (const row of rows) {
    keys(row, ['path', 'kind', 'mode', 'mtimeNs', 'sha256', 'target']);
    assert.ok(['file', 'directory', 'symlink', 'fifo'].includes(row.kind));
    assert.ok(Number.isSafeInteger(row.mode) && row.mode >= 0 && row.mode <= 0o7777);
    assert.match(row.mtimeNs, /^\d+$/);
    if (row.kind === 'file') assert.match(row.sha256, /^[a-f0-9]{64}$/);
    else assert.equal(row.sha256, null);
    if (row.kind === 'symlink') assert.equal(typeof row.target, 'string');
    else assert.equal(row.target, null);
  }
  return new Map(rows.map(row => [row.path, row]));
}

for (const executable of ['python3', 'python3.12', 'python3.13', 'python3.14']) {
  test(`installed artifacts reference: ${executable}`, t => {
    if (process.platform === 'win32') return t.skip('Native Windows symlink/FIFO/mode cells remain unverified');
    const run = spawnSync(executable, ['-I', driver], {
      input: '', encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024,
    });
    if (run.error?.code === 'ENOENT' && executable !== 'python3') {
      return t.skip('Interpreter executable alias unavailable; no profile evidence');
    }
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    const receipt = JSON.parse(run.stdout);
    keys(receipt, ['schemaVersion', 'profile', 'sourceSha256', 'fixedFiles', 'criticalTrees', 'cases']);
    assert.equal(receipt.schemaVersion, 1);
    keys(receipt.profile, ['implementation', 'python', 'platform']);
    assert.equal(receipt.profile.implementation, 'CPython');
    assert.equal(receipt.profile.platform, process.platform);
    assert.match(receipt.profile.python, /^3\.(12|13|14)\.\d+$/);
    if (executable !== 'python3') assert.ok(receipt.profile.python.startsWith(`${executable.slice(6)}.`));
    assert.equal(receipt.sourceSha256, hash(readFileSync(source)));
    assert.deepEqual(receipt.fixedFiles, fixed);
    assert.deepEqual(receipt.criticalTrees, trees);
    assert.deepEqual(receipt.cases.map(row => [row.id, row.operation, row.change]), cases);
    for (const row of receipt.cases) {
      keys(row, ['id', 'operation', 'change', 'outcome', 'before', 'after']);
      const before = snapshot(row.before);
      const after = snapshot(row.after);
      assert.deepEqual(row.before.filter(item => item.path.startsWith('source')),
        row.after.filter(item => item.path.startsWith('source')), 'source preservation');
      if (errors[row.id]) {
        assert.deepEqual(row.outcome, { kind: 'error', name: 'SystemExit', message: errors[row.id] });
      } else {
        let value = null;
        if (row.operation === 'inventory') {
          value = row.id === 'inventory-empty-trees' ? [...fixed].sort()
            : row.id === 'inventory-extra-runtime' ? [...files, 'runtime/extra.js'].sort() : files;
        }
        assert.deepEqual(row.outcome, { kind: 'value', value });
      }
      if (row.operation !== 'copy' || errors[row.id]) {
        assert.deepEqual(row.after, row.before, row.id);
      } else {
        const copied = row.id === 'copy-empty-trees' ? fixed : files;
        const copiedPaths = new Set(copied.map(relative => `target/${relative}`));
        const expectedPaths = new Set(before.keys());
        for (const path of copiedPaths) {
          const parts = path.split('/');
          for (let length = 1; length <= parts.length; length += 1) {
            expectedPaths.add(parts.slice(0, length).join('/'));
          }
        }
        assert.deepEqual([...after.keys()].sort(), [...expectedPaths].sort(), 'copy creates only required files and parents');
        for (const [path, entry] of before) {
          if (entry.kind !== 'directory' && !copiedPaths.has(path)) {
            assert.deepEqual(after.get(path), entry, `copy preserves non-copied entry ${path}`);
          }
        }
        for (const relative of copied) {
          const sourceRow = before.get(`source/${relative}`);
          assert.equal(sourceRow.sha256, hash(Buffer.concat([Buffer.from(`synthetic:${relative}`), Buffer.from([0, 255, 10])])));
          assert.equal(sourceRow.mode, 0o640);
          assert.equal(sourceRow.mtimeNs, '1700000000000000000');
          assert.deepEqual(after.get(`target/${relative}`), { ...sourceRow, path: `target/${relative}` });
        }
        if (row.id === 'copy-extra-retained') {
          assert.deepEqual(after.get('target/runtime/extra.js'), before.get('target/runtime/extra.js'));
        }
        if (row.id === 'copy-empty-trees') {
          for (const tree of trees) assert.equal(after.has(`target/${tree}`), false);
        }
      }
      if (row.id.startsWith('copy-') && errors[row.id]) {
        assert.equal(before.get('target/.codex-plugin/plugin.json').sha256, hash('unchanged target sentinel'));
      }
      if (row.id === 'inventory-root-link') {
        assert.equal(before.get('alias').kind, 'symlink');
        assert.equal(before.get('alias').target, 'target');
      }
    }
    t.diagnostic(`${receipt.profile.python}: ${cases.length} fixed native synthetic cases; default may repeat a profile`);
  });
}

test('installed artifacts reference rejects caller paths and stdin', () => {
  const executable = process.platform === 'win32' ? 'python' : 'python3';
  for (const [args, input] of [[['--source', 'synthetic'], ''], [[], 'synthetic']]) {
    const run = spawnSync(executable, ['-I', driver, ...args], { input, encoding: 'utf8', timeout: 3000 });
    assert.equal(run.status, 2);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, 'installed_artifacts_reference_input_rejected\n');
  }
});
