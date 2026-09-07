import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const driver = fileURLToPath(new URL('../tools/contracts/atomic-write-json/reference.py', import.meta.url));
const source = new URL('../scripts/job_apply_store/io.py', import.meta.url);
const ids = ['basic', 'missing-parent', 'numbers', 'unicode', 'surrogate', 'unsupported', 'cycle',
  'symlink', 'broken-symlink', 'directory', 'mkdir', 'parent-chmod', 'temp-create', 'partial-write',
  'flush', 'file-fsync', 'temp-close', 'temp-chmod', 'replace', 'destination-chmod', 'directory-open',
  'directory-fsync', 'directory-close', 'replace-cleanup', 'replace-cleanup-missing', 'write-close',
  'write-cleanup', 'list', 'null', 'mixed-keys', 'integer-limit', 'parent-symlink',
  'directory-open-value', 'directory-fsync-value'];
const stages = ['mkdir', 'parent-chmod', 'temp-create', 'write', 'flush', 'file-fsync',
  'temp-close', 'temp-chmod', 'replace', 'destination-chmod', 'directory-open', 'directory-fsync', 'directory-close'];
const special = new Set(['numbers', 'unicode', 'surrogate', 'unsupported', 'cycle', 'list', 'null', 'mixed-keys', 'integer-limit']);
const plainErrors = { surrogate: 'UnicodeEncodeError', unsupported: 'TypeError', cycle: 'ValueError',
  directory: 'IsADirectoryError', 'mixed-keys': 'TypeError', 'integer-limit': 'ValueError',
  'directory-open-value': 'ValueError', 'directory-fsync-value': 'ValueError' };
const pairs = { 'replace-cleanup': ['replace', 'cleanup'], 'replace-cleanup-missing': ['replace', 'cleanup-missing'],
  'write-close': ['partial-write', 'temp-close'], 'write-cleanup': ['partial-write', 'cleanup'] };
const success = new Set(['basic', 'missing-parent', 'numbers', 'unicode', 'symlink', 'broken-symlink',
  'directory-open', 'directory-fsync', 'list', 'null', 'parent-symlink']);
const installed = new Set([...success, 'destination-chmod', 'directory-close', 'directory-open-value', 'directory-fsync-value']);
const content = {
  basic: '{\n  "emoji": "λ",\n  "z": 1\n}\n',
  numbers: `{\n  "big": 1${'0'.repeat(79)}1,\n  "float": 1.0,\n  "infinity": Infinity,\n  "nan": NaN,\n  "negativeZero": -0.0,\n  "tiny": 5e-324\n}\n`,
  unicode: '{\n  "a": "λ\\n\\t\u007f",\n  "empty": [\n    {},\n    []\n  ],\n  "\ue000": "private",\n  "😀": "astral"\n}\n',
  list: '[\n  1,\n  null,\n  {}\n]\n', null: 'null\n',
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const keys = (value, names) => assert.deepEqual(Object.keys(value).sort(), [...names].sort());

function expectedEvents(id) {
  if (id === 'missing-parent') return ['mkdir', 'mkdir', ...stages];
  if (['surrogate', 'unsupported', 'cycle', 'mixed-keys', 'integer-limit'].includes(id)) {
    return [...stages.slice(0, 4), 'temp-close', 'cleanup'];
  }
  if (['partial-write', 'write-close', 'write-cleanup'].includes(id)) {
    return [...stages.slice(0, 3), 'partial-write', 'temp-close', 'cleanup'];
  }
  if (id === 'directory' || id.startsWith('replace-')) return [...stages.slice(0, 9), 'cleanup'];
  if (id === 'directory-open-value' || id === 'directory-open') return stages.slice(0, 11);
  if (id === 'directory-fsync-value') return stages;
  if (stages.includes(id) && !['directory-fsync', 'directory-close'].includes(id)) {
    const end = stages.indexOf(id);
    const trace = stages.slice(0, end + 1);
    if (end >= 3 && end < 6) trace.push('temp-close');
    if (end >= 3 && end < 9) trace.push('cleanup');
    return trace;
  }
  return stages;
}

function checkSnapshot(rows) {
  assert.ok(rows.length >= 2);
  const paths = rows.map(row => row.path);
  assert.deepEqual(paths, [...new Set(paths)].sort());
  assert.equal(rows[0].path, '.');
  for (const row of rows) {
    keys(row, ['path', 'kind', 'mode', 'mtimeNs', 'hex', 'sha256', 'target']);
    assert.ok(['file', 'directory', 'symlink'].includes(row.kind));
    assert.ok(Number.isInteger(row.mode) && row.mode >= 0 && row.mode <= 0o7777);
    assert.match(row.mtimeNs, /^-?\d+$/);
    if (row.kind === 'file') {
      assert.match(row.hex, /^(?:[a-f0-9]{2})*$/);
      assert.equal(row.sha256, hash(Buffer.from(row.hex, 'hex')));
      assert.equal(row.target, null);
    } else {
      assert.equal(row.hex, null);
      assert.equal(row.sha256, null);
      assert.equal(row.target === null, row.kind === 'directory');
    }
  }
}

function checkCase(row, profile) {
  keys(row, ['id', 'target', 'payload', 'faults', 'outcome', 'events', 'calls', 'writeCalls',
    'tempClosed', 'directoryClosed', 'before', 'after']);
  const id = row.id;
  assert.equal(row.target, id === 'missing-parent' ? 'private/nested/deep/document.json' : 'private/document.json');
  assert.equal(row.payload, special.has(id) ? id : 'basic');
  const simpleFault = stages.includes(id) && id !== 'write' || ['partial-write', 'directory-open-value', 'directory-fsync-value'].includes(id);
  assert.deepEqual(row.faults, pairs[id] ?? (simpleFault ? [id] : []));
  assert.deepEqual(row.events, expectedEvents(id), id);
  const parentPath = row.target.slice(0, row.target.lastIndexOf('/'));
  let mkdirCount = 0;
  assert.deepEqual(row.calls, row.events.map(stage => {
    let args = {};
    if (stage === 'mkdir') {
      mkdirCount += 1;
      args = { path: id === 'missing-parent' && mkdirCount === 2 ? 'private/nested' : parentPath,
        mode: id === 'missing-parent' && mkdirCount === 2 ? 0o777 : 0o700,
        parents: mkdirCount !== 3, existOk: true };
    } else if (stage.endsWith('-chmod')) {
      args = { path: stage === 'parent-chmod' ? parentPath : stage === 'temp-chmod' ? `${parentPath}/<temp>` : row.target,
        mode: stage === 'parent-chmod' ? 0o700 : 0o600 };
    } else if (stage === 'temp-create') {
      args = { positionalCount: 0, kwargs: { mode: 'w', encoding: 'utf-8', dir: parentPath,
        prefix: '.document.json.', suffix: '.tmp', delete: false } };
    } else if (stage === 'replace') args = { source: `${parentPath}/<temp>`, destination: row.target };
    else if (stage === 'cleanup') args = { path: `${parentPath}/<temp>` };
    else if (stage === 'directory-open') args = { path: parentPath, flags: 0 };
    else if (stage === 'file-fsync') args = { descriptor: 'temporary' };
    else if (stage === 'directory-fsync' || stage === 'directory-close') args = { descriptor: 'directory' };
    return { stage, arguments: args };
  }));
  if (success.has(id)) assert.deepEqual(row.outcome, { kind: 'value' });
  else {
    let stage = plainErrors[id] ? null : id;
    let context = null;
    if (pairs[id]) {
      stage = id === 'replace-cleanup-missing' ? 'replace' : pairs[id][1];
      if (id !== 'replace-cleanup-missing') context = { name: 'InjectedFailure', stage: pairs[id][0] };
    }
    assert.deepEqual(row.outcome, { kind: 'error', name: plainErrors[id] ?? 'InjectedFailure',
      errno: id === 'directory' ? 21 : stage === null ? null : 5, stage, context });
  }
  assert.equal(row.tempClosed, ['mkdir', 'parent-chmod', 'temp-create'].includes(id) ? null : true);
  assert.equal(row.directoryClosed, row.events.includes('directory-close') ? true : null);
  const counts = { numbers: 28, unicode: 25, surrogate: 5, unsupported: 4, cycle: 4,
    'mixed-keys': profile.startsWith('3.12.') ? 2 : 1, 'integer-limit': 4, list: 7, null: 2 };
  const count = ['mkdir', 'parent-chmod', 'temp-create'].includes(id) ? 0
    : ['partial-write', 'write-close', 'write-cleanup'].includes(id) ? 1 : counts[id] ?? 12;
  assert.equal(row.writeCalls, count, id);
  checkSnapshot(row.before);
  checkSnapshot(row.after);
  assert.ok(row.before.every(item => item.mtimeNs === '1600000000000000000'));
  const target = id === 'parent-symlink' ? 'real/document.json' : row.target;
  const before = row.before.find(item => item.path === target);
  const after = row.after.find(item => item.path === target);
  const expectedPaths = id === 'missing-parent' ? ['.', 'private']
    : id === 'parent-symlink' ? ['.', 'private', 'real', 'real/document.json']
      : id === 'symlink' ? ['.', 'private', target, 'private/foreign.json'] : ['.', 'private', target];
  assert.deepEqual(row.before.map(item => item.path), expectedPaths.sort());
  if (id === 'missing-parent') assert.equal(before, undefined);
  else if (id === 'directory') assert.equal(before.kind, 'directory');
  else if (['symlink', 'broken-symlink'].includes(id)) {
    assert.equal(before.kind, 'symlink');
    assert.equal(before.target, 'foreign.json');
  } else {
    assert.equal(before.kind, 'file');
    assert.equal(before.hex, Buffer.from('old\n').toString('hex'));
    assert.equal(before.mode, 0o644);
  }
  assert.ok(after);
  if (installed.has(id)) {
    assert.equal(after.kind, 'file');
    assert.equal(after.hex, Buffer.from(content[row.payload] ?? content.basic).toString('hex'));
    assert.equal(after.mode, 0o600);
    assert.notEqual(after.mtimeNs, '1600000000000000000');
  } else assert.deepEqual(after, before);
  const temporary = row.after.find(item => item.path.endsWith('/<temp>'));
  const afterPaths = [...expectedPaths];
  if (id === 'missing-parent') afterPaths.push('private/nested', 'private/nested/deep', row.target);
  if (['replace-cleanup', 'write-cleanup'].includes(id)) afterPaths.push('private/<temp>');
  assert.deepEqual(row.after.map(item => item.path), afterPaths.sort());
  if (['replace-cleanup', 'write-cleanup'].includes(id)) {
    assert.ok(temporary);
    assert.equal(temporary.mode, 0o600);
    assert.equal(temporary.hex, Buffer.from(id === 'write-cleanup' ? '{' : content.basic).toString('hex'));
  } else assert.equal(temporary, undefined);
  for (const item of row.before) {
    if (item.path.endsWith('foreign.json') || item.kind === 'symlink' && id === 'parent-symlink') {
      assert.deepEqual(row.after.find(afterItem => afterItem.path === item.path), item);
    }
  }
  const parent = row.after.find(item => item.path === (id === 'parent-symlink' ? 'real' : 'private'));
  assert.equal(parent.mode, ['mkdir', 'parent-chmod', 'missing-parent'].includes(id) ? 0o755 : 0o700);
  assert.deepEqual(row.after[0], row.before[0]);
  if (['mkdir', 'parent-chmod', 'temp-create'].includes(id)) assert.equal(parent.mtimeNs, '1600000000000000000');
  else assert.notEqual(parent.mtimeNs, '1600000000000000000');
  if (id === 'missing-parent') assert.equal(row.after.find(item => item.path === 'private/nested/deep').mode, 0o700);
}

for (const executable of ['python3', 'python3.12', 'python3.13', 'python3.14']) {
  test(`atomic JSON reference: ${executable}`, (t) => {
    if (process.platform === 'win32') return t.skip('Native Windows atomic IO reference remains open');
    const run = spawnSync(executable, ['-I', driver], { input: '', encoding: 'utf8', timeout: 15000, maxBuffer: 2 ** 20 });
    if (run.error?.code === 'ENOENT' && executable !== 'python3') return t.skip('Interpreter alias unavailable; profile not observed');
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    const receipt = JSON.parse(run.stdout);
    keys(receipt, ['schemaVersion', 'profile', 'sourceSha256', 'cases']);
    assert.equal(receipt.schemaVersion, 1);
    keys(receipt.profile, ['python', 'implementation', 'platform', 'osName', 'intMaxStrDigits']);
    assert.equal(receipt.profile.implementation, 'CPython');
    assert.equal(receipt.profile.platform, process.platform);
    assert.equal(receipt.profile.osName, 'posix');
    assert.equal(receipt.profile.intMaxStrDigits, 4300);
    assert.match(receipt.profile.python, /^3\.(12|13|14)\.\d+$/);
    if (executable !== 'python3') assert.ok(receipt.profile.python.startsWith(executable.slice(6) + '.'));
    assert.equal(receipt.sourceSha256, hash(readFileSync(source)));
    assert.deepEqual(receipt.cases.map(row => row.id), ids);
    for (const row of receipt.cases) checkCase(row, receipt.profile.python);
    t.diagnostic(`${receipt.profile.python}: ${ids.length} owned-file cases; injected boundaries are synthetic`);
  });
}

test('atomic JSON reference rejects caller paths, arguments and stdin', () => {
  for (const [args, input] of [[['synthetic'], ''], [[], 'synthetic']]) {
    const run = spawnSync('python3', ['-I', driver, ...args], { input, encoding: 'utf8', timeout: 3000 });
    assert.equal(run.status, 2);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, 'atomic_write_json_reference_input_rejected\n');
  }
});
