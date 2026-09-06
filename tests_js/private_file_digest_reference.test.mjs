import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const reference = fileURLToPath(new URL('../tools/contracts/private-file-digest/reference.py', import.meta.url));
const primary = process.platform === 'win32' ? 'python' : 'python3';
const chunkSize = 1024 * 1024;
const maximum = 10 * chunkSize;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ids = ['empty', 'binary', 'multichunk', 'exact-max', 'max-plus-one', 'missing',
  'missing-parent', 'directory', 'symlink', 'broken-link', 'open-error', 'fstat-error',
  'read-error', 'close-error', 'swap-symlink', 'grow-after-stat'];
const sizes = { empty: 0, multichunk: chunkSize + 17, 'exact-max': maximum, 'max-plus-one': maximum + 1 };
const standard = Buffer.from('73796e74686574696300ff0d0a6279746573', 'hex');
const successIds = new Set(['empty', 'binary', 'multichunk', 'exact-max', 'grow-after-stat']);

function keys(record, names) {
  assert.deepEqual(Object.keys(record).sort(), names.sort());
}

function expectedEvents(id, flags, size, osName) {
  if (id === 'symlink' || id === 'broken-link') return [];
  const events = [{ op: 'open', flags }];
  if (['missing', 'missing-parent', 'open-error', 'swap-symlink'].includes(id)) return events;
  // Windows cannot open directories through os.open; native execution must
  // substantiate this platform branch before any Windows acceptance claim.
  if (id === 'directory' && osName === 'nt') return events;
  events.push({ op: 'fstat' });
  if (!['directory', 'max-plus-one', 'fstat-error'].includes(id)) {
    const reads = id === 'read-error' ? 1 : Math.ceil(size / chunkSize) + 1;
    for (let index = 0; index < reads; index += 1) events.push({ op: 'read', requested: chunkSize });
  }
  events.push({ op: 'close' });
  return events;
}

for (const executable of [primary, 'python3.12', 'python3.13', 'python3.14']) {
  test(`private digest descriptor contract: ${executable}`, (t) => {
    const run = spawnSync(executable, ['-I', reference], {
      input: '', encoding: 'utf8', timeout: 15000, maxBuffer: 256 * 1024,
    });
    if (run.error?.code === 'ENOENT' && executable !== primary) {
      t.skip('Interpreter alias unavailable; no profile acceptance');
      return;
    }
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    const receipt = JSON.parse(run.stdout);
    keys(receipt, ['schemaVersion', 'provenance', 'cases']);
    assert.equal(receipt.schemaVersion, 1);
    const provenance = receipt.provenance;
    keys(provenance, ['implementation', 'python', 'platform', 'osName', 'maximumBytes', 'noFollow', 'readOnly', 'binary', 'sourceSha256']);
    assert.equal(provenance.implementation, 'CPython');
    assert.match(provenance.python, /^3\.\d+\.\d+$/);
    if (executable !== primary) assert.equal(provenance.python.split('.').slice(0, 2).join('.'), executable.slice(6));
    assert.equal(provenance.maximumBytes, maximum);
    assert.equal(provenance.sourceSha256, hash(readFileSync(new URL('../scripts/job_apply_store/domains/resumes/storage.py', import.meta.url))));
    const constants = readFileSync(new URL('../scripts/job_apply_store/constants.py', import.meta.url), 'utf8');
    assert.match(constants, /^RESUME_MAX_BYTES = 10 \* 1024 \* 1024$/m);
    const flags = provenance.readOnly | provenance.binary | (provenance.noFollow ?? 0);
    assert.deepEqual(receipt.cases.map((item) => item.id), ids);
    let unavailable = 0;
    for (const item of receipt.cases) {
      const native = ['symlink', 'broken-link', 'swap-symlink'].includes(item.id);
      assert.equal(item.native, native);
      if (item.status === 'unavailable') {
        keys(item, ['id', 'status', 'native', 'reason']);
        assert.equal(native, true);
        assert.match(item.reason, /^(O_NOFOLLOW unavailable|OSError|PermissionError|NotImplementedError)$/);
        unavailable += 1;
        t.diagnostic(`${item.id}: ${item.reason}; native cell unavailable, not passed`);
        continue;
      }
      keys(item, ['id', 'status', 'native', 'inputSize', 'inputSha256', 'outcome', 'events',
        'readBytes', 'openedCount', 'closedCount', 'leakedCount', 'racePerformed', 'openErrno', 'before', 'after', 'unchanged']);
      assert.equal(item.status, 'observed');
      const data = Object.hasOwn(sizes, item.id) ? Buffer.alloc(sizes[item.id], 'x') : standard;
      const readData = item.id === 'grow-after-stat'
        ? Buffer.concat([data, Buffer.alloc(maximum + 1, 'x')]) : data;
      const absent = ['missing', 'missing-parent', 'directory', 'broken-link'].includes(item.id);
      assert.equal(item.inputSize, absent ? null : data.length);
      assert.equal(item.inputSha256, absent ? null : hash(data));
      const expected = item.id === 'close-error'
        ? { kind: 'error', name: 'OSError', message: 'synthetic close failure' }
        : { kind: 'return', digest: successIds.has(item.id) ? hash(readData) : null };
      assert.deepEqual(item.outcome, expected, item.id);
      assert.deepEqual(item.events, expectedEvents(item.id, flags, readData.length, provenance.osName), item.id);
      const closes = item.events.filter((event) => event.op === 'close').length;
      assert.equal(item.openedCount, closes);
      assert.equal(item.closedCount, closes);
      assert.equal(item.leakedCount, 0);
      assert.equal(item.readBytes, successIds.has(item.id) || item.id === 'close-error' ? readData.length : 0);
      if (item.id === 'grow-after-stat') {
        assert.equal(item.racePerformed, true);
        assert.equal(item.unchanged, false);
        assert.ok(item.readBytes > maximum);
        const original = item.before.find((entry) => entry.path === 'input.bin');
        const grown = item.after.find((entry) => entry.path === 'input.bin');
        assert.equal(original.sha256, hash(data));
        assert.equal(grown.sha256, hash(readData));
        assert.equal(grown.mode, original.mode);
        assert.equal(grown.kind, 'file');
        assert.deepEqual(item.after.map((entry) => entry.path), item.before.map((entry) => entry.path));
      } else if (item.id === 'swap-symlink') {
        assert.notEqual(provenance.noFollow, null);
        assert.equal(item.racePerformed, true);
        assert.equal(item.unchanged, false);
        assert.ok(Number.isInteger(item.openErrno));
        const beforeForeign = item.before.find((entry) => entry.path === 'foreign.bin');
        assert.equal(beforeForeign.sha256, hash(Buffer.from('synthetic foreign bytes')));
        assert.deepEqual(item.after.find((entry) => entry.path === 'foreign.bin'), beforeForeign);
        const replaced = item.after.find((entry) => entry.path === 'input.bin');
        assert.equal(replaced.kind, 'symlink');
        assert.equal(replaced.target, 'foreign.bin');
      } else {
        assert.equal(item.racePerformed, false);
        assert.equal(item.unchanged, true);
        assert.deepEqual(item.after, item.before, item.id);
      }
      for (const entry of [...item.before, ...item.after]) {
        keys(entry, ['path', 'kind', 'mode', 'mtimeNs', 'sha256', 'target']);
        assert.ok(!entry.path.startsWith('/') && !entry.path.includes('..'));
        assert.match(entry.mtimeNs, /^\d+$/);
        assert.ok(Number.isSafeInteger(entry.mode));
        if (entry.kind === 'file') assert.match(entry.sha256, /^[0-9a-f]{64}$/);
        else assert.equal(entry.sha256, null);
      }
      if (item.id === 'missing-parent' || item.id === 'missing') assert.deepEqual(item.after.map((entry) => entry.path), ['.']);
    }
    t.diagnostic(`${provenance.python}: ${ids.length - unavailable} observed, ${unavailable} native unavailable; 10MiB initial limit/1MiB chunks`);
  });
}

test('digest reference rejects caller paths and input without echoing values', () => {
  for (const [args, input] of [[['--path', 'private-canary'], ''], [[], 'private-canary']]) {
    const run = spawnSync(primary, ['-I', reference, ...args], { input, encoding: 'utf8', timeout: 15000 });
    assert.equal(run.status, 2);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, 'digest_reference_input_rejected\n');
  }
});
