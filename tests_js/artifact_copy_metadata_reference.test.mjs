import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const driver = fileURLToPath(new URL('../tools/contracts/artifact-copy-metadata/reference.py', import.meta.url));
const source = new URL('../scripts/smoke/artifacts.py', import.meta.url);
const files = ['.codex-plugin/plugin.json', 'runtime/data.bin', 'scripts/job-apply-attempt.py',
  'scripts/job-apply-store.py', 'scripts/job-apply-task.py', 'scripts/job-apply-workspace.py',
  'skills/answer-memory/SKILL.md', 'skills/job-apply/SKILL.md'];
const fixtures = [
  ['fractional', '1700000000123456789'], ['negative', '-600'],
  ['near-carry', '1767225600999999500'], ['xattrs', '1700000000987654321'],
  ...['before-copy', 'after-data', 'after-copy', 'utime-error', 'chmod-error'].map(id => [id, '1700000000123456789']),
];
const hash = value => createHash('sha256').update(value).digest('hex');
const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
const contents = (label, path) => Buffer.concat([Buffer.from(`${label}:${path}`), Buffer.from([0, 255])]);
function checkedRows(rows) {
  assert.deepEqual(rows.map(row => row.path), files);
  for (const row of rows) {
    keys(row, ['path', 'mode', 'mtimeNs', 'size', 'sha256', 'xattrs', 'flags']);
    assert.ok(Number.isSafeInteger(row.mode) && row.mode >= 0 && row.mode <= 0o7777);
    assert.match(row.mtimeNs, /^-?\d+$/);
    assert.ok(Number.isSafeInteger(row.size) && row.size >= 0);
    assert.match(row.sha256, /^[a-f0-9]{64}$/);
    assert.ok(row.flags === null || Number.isSafeInteger(row.flags));
    if (row.path !== 'runtime/data.bin') assert.equal(row.xattrs, null);
    else if (row.xattrs !== null) {
      for (const [name, value] of Object.entries(row.xattrs)) {
        assert.ok(['user.job_apply_synthetic', 'user.job_apply_target_only'].includes(name));
        assert.match(value, /^(?:[a-f0-9]{2})*$/);
      }
    }
  }
}

for (const executable of ['python3', 'python3.12', 'python3.13', 'python3.14']) {
  test(`artifact copy metadata reference: ${executable}`, t => {
    if (process.platform === 'win32') return t.skip('Native Windows copy metadata not observed');
    const run = spawnSync(executable, ['-I', driver], { input: '', encoding: 'utf8', timeout: 20000, maxBuffer: 2 ** 20 });
    if (run.error?.code === 'ENOENT' && executable !== 'python3') return t.skip('Interpreter executable alias unavailable');
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    const receipt = JSON.parse(run.stdout);
    keys(receipt, ['schemaVersion', 'profile', 'sourceSha256', 'shutilSha256', 'cases']);
    assert.equal(receipt.schemaVersion, 1);
    keys(receipt.profile, ['implementation', 'python', 'platform', 'xattrBackend', 'pythonXattrAPI']);
    assert.equal(receipt.profile.implementation, 'CPython');
    assert.equal(receipt.profile.platform, process.platform);
    assert.match(receipt.profile.python, /^3\.(12|13|14)\.\d+$/);
    if (executable !== 'python3') assert.ok(receipt.profile.python.startsWith(`${executable.slice(6)}.`));
    assert.ok([null, 'python-os', 'macos-xattr-tool'].includes(receipt.profile.xattrBackend));
    assert.equal(typeof receipt.profile.pythonXattrAPI, 'boolean');
    if (receipt.profile.xattrBackend === 'macos-xattr-tool') assert.equal(process.platform, 'darwin');
    assert.equal(receipt.sourceSha256, hash(readFileSync(source)));
    const library = spawnSync(executable, ['-I', '-c',
      'import hashlib,pathlib,shutil;print(hashlib.sha256(pathlib.Path(shutil.__file__).read_bytes()).hexdigest())'],
    { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 });
    assert.equal(library.status, 0, library.stderr);
    assert.equal(receipt.shutilSha256, library.stdout.trim());
    assert.deepEqual(receipt.cases.map(row => row.id), fixtures.map(([id]) => id));
    let unavailable = 0;
    for (const [index, row] of receipt.cases.entries()) {
      if (row.status === 'unavailable') {
        assert.equal(row.id, 'xattrs');
        keys(row, row.errno === undefined ? ['id', 'status', 'reason'] : ['id', 'status', 'reason', 'errno']);
        assert.ok(['xattr API absent', 'xattr filesystem unsupported'].includes(row.reason));
        if (row.errno !== undefined) assert.ok([constants.errno.ENOTSUP, constants.errno.EOPNOTSUPP].includes(row.errno));
        unavailable += 1;
        continue;
      }
      keys(row, ['id', 'status', 'requestedNs', 'native', 'outcome', 'events',
        'sourceBefore', 'sourceAfter', 'targetBefore', 'targetAfter', 'pathsBefore', 'pathsAfter']);
      assert.equal(row.status, 'observed');
      assert.equal(row.requestedNs, fixtures[index][1]);
      assert.equal(row.native, index < 4);
      for (const field of ['sourceBefore', 'sourceAfter', 'targetBefore', 'targetAfter']) checkedRows(row[field]);
      assert.deepEqual(row.sourceAfter, row.sourceBefore);
      const pathSet = new Set();
      for (const prefix of ['source', 'target']) {
        for (const relative of [...files, 'skills', 'runtime', 'scripts/job_apply_store', 'scripts/job_apply_workspace', 'workspace']) {
          const parts = `${prefix}/${relative}`.split('/');
          for (let length = 1; length <= parts.length; length += 1) pathSet.add(parts.slice(0, length).join('/'));
        }
      }
      const expectedPaths = [...pathSet].sort();
      assert.deepEqual(row.pathsBefore, expectedPaths);
      assert.deepEqual(row.pathsAfter, expectedPaths, 'no temp cleanup or rollback artifacts created');
      for (const [position, path] of files.entries()) {
        const original = row.sourceBefore[position];
        const before = row.targetBefore[position];
        assert.equal(original.sha256, hash(contents('source', path)));
        assert.equal(original.size, contents('source', path).length);
        assert.equal(original.mode, 0o640);
        assert.equal(original.mtimeNs, row.requestedNs);
        assert.equal(before.sha256, hash(contents('target', path)));
        assert.equal(before.mode, 0o600);
        assert.equal(before.mtimeNs, '1700000000000000000');
        const after = row.targetAfter[position];
        if (row.native || position === 0 || position === 1 && row.id === 'after-copy') {
          const expected = { ...original, xattrs: before.xattrs };
          if (path === 'runtime/data.bin' && receipt.profile.pythonXattrAPI) {
            expected.xattrs = { ...before.xattrs, ...original.xattrs };
          }
          assert.deepEqual(after, expected);
        } else if (position === 1 && row.id !== 'before-copy') {
          assert.equal(after.sha256, original.sha256);
          assert.equal(after.size, original.size);
          assert.equal(after.mode, before.mode);
          assert.deepEqual(after.xattrs, before.xattrs);
          assert.equal(after.flags, before.flags);
          if (row.id === 'chmod-error') assert.equal(after.mtimeNs, original.mtimeNs);
          else {
            assert.notEqual(after.mtimeNs, original.mtimeNs);
            assert.notEqual(after.mtimeNs, before.mtimeNs);
          }
        } else assert.deepEqual(after, before, 'later files retain their original bytes and metadata');
      }
      if (row.id === 'xattrs') {
        assert.deepEqual(row.sourceBefore[1].xattrs, { 'user.job_apply_synthetic': '73796e74686574696300ff' });
        assert.deepEqual(row.targetBefore[1].xattrs, { 'user.job_apply_target_only': '72657461696e6564' });
      }
      const expectedEvents = (row.native ? files : files.slice(0, 2)).map(path => `copy:${path}`);
      if (row.id === 'utime-error') expectedEvents.push('fault:utime');
      if (row.id === 'chmod-error') expectedEvents.push('fault:chmod');
      assert.deepEqual(row.events, expectedEvents);
      assert.deepEqual(row.outcome, row.native ? { kind: 'value', value: null }
        : { kind: 'error', name: 'OSError', errno: constants.errno.EIO });
    }
    t.diagnostic(`${receipt.profile.python}: ${9 - unavailable} observed; ${unavailable} unavailable; native and injected cells distinguished`);
    if (unavailable) t.skip('Partial metadata evidence; native xattrs unavailable');
  });
}

test('Node double utimes cannot reproduce frozen fractional nanoseconds on this native filesystem', async t => {
  if (process.platform !== 'darwin') return t.skip('Bounded native macOS observation only');
  const root = await mkdtemp(join(tmpdir(), 'copy-time-node-'));
  try {
    const path = join(root, 'synthetic.bin');
    await writeFile(path, 'synthetic');
    const requested = 1700000000123456789n;
    await utimes(path, Number(requested) / 1e9, Number(requested) / 1e9);
    const actual = (await stat(path, { bigint: true })).mtimeNs;
    assert.notEqual(actual, requested);
    t.diagnostic(`requestedNs=${requested}; Node double utimes actualNs=${actual}`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('artifact copy metadata reference rejects caller arguments and stdin', () => {
  const executable = process.platform === 'win32' ? 'python' : 'python3';
  for (const [args, input] of [[['--path', 'synthetic'], ''], [[], 'synthetic']]) {
    const run = spawnSync(executable, ['-I', driver, ...args], { input, encoding: 'utf8', timeout: 3000 });
    assert.equal(run.status, 2);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, 'artifact_copy_metadata_input_rejected\n');
  }
});
