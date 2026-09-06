import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const reference = fileURLToPath(new URL('../tools/contracts/exclusive-file-lock/reference.py', import.meta.url));
const sequence = ['parent-mode', 'open', 'file-mode', 'acquire', 'body', 'release', 'close'];
const expectations = {
  normal: [sequence, null, 0],
  'parent-mode-error': [sequence.slice(0, 1), 'parent-mode', 0],
  'open-error': [sequence.slice(0, 2), 'open', 0],
  'file-mode-error': [sequence.slice(0, 3), 'file-mode', 1],
  'acquire-error': [[...sequence.slice(0, 4), 'release', 'close'], 'acquire', 0],
  'body-error': [sequence, 'body', 0],
  'release-error': [sequence.slice(0, 6), 'release', 1],
  'close-error': [sequence, 'close', 1],
  'body-release-error': [sequence.slice(0, 6), 'release', 1],
  'body-close-error': [sequence, 'close', 1],
  'acquire-release-error': [[...sequence.slice(0, 4), 'release'], 'release', 1],
  'release-close-error': [sequence.slice(0, 6), 'release', 1],
  'existing-file': [sequence, null, 0],
  'symlink-file': [sequence, null, 0],
};

for (const executable of [process.platform === 'win32' ? 'python' : 'python3', 'python3.12', 'python3.13', 'python3.14']) {
  test(`exclusive file lock reference preserves POSIX ordering: ${executable}`, (t) => {
    const run = spawnSync(executable, ['-I', reference], { input: '', encoding: 'utf8', timeout: 10000 });
    if (run.error?.code === 'ENOENT' && executable !== 'python3' && executable !== 'python') {
      t.skip('Required interpreter unavailable'); return;
    }
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.schemaVersion, 1);
    if (process.platform === 'win32') {
      assert.equal(receipt.status, 'unavailable');
      assert.deepEqual(receipt.cases, []);
      t.skip('Native Windows lock reference remains required'); return;
    }
    assert.equal(receipt.status, 'observed');
    assert.equal(receipt.profile.implementation, 'CPython');
    if (!['python', 'python3'].includes(executable)) assert.ok(receipt.profile.python.startsWith(executable.slice(6) + '.'));
    assert.deepEqual(Object.keys(receipt.sources).sort(), [
      'scripts/job_apply_store/constants.py', 'scripts/job_apply_store/errors.py', 'scripts/job_apply_store/io.py',
    ]);
    for (const [path, hash] of Object.entries(receipt.sources)) {
      assert.equal(createHash('sha256').update(readFileSync(root + path)).digest('hex'), hash);
    }
    assert.deepEqual(receipt.cases.map((item) => item.id), Object.keys(expectations));
    for (const item of receipt.cases) {
      const [calls, failure, leaked] = expectations[item.id];
      const existing = ['existing-file', 'symlink-file'].includes(item.id);
      const beforePaths = existing ? item.id === 'symlink-file'
        ? ['.', 'synthetic.lock', 'target'] : ['.', 'synthetic.lock'] : ['.'];
      const afterPaths = ['parent-mode-error', 'open-error'].includes(item.id)
        ? ['.'] : item.id === 'symlink-file' ? ['.', 'synthetic.lock', 'target'] : ['.', 'synthetic.lock'];
      assert.deepEqual(item.before.map((row) => row.path), beforePaths);
      assert.deepEqual(item.after.map((row) => row.path), afterPaths);
      assert.deepEqual(item.calls, calls, item.id);
      assert.equal(item.openDescriptorsAtReturn, leaked, item.id);
      assert.deepEqual(item.outcome, failure === null ? { kind: 'value' }
        : { kind: 'error', name: 'OSError', errno: 5, message: `synthetic ${failure}` });
      assert.equal(item.before[0].mode, 0o755);
      assert.equal(item.after[0].mode, item.id === 'parent-mode-error' ? 0o755 : 0o700);
      const expectedBytes = item.id === 'existing-file' ? Buffer.from('synthetic existing lock').toString('hex') : '';
      const file = item.after.find((row) => row.path === 'synthetic.lock');
      if (['parent-mode-error', 'open-error'].includes(item.id)) assert.equal(file, undefined);
      else if (item.id === 'symlink-file') {
        assert.equal(file.kind, 'link');
        assert.equal(file.target, 'target');
        const target = item.after.find((row) => row.path === 'target');
        assert.equal(target.mode, 0o600);
        assert.equal(target.bytes, Buffer.from('synthetic target').toString('hex'));
      } else {
        assert.equal(file.kind, 'file');
        assert.equal(file.mode, 0o600);
        assert.equal(file.bytes, expectedBytes);
      }
    }
  });
}

test('exclusive lock reference rejects caller input', () => {
  const executable = process.platform === 'win32' ? 'python' : 'python3';
  const run = spawnSync(executable, ['-I', reference], { input: '{}', encoding: 'utf8', timeout: 10000 });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /accepts no caller data/);
  const argument = spawnSync(executable, ['-I', reference, 'unexpected'], { input: '', encoding: 'utf8', timeout: 10000 });
  assert.notEqual(argument.status, 0);
  assert.match(argument.stderr, /accepts no caller data/);
});
