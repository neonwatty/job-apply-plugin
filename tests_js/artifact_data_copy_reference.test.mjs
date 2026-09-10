import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const reference = fileURLToPath(new URL('../tools/contracts/artifact-data-copy/reference.py', import.meta.url));
const data = Buffer.from('synthetic-source\0\xff\n', 'latin1');
const old = Buffer.from('old-target\0\xfe', 'latin1');
const stamp = '1600000000000000000';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = bytes => ({ size: bytes.length, sha256: hash(bytes), hex: bytes.length <= 64 ? bytes.toString('hex') : null });
const native = ['existing', 'new-022', 'new-077', 'empty', 'multichunk', 'same-path', 'hardlink', 'source-fifo',
  'target-fifo', 'source-missing', 'target-directory', 'source-link', 'target-link'];
const buffered = ['existing', 'multichunk', 'source-open-error', 'target-open-error', 'read-error', 'write-error',
  'partial-read-error', 'partial-write-error', 'short-write', 'source-close-error', 'target-close-error',
  'read-both-close-error', 'write-target-close-error', 'source-close-after-error', 'target-close-after-error'];
const accelerator = ['fallback', 'partial-error'];
const preflight = ['source-fifo', 'source-link', 'target-fifo', 'target-link'];
const ids = [...native.map(id => 'native:' + id), ...buffered.map(id => 'buffered:' + id),
  ...accelerator.map(id => 'accelerator:' + id), ...preflight.map(id => 'preflight:' + id)];
const injected = (stage, context = null) => ({ name: 'InjectedFailure', message: '[Errno 5] synthetic ' + stage, errno: 5, stage, context });
const failure = (name, message, errno = null) => ({ name, message, errno, stage: null, context: null });
function expectedError(lane, id) {
  if (lane === 'native') {
    if (['same-path', 'hardlink'].includes(id)) return failure('SameFileError',
      `PosixPath('<ROOT>/source') and PosixPath('<ROOT>/${id === 'same-path' ? 'source' : 'target'}') are the same file`);
    if (id.endsWith('fifo')) return failure('SpecialFileError', `\`<ROOT>/${id.startsWith('source') ? 'source' : 'target'}\` is a named pipe`);
    if (id === 'source-missing') return failure('FileNotFoundError', "[Errno 2] No such file or directory: '<ROOT>/source'", 2);
    if (id === 'target-directory') return failure('IsADirectoryError', "[Errno 21] Is a directory: '<ROOT>/target'", 21);
  } else if (lane === 'accelerator') return id === 'partial-error' ? injected('accelerator-after-write') : null;
  else if (lane === 'buffered') {
    if (id === 'read-both-close-error') return injected('source-close', injected('target-close', injected('read')));
    if (id === 'write-target-close-error') return injected('target-close', injected('write'));
    if (id.endsWith('-error')) return injected(id.replace(/^partial-/, '').slice(0, -6));
  }
  return null;
}
function payload(id, size) {
  return id === 'empty' ? Buffer.alloc(0) : ['multichunk', 'partial-read-error', 'partial-write-error'].includes(id)
    ? Buffer.from(Array.from({ length: size * 2 + 17 }, (_, i) => i % 251)) : data;
}
function expectedCalls(lane, id, bytes, size, helper) {
  const calls = [];
  const mark = (stage, args = {}) => calls.push({ stage, ...args });
  if (lane === 'native' && ['same-path', 'hardlink', 'source-fifo', 'target-fifo', 'source-link'].includes(id)) return calls;
  mark('source-open', { path: 'source', mode: 'rb' });
  if (['source-open-error', 'source-missing'].includes(id)) return calls;
  mark('target-open', { path: 'target', mode: 'wb' });
  if (['target-open-error', 'target-directory'].includes(id)) { mark('source-close'); return calls; }
  if (lane === 'native') { mark('target-close'); mark('source-close'); return calls; }
  if (lane === 'accelerator') mark('accelerator', { helper });
  let offset = 0;
  for (let index = 0; ; index += 1) {
    const length = lane === 'accelerator' && id === 'partial-error' ? 7 : size;
    mark('read', { length });
    if (['read-error', 'read-both-close-error'].includes(id) || id === 'partial-read-error' && index === 1) break;
    const part = bytes.subarray(offset, offset + length);
    mark('read-result', digest(part));
    if (!part.length) break;
    mark('write', digest(part));
    if (['write-error', 'write-target-close-error'].includes(id) || id === 'partial-write-error' && index === 1
      || lane === 'accelerator' && id === 'partial-error') break;
    offset += length;
  }
  if (lane === 'accelerator' && id === 'partial-error') mark('accelerator-mutation', { target: digest(bytes.subarray(0, 7)) });
  mark('target-close'); mark('source-close'); return calls;
}
function unchanged(row) {
  return row.map(({ atimeNs, ...rest }) => rest);
}
function checkPreflight(row) {
  const id = row.id.slice(10);
  const messages = {
    'source-fifo': 'critical package artifact is not a regular file: runtime/z.bin',
    'source-link': 'critical package tree contains a symlink: runtime/z.bin',
    'target-fifo': 'critical package destination is not a regular file: runtime/z.bin',
    'target-link': 'critical package path contains a symlink: runtime/z.bin',
  };
  assert.deepEqual(row.error, failure('SystemExit', messages[id])); assert.deepEqual(row.calls, []);
  assert.deepEqual(unchanged(row.before), unchanged(row.after));
  const fixed = ['.codex-plugin/plugin.json', 'scripts/job-apply-store.py', 'scripts/job-apply-task.py',
    'scripts/job-apply-attempt.py', 'scripts/job-apply-workspace.py', 'skills/answer-memory/SKILL.md', 'skills/job-apply/SKILL.md'];
  const expectedPaths = new Set(['.']);
  for (const base of ['source', 'target']) {
    expectedPaths.add(base);
    for (const path of [...fixed, 'skills', 'runtime/z.bin', 'scripts/job_apply_store', 'scripts/job_apply_workspace', 'workspace']) {
      const parts = `${base}/${path}`.split('/');
      for (let i = 1; i <= parts.length; i += 1) expectedPaths.add(parts.slice(0, i).join('/'));
    }
  }
  assert.deepEqual(row.before.map(item => item.path).sort(), [...expectedPaths].sort());
  for (const item of row.before) {
    const relative = item.path.split('/').slice(1).join('/');
    if (item.path === `${id.startsWith('source') ? 'source' : 'target'}/runtime/z.bin`) {
      assert.equal(item.kind, id.endsWith('fifo') ? 'fifo' : 'link');
      assert.equal(item.target, id.endsWith('fifo') ? null : '../scripts/job-apply-store.py');
    } else if (fixed.includes(relative) || relative === 'runtime/z.bin') {
      assert.equal(item.kind, 'file');
      const [base, ...parts] = item.path.split('/');
      assert.deepEqual(item.content, digest(Buffer.from(parts.join('/') === 'runtime/z.bin' ? base : `${base}:${parts.join('/')}`)));
    } else { assert.equal(item.kind, 'directory'); assert.equal(item.content, null); assert.equal(item.target, null); }
  }
}
function checkCopy(row, profile) {
  const [lane, id] = row.id.split(':');
  assert.equal(row.evidence, lane === 'native' ? 'native' : 'controlled-' + lane);
  assert.equal(row.bufferSize, profile.bufferSize); assert.equal(row.accelerator, profile.accelerator);
  assert.equal(row.umask, id === 'new-077' ? 0o077 : 0o022);
  const bytes = payload(id, profile.bufferSize);
  assert.deepEqual(row.sourceInput, digest(bytes)); assert.deepEqual(row.targetInput, digest(old));
  assert.deepEqual(row.error, expectedError(lane, id)); assert.equal(row.value, row.error ? null : 'target');
  const calls = expectedCalls(lane, id, bytes, profile.bufferSize, profile.accelerator);
  // Native acceleration can legitimately give up and use the real buffered loop.
  if (lane === 'native' && row.calls.some(call => call.stage === 'read')) {
    assert.deepEqual(row.calls, expectedCalls('buffered', id, bytes, profile.bufferSize, null));
  } else assert.deepEqual(row.calls, calls);
  const before = Object.fromEntries(row.before.map(item => [item.path, item]));
  const after = Object.fromEntries(row.after.map(item => [item.path, item]));
  const paths = ['.', ...(id === 'source-missing' ? [] : ['source']), ...(id.startsWith('new-') || id === 'source-link' ? [] : ['target']),
    ...(['source-link', 'target-link'].includes(id) ? ['referent'] : [])].sort();
  assert.deepEqual(Object.keys(before).sort(), paths);
  assert.deepEqual(Object.keys(after).sort(), [...new Set([...paths, 'target'])].sort());
  for (const item of row.before) {
    const expectedKind = item.path === '.' ? 'directory' : item.path === 'source'
      ? id === 'source-fifo' ? 'fifo' : id === 'source-link' ? 'link' : 'file'
      : item.path === 'target' ? id === 'target-fifo' ? 'fifo' : id === 'target-directory' ? 'directory' : id === 'target-link' ? 'link' : 'file' : 'file';
    assert.equal(item.kind, expectedKind); assert.equal(item.mtimeNs, stamp);
    if (item.path === 'referent') assert.deepEqual(item.content, digest(id === 'source-link' ? bytes : old));
    if (expectedKind !== 'file') assert.equal(item.content, null);
    assert.equal(item.target, expectedKind === 'link' ? 'referent' : null);
  }
  for (const item of [...row.before, ...row.after]) {
    assert.match(item.atimeNs, /^-?\d+$/); assert.match(item.mtimeNs, /^-?\d+$/); assert.match(item.ctimeNs, /^-?\d+$/);
  }
  if (before.source?.kind === 'file') {
    assert.deepEqual(before.source.content, digest(bytes)); assert.equal(before.source.mode, 0o640);
    assert.deepEqual(unchanged([before.source]), unchanged([after.source]));
  }
  if (before.target?.kind === 'file') {
    assert.deepEqual(before.target.content, digest(id === 'hardlink' ? bytes : old));
    assert.equal(before.target.mode, id === 'hardlink' ? 0o640 : 0o600);
  }
  let output = bytes;
  if (['source-open-error', 'target-open-error', 'source-missing', 'same-path', 'source-fifo'].includes(id)) output = old;
  if (['read-error', 'write-error', 'target-close-error', 'read-both-close-error', 'write-target-close-error'].includes(id)) output = Buffer.alloc(0);
  if (['partial-read-error', 'partial-write-error'].includes(id)) output = bytes.subarray(0, profile.bufferSize);
  if (id === 'short-write') output = bytes.subarray(0, 3);
  if (lane === 'accelerator' && id === 'partial-error') output = bytes.subarray(0, 7);
  if (after.target.kind === 'file') {
    assert.deepEqual(after.target.content, digest(output));
    assert.equal(after.target.mode, id === 'new-022' ? 0o644 : id === 'hardlink' ? 0o640 : 0o600);
  } else if (id === 'target-link') {
    assert.equal(after.target.kind, 'link'); assert.equal(after.target.target, 'referent');
    assert.deepEqual(after.referent.content, digest(bytes)); assert.equal(after.referent.mode, 0o600);
  } else if (id === 'source-link') {
    assert.equal(after.target.kind, 'link'); assert.equal(after.target.target, 'referent');
    assert.deepEqual(unchanged([before.referent]), unchanged([after.referent]));
  } else assert.equal(after.target.kind, id === 'target-fifo' ? 'fifo' : 'directory');
  const opened = row.calls.filter(call => call.stage.endsWith('-open') && row.error?.stage !== call.stage
    && !(id === 'source-missing' && call.stage === 'source-open') && !(id === 'target-directory' && call.stage === 'target-open')).map(call => call.path);
  const leaks = id === 'read-both-close-error' ? ['source', 'target'] : ['source-close-error', 'target-close-error', 'write-target-close-error'].includes(id)
    ? [id.startsWith('source') ? 'source' : 'target'] : [];
  assert.deepEqual(row.descriptors, opened.map(owner => ({ owner, open: leaks.includes(owner),
    size: !leaks.includes(owner) ? null : owner === 'source' ? bytes.length : output.length })));
  const targetMutated = row.calls.some(call => call.stage === 'target-open')
    && !['target-open-error', 'target-directory'].includes(id);
  if (after.target.kind === 'file') assert.equal(after.target.mtimeNs === stamp, !targetMutated);
  for (const path of Object.keys(before)) if (!['target', 'referent', '.'].includes(path)) {
    assert.deepEqual(unchanged([before[path]]), unchanged([after[path]]));
  }
}
for (const executable of ['python3', 'python3.12', 'python3.13', 'python3.14']) {
  test(`actual data-only copy reference ${executable}`, t => {
    if (!['darwin', 'linux'].includes(process.platform)) return t.skip('Native POSIX reference required');
    const run = spawnSync(executable, ['-I', reference], { input: '', encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
    if (run.error?.code === 'ENOENT' && executable !== 'python3') return t.skip('Interpreter alias unavailable');
    assert.ifError(run.error); assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout); assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.profile.platform, process.platform); assert.equal(receipt.profile.osName, 'posix');
    assert.equal(receipt.profile.implementation, 'CPython');
    const version = receipt.profile.python.split('.').slice(0, 2).join('.');
    if (executable !== 'python3') assert.equal(version, executable.slice(6));
    assert.ok(['3.12', '3.13', '3.14'].includes(version));
    assert.equal(receipt.profile.bufferSize, version === '3.14' ? 262144 : 65536);
    assert.equal(receipt.profile.executableSha256, hash(readFileSync(receipt.profile.executable)));
    assert.deepEqual(Object.keys(receipt.sources), ['scripts/smoke/artifacts.py']);
    assert.equal(receipt.sources['scripts/smoke/artifacts.py'], hash(readFileSync(new URL('scripts/smoke/artifacts.py', root))));
    assert.deepEqual(Object.keys(receipt.stdlib), ['shutil']);
    assert.equal(receipt.stdlib.shutil.sha256, hash(readFileSync(receipt.stdlib.shutil.path)));
    assert.deepEqual(receipt.cases.map(row => row.id), ids);
    for (const row of receipt.cases) {
      assert.equal(row.status, 'observed', `${row.id}: required cell unavailable`);
      if (row.id.startsWith('preflight:')) checkPreflight(row); else checkCopy(row, receipt.profile);
    }
    t.diagnostic(`${receipt.profile.python}: ${ids.length} cases, ${receipt.profile.accelerator}, buffer ${receipt.profile.bufferSize}`);
  });
}
test('data-only reference rejects external input', () => {
  for (const [args, input] of [[[reference, 'extra'], ''], [[reference], 'x']]) {
    const run = spawnSync('python3', ['-I', ...args], { input, encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 2); assert.equal(run.stdout, ''); assert.equal(run.stderr, 'artifact_data_copy_input_rejected\n');
  }
});


test('controlled copy_file_range fallback cannot escape through native sendfile', t => {
  if (!['darwin', 'linux'].includes(process.platform)) return t.skip('Native POSIX reference required');
  const script = `import contextlib,io,json,runpy,shutil
from unittest.mock import patch
with contextlib.redirect_stdout(io.StringIO()):
    driver = runpy.run_path(${JSON.stringify(reference)})
def secondary(*args):
    raise AssertionError('controlled lane escaped through secondary accelerator')
with patch.object(shutil, '_HAS_FCOPYFILE', False), \
     patch.object(shutil, '_USE_CP_COPY_FILE_RANGE', True), \
     patch.object(shutil, '_USE_CP_SENDFILE', True), \
     patch.object(shutil, '_fastcopy_sendfile', secondary):
    rows = [driver['capture']('accelerator', case) for case in ['fallback', 'partial-error']]
print(json.dumps({'bufferSize':shutil.COPY_BUFSIZE, 'accelerator':'_fastcopy_copy_file_range', 'cases':rows}))`;
  const run = spawnSync('python3.14', ['-I', '-c', script], { input: '', encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
  if (run.error?.code === 'ENOENT') return t.skip('Interpreter alias unavailable');
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  const receipt = JSON.parse(run.stdout);
  assert.deepEqual(receipt.cases.map(row => row.id), ['accelerator:fallback', 'accelerator:partial-error']);
  for (const row of receipt.cases) checkCopy(row, receipt);
});
