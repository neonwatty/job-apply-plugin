import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const driver = fileURLToPath(new URL('../tools/contracts/artifact-copy-order/reference.py', import.meta.url));
const source = new URL('../scripts/smoke/artifacts.py', import.meta.url);
const files = ['.codex-plugin/plugin.json', 'runtime/data.bin', 'scripts/job-apply-attempt.py',
  'scripts/job-apply-store.py', 'scripts/job-apply-task.py', 'scripts/job-apply-workspace.py',
  'skills/answer-memory/SKILL.md', 'skills/job-apply/SKILL.md'];
const ids = ['native-times', 'post-data-times', 'source-stat-error', 'utime-error',
  'source-flags', 'clear-target-flags', 'flags-ENOTSUP', 'flags-EOPNOTSUPP', 'flags-EIO',
  'chmod-notimplemented', 'xattr-existing', 'xattr-new'];
const initialAtime = 1600000000123456789n;
const initialMtime = 1700000000987654321n;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const contentHash = (label, path) => hash(Buffer.concat([Buffer.from(`${label}:${path}`), Buffer.from([0, 255])]));
const keys = (object, expected) => assert.deepEqual(Object.keys(object).sort(), [...expected].sort());
const rowKeys = ['path', 'atimeNs', 'mtimeNs', 'mode', 'flags', 'size'];

function checkMetadata(rows, missing = false) {
  assert.deepEqual(rows.map(row => row.path), files);
  for (const row of rows) {
    if (missing && row.path === 'runtime/data.bin') {
      assert.deepEqual(row, { path: row.path, missing: true });
      continue;
    }
    keys(row, rowKeys);
    assert.match(row.atimeNs, /^-?\d+$/);
    assert.match(row.mtimeNs, /^-?\d+$/);
    assert.ok(Number.isSafeInteger(row.mode));
    assert.ok(row.flags === null || Number.isSafeInteger(row.flags));
    assert.ok(Number.isSafeInteger(row.size) && row.size > 0);
  }
}

function expectedPaths(missing) {
  const result = new Set();
  for (const prefix of ['source', 'target']) {
    for (const path of [...files, 'skills', 'runtime', 'scripts/job_apply_store', 'scripts/job_apply_workspace', 'workspace']) {
      if (missing && prefix === 'target' && path === 'runtime/data.bin') continue;
      const parts = `${prefix}/${path}`.split('/');
      for (let length = 1; length <= parts.length; length++) result.add(parts.slice(0, length).join('/'));
    }
  }
  return [...result].sort();
}

function checkCase(row, profile) {
  const id = row.id;
  keys(row, ['id', 'status', 'injected', 'events', 'outcome', 'before', 'after', 'hashes',
    'attributesBefore', 'attributesAfter', 'pathsBefore', 'pathsAfter']);
  assert.equal(row.status, 'observed');
  assert.equal(row.injected, ['post-data-times', 'source-stat-error', 'utime-error',
    'flags-ENOTSUP', 'flags-EOPNOTSUPP', 'flags-EIO', 'chmod-notimplemented'].includes(id));
  const failed = ['source-stat-error', 'utime-error', 'flags-EIO'].includes(id);
  assert.deepEqual(row.outcome, failed ? { kind: 'error', name: 'OSError', errno: constants.errno.EIO }
    : { kind: 'value', value: null });
  for (const phase of ['before', 'after']) {
    keys(row[phase], ['source', 'target']);
    for (const tree of ['source', 'target']) checkMetadata(row[phase][tree],
      phase === 'before' && tree === 'target' && id === 'xattr-new');
  }
  assert.deepEqual(row.pathsBefore, expectedPaths(id === 'xattr-new'));
  assert.deepEqual(row.pathsAfter, expectedPaths(false));
  keys(row.hashes, ['source', 'target']);
  for (const tree of ['source', 'target']) keys(row.hashes[tree], files);
  for (const [index, path] of files.entries()) {
    const beforeSource = row.before.source[index];
    const beforeTarget = row.before.target[index];
    const afterSource = row.after.source[index];
    const afterTarget = row.after.target[index];
    assert.equal(beforeSource.atimeNs, String(initialAtime));
    assert.equal(beforeSource.mtimeNs, String(initialMtime));
    assert.equal(beforeSource.mode, 0o640);
    assert.equal(beforeSource.flags, profile.flagsAPI ? ((id === 'source-flags' || id.startsWith('flags-')) && index === 1 ? profile.nodump : 0) : null);
    if (!beforeTarget.missing) {
      assert.equal(beforeTarget.atimeNs, String(initialAtime - 1000000000n));
      assert.equal(beforeTarget.mtimeNs, String(initialMtime - 1000000000n));
      assert.equal(beforeTarget.mode, 0o600);
      assert.equal(beforeTarget.flags, profile.flagsAPI ? (id === 'clear-target-flags' && index === 1 ? profile.nodump : 0) : null);
    }
    assert.equal(row.hashes.source[path], contentHash('source', path));
    assert.equal(row.hashes.target[path], contentHash(failed && index > 1 ? 'target' : 'source', path));
    assert.equal(afterSource.mode, beforeSource.mode);
    assert.equal(afterSource.flags, beforeSource.flags);
    assert.equal(afterSource.mtimeNs, id === 'post-data-times' && index === 1 ? '1750000000222222222' : beforeSource.mtimeNs);
    if (failed && index > 1) {
      assert.deepEqual(afterTarget, beforeTarget, 'later files untouched after failure');
      assert.deepEqual(afterSource, beforeSource, 'later sources not read');
    } else if (index !== 1 || !['source-stat-error', 'utime-error'].includes(id)) {
      assert.equal(afterTarget.atimeNs, afterSource.atimeNs);
      assert.equal(afterTarget.mtimeNs, afterSource.mtimeNs);
      assert.equal(afterTarget.mode, index === 1 && id === 'chmod-notimplemented' ? 0o600 : 0o640);
      assert.equal(afterTarget.flags, index === 1 && id.startsWith('flags-') ? 0 : afterSource.flags);
    } else {
      assert.equal(afterTarget.mode, 0o600);
      assert.equal(afterTarget.flags, beforeTarget.flags);
      assert.notEqual(afterTarget.mtimeNs, beforeTarget.mtimeNs);
      assert.notEqual(afterTarget.mtimeNs, beforeSource.mtimeNs);
    }
  }
  const copies = (failed ? files.slice(0, 2) : files).map(path => ({ op: 'copy', path }));
  const focused = [];
  if (id === 'source-stat-error') focused.push({ op: 'stat-error' });
  else {
    const statEvent = row.events[2];
    keys(statEvent, ['op', ...rowKeys.filter(key => key !== 'path')]);
    assert.equal(statEvent.op, 'stat');
    assert.deepEqual(statEvent, { op: 'stat', ...Object.fromEntries(
      Object.entries(row.after.source[1]).filter(([key]) => key !== 'path')) });
    if (id === 'post-data-times') {
      assert.equal(statEvent.atimeNs, '1500000000111111111');
      assert.equal(statEvent.mtimeNs, '1750000000222222222');
    }
    focused.push(statEvent, { op: 'utime', atimeNs: statEvent.atimeNs, mtimeNs: statEvent.mtimeNs, follow: true });
    if (id !== 'utime-error') {
      focused.push({ op: 'xattrs', follow: true }, { op: 'chmod', mode: 0o640, follow: true });
      if (profile.flagsAPI) focused.push({ op: 'chflags', flags: statEvent.flags, follow: true });
    }
  }
  assert.deepEqual(row.events, [...copies.slice(0, 2), ...focused, ...copies.slice(2)]);
  if (id.startsWith('xattr-')) {
    assert.deepEqual(row.attributesBefore, { source: '736f7572636500ff', target: id === 'xattr-new' ? null : '74617267657400fe' });
    assert.deepEqual(row.attributesAfter, { source: '736f7572636500ff', target: profile.pythonXattrAPI
      ? '736f7572636500ff' : id === 'xattr-new' ? null : '74617267657400fe' });
  } else {
    assert.equal(row.attributesBefore, null);
    assert.equal(row.attributesAfter, null);
  }
}

for (const executable of ['python3', 'python3.12', 'python3.13', 'python3.14']) {
  test(`artifact copy ordering reference: ${executable}`, t => {
    if (process.platform === 'win32') return t.skip('Native Windows copy ordering is unobserved');
    const run = spawnSync(executable, ['-I', driver], { encoding: 'utf8', input: '', timeout: 20000, maxBuffer: 2 ** 20 });
    if (run.error?.code === 'ENOENT' && executable !== 'python3') return t.skip('Interpreter executable alias unavailable');
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    const receipt = JSON.parse(run.stdout);
    keys(receipt, ['schemaVersion', 'profile', 'sourceSha256', 'shutilSha256', 'cases']);
    assert.equal(receipt.schemaVersion, 1);
    const profile = receipt.profile;
    keys(profile, ['implementation', 'python', 'platform', 'xattrBackend', 'pythonXattrAPI', 'flagsAPI', 'nodump']);
    assert.equal(profile.implementation, 'CPython');
    assert.equal(profile.platform, process.platform);
    assert.match(profile.python, /^3\.(12|13|14)\.\d+$/);
    if (executable !== 'python3') assert.ok(profile.python.startsWith(`${executable.slice(6)}.`));
    assert.equal(typeof profile.pythonXattrAPI, 'boolean');
    assert.equal(typeof profile.flagsAPI, 'boolean');
    assert.ok(profile.nodump === null || Number.isSafeInteger(profile.nodump) && profile.nodump > 0);
    assert.ok([null, 'python-os', 'macos-xattr-tool'].includes(profile.xattrBackend));
    if (profile.xattrBackend === 'macos-xattr-tool') assert.equal(process.platform, 'darwin');
    assert.equal(receipt.sourceSha256, hash(readFileSync(source)));
    const library = spawnSync(executable, ['-I', '-c',
      'import hashlib,pathlib,shutil;print(hashlib.sha256(pathlib.Path(shutil.__file__).read_bytes()).hexdigest())'],
    { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 });
    assert.ifError(library.error);
    assert.equal(library.status, 0, library.stderr);
    assert.equal(receipt.shutilSha256, library.stdout.trim());
    assert.deepEqual(receipt.cases.map(row => row.id), ids);
    let unavailable = 0;
    for (const row of receipt.cases) {
      if (row.status === 'unavailable') {
        keys(row, row.errno === undefined ? ['id', 'status', 'reason'] : ['id', 'status', 'reason', 'errno']);
        assert.ok(row.id.includes('flags') || row.id.startsWith('xattr-'));
        assert.ok(['native flags API absent', 'native xattr backend absent', 'native metadata unsupported'].includes(row.reason));
        if (row.errno !== undefined) assert.ok([constants.errno.ENOTSUP, constants.errno.EOPNOTSUPP].includes(row.errno));
        unavailable++;
      } else checkCase(row, profile);
    }
    t.diagnostic(`${profile.python}: ${ids.length - unavailable} observed, ${unavailable} unavailable; default duplicate version adds no independent profile`);
    if (unavailable) t.skip('Partial native capability evidence');
  });
}

test('artifact copy ordering reference rejects external arguments and input', () => {
  for (const [args, input] of [[['--path', 'synthetic'], ''], [[], 'synthetic']]) {
    const run = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', driver, ...args],
      { encoding: 'utf8', input, timeout: 3000, maxBuffer: 4096 });
    assert.ifError(run.error);
    assert.equal(run.status, 2);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, 'artifact_copy_order_input_rejected\n');
  }
});
