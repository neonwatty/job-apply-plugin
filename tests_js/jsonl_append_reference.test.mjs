import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const reference = fileURLToPath(new URL('../tools/contracts/jsonl-append/reference.py', import.meta.url));
const old = Buffer.from('{"old": true}\n');
const basic = Buffer.from('{"a": "λ", "z": 1}\n');
const partial = Buffer.from('{"partial":');
const fixedTime = '1600000000000000000';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const keys = (value, names) => assert.deepEqual(Object.keys(value).sort(), [...names].sort());
const error = (name, stage = null, context = null, errno = null, message = null) => ({ kind: 'error', name, stage, context, errno, message });
const injected = (stage, context = null) => error('InjectedFailure', stage, context, 5);
const incomplete = () => error('StoreError', null, null, null, 'history append was incomplete');
const success = { kind: 'value' };

// Fixed expectations are derived from the unchanged method's explicit try/finally
// boundaries, not from receipts or any TypeScript append implementation.
const append = {
  normal: ['gate open fstat write fsync close chmod', success, 0],
  'new-file': ['gate open fstat write fsync close chmod', success, 0],
  'missing-parent': ['gate open', error('FileNotFoundError', null, null, 2), 0],
  symlink: ['gate open fstat write fsync close chmod', success, 0],
  'broken-symlink': ['gate open fstat write fsync close chmod', success, 0],
  directory: ['gate open', error('IsADirectoryError', null, null, 21), 0],
  'gate-hit': ['gate', success, 0], 'gate-error': ['gate', injected('gate'), 0],
  unicode: ['gate open fstat write fsync close chmod', success, 0],
  numbers: ['gate open fstat write fsync close chmod', success, 0],
  surrogate: ['gate', error('UnicodeEncodeError'), 0],
  cycle: ['gate', error('ValueError'), 0], 'integer-limit': ['gate', error('ValueError'), 0],
  'open-error': ['gate open', injected('open'), 0],
  'fstat-error': ['gate open fstat', injected('fstat'), 1],
  'short-writes': ['gate open fstat SHORT fsync close chmod', success, 0],
  'write-error': ['gate open fstat write truncate rollback-fsync close', injected('write'), 0],
  'partial-error': ['gate open fstat write write truncate rollback-fsync close', injected('write'), 0],
  'zero-write': ['gate open fstat write truncate rollback-fsync close', incomplete(), 0],
  'negative-write': ['gate open fstat write truncate rollback-fsync close', incomplete(), 0],
  'partial-zero': ['gate open fstat write write truncate rollback-fsync close', incomplete(), 0],
  baseexception: ['gate open fstat write truncate rollback-fsync close', error('KeyboardInterrupt'), 0],
  'fsync-error': ['gate open fstat write fsync truncate rollback-fsync close', injected('fsync'), 0],
  'rollback-truncate-error': ['gate open fstat write write truncate close', injected('truncate', injected('write')), 0],
  'rollback-sync-error': ['gate open fstat write write truncate rollback-fsync close', injected('rollback-fsync', injected('write')), 0],
  'write-close-error': ['gate open fstat write write truncate rollback-fsync close', injected('close', injected('write')), 1],
  'truncate-close-error': ['gate open fstat write write truncate close', injected('close', injected('truncate', injected('write'))), 1],
  'close-error': ['gate open fstat write fsync close', injected('close'), 1],
  'chmod-error': ['gate open fstat write fsync close chmod', injected('chmod'), 0],
};
const repair = {
  idle: ['journal', success, 0], missing: ['journal', success, 0],
  empty: ['journal open fstat read close', success, 0],
  complete: ['journal open fstat read close', success, 0],
  partial: ['journal open fstat read truncate fsync close', success, 0],
  'line-less': ['journal open fstat read truncate fsync close', success, 0],
  'short-read': ['journal open fstat read truncate fsync close', success, 0],
  'open-error': ['journal open', injected('open'), 0],
  'fstat-error': ['journal open fstat close', injected('fstat'), 0],
  'read-error': ['journal open fstat read close', injected('read'), 0],
  'truncate-error': ['journal open fstat read truncate close', injected('truncate'), 0],
  'fsync-error': ['journal open fstat read truncate fsync close', injected('fsync'), 0],
  'close-error': ['journal open fstat read truncate fsync close', injected('close'), 1],
  'read-close-error': ['journal open fstat read close', injected('close', injected('read')), 1],
};

function bytesFor(id) {
  if (id === 'unicode') return Buffer.from('{"a": "λ\\n", "\ue000": "private", "😀": "astral"}\n');
  if (id === 'numbers') return Buffer.from('{"big": 1208925819614629174706176, "float": 1.0, "nan": NaN, "negativeZero": -0.0}\n');
  return basic;
}
function snapshots(rows) {
  assert.deepEqual(rows.map(row => row.path), [...new Set(rows.map(row => row.path))].sort());
  for (const row of rows) {
    keys(row, ['path', 'kind', 'mode', 'mtimeNs', 'hex', 'sha256', 'target']);
    assert.ok(['file', 'directory', 'symlink'].includes(row.kind));
    assert.match(row.mtimeNs, /^-?\d+$/);
    assert.ok(Number.isInteger(row.mode) && row.mode >= 0 && row.mode <= 0o7777);
    if (row.kind === 'file') {
      assert.match(row.hex, /^(?:[a-f0-9]{2})*$/);
      assert.equal(row.sha256, hash(Buffer.from(row.hex, 'hex')));
      assert.equal(row.target, null);
    } else {
      assert.equal(row.hex, null); assert.equal(row.sha256, null);
      assert.equal(row.target, row.kind === 'symlink' ? 'target.jsonl' : null);
    }
  }
}

function checkCase(row) {
  keys(row, ['id', 'operation', 'faults', 'behavior', 'outcome', 'calls', 'openDescriptorsAtReturn', 'before', 'after']);
  const [operation, id] = row.id.split(':');
  assert.equal(row.operation, operation);
  const behavior = operation === 'repair' ? id === 'short-read' ? 'short-read' : ''
    : ({ 'short-writes': 'short', 'partial-error': 'partial-error', 'zero-write': 'zero',
      'negative-write': 'negative', 'partial-zero': 'partial-zero', baseexception: 'baseexception',
      'rollback-truncate-error': 'partial-error', 'rollback-sync-error': 'partial-error',
      'write-close-error': 'partial-error', 'truncate-close-error': 'partial-error' }[id] ?? '');
  assert.equal(row.behavior, behavior);
  const faults = { 'gate-error': ['gate'], 'open-error': ['open'], 'fstat-error': ['fstat'],
    'write-error': ['write'], 'fsync-error': ['fsync'], 'rollback-truncate-error': ['truncate'],
    'rollback-sync-error': ['rollback-fsync'], 'write-close-error': ['close'],
    'truncate-close-error': ['truncate', 'close'], 'close-error': ['close'], 'chmod-error': ['chmod'],
    'read-error': ['read'], 'truncate-error': ['truncate'], 'read-close-error': ['read', 'close'] }[id] ?? [];
  assert.deepEqual(row.faults, faults);
  const [trace, expectedOutcome, leaked] = (operation === 'append' ? append : repair)[id];
  const bytes = bytesFor(id);
  const stages = trace.replace('SHORT', Array(Math.ceil(bytes.length / 5)).fill('write').join(' ')).split(' ');
  assert.deepEqual(row.calls.map(call => call.stage), stages, row.id);
  assert.deepEqual(row.outcome, expectedOutcome, row.id);
  assert.equal(row.openDescriptorsAtReturn, leaked, row.id);
  const short = ['short-writes', 'partial-error', 'partial-zero', 'rollback-truncate-error',
    'rollback-sync-error', 'write-close-error', 'truncate-close-error'].includes(id);
  let writes = 0;
  const initial = operation === 'append' ? old : id === 'empty' ? Buffer.alloc(0)
    : id === 'complete' ? old : id === 'line-less' ? Buffer.from('partial') : Buffer.concat([old, partial]);
  for (const call of row.calls) {
    keys(call, ['stage', 'arguments']);
    let args = {};
    if (call.stage === 'open') args = { flags: operation === 'append' ? constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND : constants.O_RDWR,
      mode: operation === 'append' ? 0o600 : null };
    if (call.stage === 'write') { args = { hex: bytes.subarray(short ? writes * 5 : 0).toString('hex') }; writes += 1; }
    if (call.stage === 'truncate') args = { size: operation === 'append' ? old.length : ['short-read', 'line-less'].includes(id) ? 0 : old.length };
    if (call.stage === 'read') args = { length: initial.length };
    if (call.stage === 'chmod') args = { mode: 0o600 };
    assert.deepEqual(call.arguments, args, `${row.id} ${call.stage}`);
  }
  snapshots(row.before); snapshots(row.after);
  assert.ok(row.before.every(item => item.mtimeNs === fixedTime));
  const absent = ['new-file', 'missing-parent', 'missing'].includes(id);
  const linked = ['symlink', 'broken-symlink'].includes(id);
  const beforePaths = absent ? ['.'] : linked && id === 'symlink' ? ['.', 'history.jsonl', 'target.jsonl'] : ['.', 'history.jsonl'];
  const afterPaths = id === 'new-file' ? ['.', 'history.jsonl'] : id === 'broken-symlink' ? ['.', 'history.jsonl', 'target.jsonl'] : beforePaths;
  assert.deepEqual(row.before.map(item => item.path), beforePaths);
  assert.deepEqual(row.after.map(item => item.path), afterPaths);
  const path = linked ? 'target.jsonl' : 'history.jsonl';
  const before = row.before.find(item => item.path === path);
  const after = row.after.find(item => item.path === path);
  assert.equal(before?.kind, absent || id === 'broken-symlink' ? undefined : id === 'directory' ? 'directory' : 'file');
  assert.equal(after?.kind, ['missing-parent', 'missing'].includes(id) ? undefined : id === 'directory' ? 'directory' : 'file');
  assert.equal(row.before[0].kind, 'directory');
  assert.equal(row.before[0].mode, 0o700);
  if (id === 'directory') assert.deepEqual(after, before);
  if (before?.kind === 'file') { assert.equal(before.mode, 0o644); assert.equal(before.hex, initial.toString('hex')); }
  if (after?.kind === 'file') {
    let expected = initial;
    if (operation === 'append') {
      if (['normal', 'new-file', 'symlink', 'broken-symlink', 'unicode', 'numbers', 'short-writes', 'close-error', 'chmod-error'].includes(id)) {
        expected = Buffer.concat([['new-file', 'broken-symlink'].includes(id) ? Buffer.alloc(0) : old, bytes]);
      } else if (['rollback-truncate-error', 'truncate-close-error'].includes(id)) expected = Buffer.concat([old, bytes.subarray(0, 5)]);
    } else if (['partial', 'fsync-error', 'close-error'].includes(id)) expected = old;
    else if (['line-less', 'short-read'].includes(id)) expected = Buffer.alloc(0);
    assert.equal(after.hex, expected.toString('hex'), row.id);
    const chmodSucceeded = stages.includes('chmod') && id !== 'chmod-error';
    assert.equal(after.mode, operation === 'append' && chmodSucceeded ? 0o600 : 0o644);
    if (!stages.includes('write') && !stages.includes('truncate')) assert.deepEqual(after, before);
    if (after.hex !== before?.hex) assert.notEqual(after.mtimeNs, fixedTime);
    if (stages.includes('truncate') && !faults.includes('truncate')) assert.notEqual(after.mtimeNs, fixedTime);
  }
  if (linked) assert.deepEqual(row.after.find(item => item.path === 'history.jsonl'), row.before.find(item => item.path === 'history.jsonl'));
  if (!['new-file', 'broken-symlink'].includes(id)) assert.deepEqual(row.after[0], row.before[0]);
  else assert.notEqual(row.after[0].mtimeNs, fixedTime);
}

for (const executable of ['python3', 'python3.12', 'python3.13', 'python3.14']) {
  test(`JSONL append and pending tail reference: ${executable}`, t => {
    if (process.platform === 'win32') return t.skip('Native Windows reference remains unverified');
    const run = spawnSync(executable, ['-I', reference], { input: '', encoding: 'utf8', timeout: 10000, maxBuffer: 2 ** 20 });
    if (run.error?.code === 'ENOENT' && executable !== 'python3') return t.skip('Interpreter alias unavailable');
    assert.equal(run.status, 0, run.stderr); assert.equal(run.stderr, '');
    const receipt = JSON.parse(run.stdout);
    keys(receipt, ['schemaVersion', 'profile', 'sources', 'cases']);
    assert.equal(receipt.schemaVersion, 1);
    keys(receipt.profile, ['python', 'implementation', 'platform', 'osName', 'intMaxStrDigits']);
    assert.equal(receipt.profile.implementation, 'CPython');
    assert.equal(receipt.profile.platform, process.platform);
    assert.equal(receipt.profile.osName, 'posix');
    assert.equal(receipt.profile.intMaxStrDigits, 4300);
    assert.match(receipt.profile.python, /^3\.(12|13|14)\.\d+$/);
    if (executable !== 'python3') assert.ok(receipt.profile.python.startsWith(executable.slice(6) + '.'));
    keys(receipt.sources, ['scripts/job_apply_store/domains/coordinator/persistence.py', 'scripts/job_apply_store/io.py', 'scripts/job_apply_store/errors.py']);
    for (const [path, digest] of Object.entries(receipt.sources)) assert.equal(digest, hash(readFileSync(new URL(path, root))));
    assert.deepEqual(receipt.cases.map(row => row.id), [...Object.keys(append).map(id => `append:${id}`), ...Object.keys(repair).map(id => `repair:${id}`)]);
    receipt.cases.forEach(checkCase);
    t.diagnostic(`${receipt.profile.python}: ${receipt.cases.length} synthetic cases; domain gates stubbed explicitly`);
  });
}

test('JSONL reference rejects caller arguments and input', () => {
  const executable = process.platform === 'win32' ? 'python' : 'python3';
  for (const [args, input] of [[['synthetic'], ''], [[], '{}']]) {
    const run = spawnSync(executable, ['-I', reference, ...args], { input, encoding: 'utf8', timeout: 3000 });
    assert.equal(run.status, 2); assert.equal(run.stdout, '');
    assert.equal(run.stderr, 'jsonl_reference_input_rejected\n');
  }
});
