import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const reference = fileURLToPath(new URL('../tools/contracts/store-raw-read/reference.py', import.meta.url));
const primary = process.platform === 'win32' ? 'python' : 'python3';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixed = [
  ['empty-object', '{}', '{}'],
  ['typed-values', '{"a":1,"b":1.0,"c":9007199254740993,"d":NaN,"e":-0.0}', '{"a":1,"b":1.0,"c":9007199254740993,"d":NaN,"e":-0.0}'],
  ['future-schema', '{"schemaVersion":99}', '{"schemaVersion":99}'],
  ['duplicate-key', '{"a":1,"a":2.0}', '{"a":2.0}'],
  ['utf8', '{"text":"é😀"}', '{"text":"\\u00e9\\ud83d\\ude00"}'],
  ['invalid-utf8', Buffer.from('7b2274657874223a22ff227d', 'hex'), 'UnicodeDecodeError'],
  ['truncated-utf8', Buffer.from('7b2274657874223a22e282', 'hex'), 'UnicodeDecodeError'],
  ['bom', '\ufeff{}', 'JSONDecodeError'],
  ['crlf', '{\r\n"a":1\r\n}', '{"a":1}'],
  ['bare-cr', '{\r"a":1\r}', '{"a":1}'],
  ['empty-file', '', 'JSONDecodeError'],
  ['invalid-json', '{"a":}', 'JSONDecodeError'],
  ['array', '[]', 'object-error'],
  ['scalar', '1', 'object-error'],
  ['null', 'null', 'object-error'],
  ['missing-file', null, 'FileNotFoundError'],
  ['missing-parent', null, 'FileNotFoundError'],
  ['directory', null, 'directory-error'],
  ['symlink', '{"linked":true}', '{"linked":true}'],
  ['broken-symlink', null, 'FileNotFoundError'],
  ['parent-symlink', '{"parent":true}', '{"parent":true}'],
  ['integer-digit-limit', '{"a":' + '9'.repeat(4301) + '}', 'digit-error'],
];

function keys(record, names) {
  assert.deepEqual(Object.keys(record).sort(), names.sort());
}

function expectedOutcome(id, expected, osName) {
  if (expected.startsWith('{')) return { kind: 'value', json: expected };
  if (expected === 'object-error') return { kind: 'error', name: 'StoreError',
    message: 'synthetic document must be a JSON object', cause: null };
  if (expected === 'digit-error') return { kind: 'error', name: 'ValueError',
    message: 'Exceeds the limit (4300 digits) for integer string conversion: value has 4301 digits; use sys.set_int_max_str_digits() to increase the limit', cause: null };
  const suffix = id === 'missing-parent' ? 'absent/input.json' : 'input.json';
  // pathlib uses native separators. Only the temporary root is normalized.
  const path = osName === 'nt' ? suffix.replaceAll('/', '\\') : suffix;
  return { kind: 'error', name: 'StoreError',
    message: `cannot read valid synthetic document JSON at <fixture>${osName === 'nt' ? '\\' : '/'}${path}`,
    cause: expected === 'directory-error' ? (osName === 'nt' ? 'PermissionError' : 'IsADirectoryError') : expected };
}

for (const executable of [primary, 'python3.12', 'python3.13', 'python3.14']) {
  test(`raw document reads preserve exact data/errors/files: ${executable}`, (t) => {
    const run = spawnSync(executable, ['-I', reference], {
      input: '', encoding: 'utf8', timeout: 10000, maxBuffer: 256 * 1024,
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
    keys(receipt.provenance, ['implementation', 'python', 'unicode', 'platform', 'osName', 'intMaxStrDigits', 'recursionLimit', 'sourceSha256']);
    assert.equal(receipt.provenance.implementation, 'CPython');
    assert.match(receipt.provenance.python, /^3\.\d+\.\d+$/);
    const family = receipt.provenance.python.split('.').slice(0, 2).join('.');
    if (executable !== primary) assert.equal(family, executable.slice(6));
    const unicode = { '3.12': '15.0.0', '3.13': '15.1.0', '3.14': '16.0.0' }[family];
    assert.ok(unicode, 'unfrozen interpreter family');
    assert.equal(receipt.provenance.unicode, unicode);
    assert.equal(receipt.provenance.recursionLimit, 1000);
    assert.equal(receipt.provenance.intMaxStrDigits, 4300);
    assert.equal(receipt.provenance.sourceSha256, hash(readFileSync(new URL('../scripts/job_apply_store/io.py', import.meta.url))));
    assert.deepEqual(receipt.cases.map((item) => item.id), fixed.map(([id]) => id));
    let unavailable = 0;
    for (let index = 0; index < fixed.length; index += 1) {
      const [id, bytes, expected] = fixed[index];
      const item = receipt.cases[index];
      keys(item, ['id', 'inputHex', 'status', 'native', 'outcome', 'before', 'after', 'unchanged']);
      assert.equal(item.inputHex, bytes === null ? null : Buffer.from(bytes).toString('hex'));
      assert.equal(item.native, id.includes('symlink'));
      if (item.status === 'unavailable') {
        assert.equal(item.native, true);
        keys(item.outcome, ['kind', 'name']);
        assert.equal(item.outcome.kind, 'unavailable');
        assert.match(item.outcome.name, /^(OSError|PermissionError|NotImplementedError)$/);
        assert.deepEqual(item.before, []);
        assert.deepEqual(item.after, []);
        assert.equal(item.unchanged, null);
        unavailable += 1;
        t.diagnostic(`${id}: native symlink unavailable; not a passing native cell`);
        continue;
      }
      assert.equal(item.status, 'observed');
      assert.deepEqual(item.outcome, expectedOutcome(id, expected, receipt.provenance.osName), id);
      assert.equal(item.unchanged, true);
      assert.deepEqual(item.after, item.before, `${id}: bytes/modes/mtimes/directory/link effects`);
      const snapshot = new Map(item.before.map((entry) => [entry.path, entry]));
      assert.equal(snapshot.size, item.before.length);
      assert.equal(snapshot.get('.').kind, 'directory');
      for (const entry of item.before) {
        keys(entry, ['path', 'kind', 'mode', 'mtimeNs', 'sha256', 'target']);
        assert.ok(!entry.path.startsWith('/') && !entry.path.includes('..'));
        assert.ok(Number.isSafeInteger(entry.mode));
        assert.match(entry.mtimeNs, /^\d+$/);
        if (entry.kind === 'file') assert.match(entry.sha256, /^[0-9a-f]{64}$/);
        else assert.equal(entry.sha256, null);
      }
      if (id.startsWith('missing-')) assert.deepEqual([...snapshot.keys()], ['.']);
      if (id === 'directory') assert.equal(snapshot.get('input.json').kind, 'directory');
      if (id === 'symlink' || id === 'broken-symlink') {
        assert.equal(snapshot.get('input.json').kind, 'symlink');
        assert.equal(snapshot.get('input.json').target, 'target.json');
        assert.equal(snapshot.has('target.json'), id === 'symlink');
      }
      if (id === 'parent-symlink') assert.equal(snapshot.get('alias').target, 'target');
      if (bytes !== null) {
        const filename = id === 'symlink' ? 'target.json' : id === 'parent-symlink' ? 'target/input.json' : 'input.json';
        assert.equal(snapshot.get(filename).sha256, hash(Buffer.from(bytes)));
      }
    }
    t.diagnostic(`${receipt.provenance.python}: ${fixed.length - unavailable} observed; ${unavailable} native unavailable; source ${receipt.provenance.sourceSha256}`);
  });
}

test('raw read reference rejects caller input and path flags without echoing values', () => {
  for (const [args, input] of [[['--root', 'private-canary'], ''], [[], 'private-canary']]) {
    const run = spawnSync(primary, ['-I', reference, ...args], { input, encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 2);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, 'raw_read_reference_input_rejected\n');
  }
});
