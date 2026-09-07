import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const driver = fileURLToPath(new URL('../tools/contracts/posix-path-bytes/reference.py', import.meta.url));
const primary = process.platform === 'win32' ? 'python' : 'python3';
const source = new URL('../scripts/job_apply_store/domains/resumes/storage.py', import.meta.url);
const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
const inputs = ['\udcff', '\udcff/data', '\udcfe', 'byte-target', 'dangling-byte', '😀',
  '\udcff', '\udcff/data', '\udcfe/data', 'dangling-byte/data', 'nul\0', 'nul\0/data',
  '\ud800', '\udc7f', '\udc80', '\ud800'];
const paths = {
  'resolve-byte-directory': '\udcff', 'resolve-byte-file': '\udcff/data',
  'resolve-byte-link': '', 'resolve-byte-target': '\udcff',
  'resolve-dangling-byte': '\udcfd', 'resolve-astral': '😀',
  'managed-byte-leaf': '\udcff', 'managed-byte-link-parent': '\udcfe/data',
  'managed-nul-leaf': 'nul\0', 'resolve-escape-surrogate': '\udc80',
  'managed-high-surrogate-leaf': '\ud800',
};
const ids = ['resolve-byte-directory', 'resolve-byte-file', 'resolve-byte-link',
  'resolve-byte-target', 'resolve-dangling-byte', 'resolve-astral', 'managed-byte-leaf',
  'managed-byte-parent', 'managed-byte-link-parent', 'managed-dangling-byte-parent',
  'managed-nul-leaf', 'managed-nul-parent', 'resolve-high-surrogate',
  'resolve-low-nonescape-surrogate', 'resolve-escape-surrogate', 'managed-high-surrogate-leaf'];
const nativeNameCases = new Set(['resolve-byte-directory', 'resolve-byte-file',
  'resolve-byte-link', 'managed-byte-parent', 'managed-byte-link-parent']);

for (const executable of [primary, 'python3.12', 'python3.13', 'python3.14']) {
  test(`POSIX byte reference: ${executable}`, (t) => {
    const result = spawnSync(executable, ['-I', driver], { input: '', encoding: 'utf8', timeout: 15000, maxBuffer: 2 ** 20 });
    if (result.error?.code === 'ENOENT' && executable !== primary) return t.skip('Interpreter unavailable');
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const receipt = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(receipt).sort(), ['cases', 'provenance', 'reason', 'schemaVersion', 'status']);
    assert.equal(receipt.schemaVersion, 1);
    keys(receipt.provenance, ['implementation', 'python', 'platform', 'filesystemEncoding', 'filesystemErrors', 'sourceSha256']);
    assert.equal(receipt.provenance.implementation, 'CPython');
    assert.equal(receipt.provenance.platform, process.platform);
    assert.match(receipt.provenance.python, /^3\.(12|13|14)\./);
    if (executable !== primary) assert.equal(receipt.provenance.python.split('.').slice(0, 2).join('.'), executable.slice(6));
    assert.equal(receipt.provenance.filesystemEncoding, 'utf-8');
    assert.equal(receipt.provenance.sourceSha256, createHash('sha256').update(readFileSync(source)).digest('hex'));
    if (receipt.status === 'unavailable') {
      assert.equal(process.platform, 'win32');
      assert.deepEqual(receipt.cases, []);
      return t.skip(receipt.reason);
    }
    assert.equal(receipt.status, 'observed');
    assert.equal(receipt.reason, null);
    assert.equal(receipt.provenance.filesystemErrors, 'surrogateescape');
    assert.deepEqual(receipt.cases.map((item) => item.id), ids);
    let unavailable = 0;
    for (const item of receipt.cases) {
      if (item.status === 'unavailable') {
        keys(item, ['id', 'status', 'reason', 'setupFailure']);
        assert.ok(nativeNameCases.has(item.id));
        assert.equal(item.reason, 'Filesystem rejects native non-UTF-8 names');
        keys(item.setupFailure, ['stage', 'name', 'errno']);
        assert.ok(['mkdir-byte-name', 'write-byte-name', 'symlink-byte-name'].includes(item.setupFailure.stage));
        assert.equal(item.setupFailure.name, 'OSError');
        assert.equal(item.setupFailure.errno, constants.errno.EILSEQ);
        unavailable += 1;
        continue;
      }
      assert.equal(item.status, 'observed');
      keys(item, ['id', 'status', 'operation', 'input', 'outcome', 'before', 'after', 'unchanged']);
      assert.equal(item.operation, item.id.startsWith('resolve-') ? 'resolve' : 'managed');
      assert.equal(item.input, inputs[ids.indexOf(item.id)]);
      assert.equal(item.unchanged, true);
      assert.deepEqual(item.before, item.after);
      assert.ok(item.before.length >= 5);
      const names = item.before.map((entry) => entry.pathHex);
      assert.equal(new Set(names).size, names.length);
      assert.deepEqual(names, [...names].sort());
      for (const entry of item.before) {
        keys(entry, ['pathHex', 'kind', 'mode', 'mtimeNs', 'sha256', 'targetHex']);
        assert.match(entry.pathHex, /^(?:[0-9a-f]{2})+$/);
        assert.ok(['file', 'directory', 'symlink'].includes(entry.kind));
        assert.ok(Number.isSafeInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o7777);
        assert.match(entry.mtimeNs, /^\d+$/);
        if (entry.kind === 'file') assert.match(entry.sha256, /^[0-9a-f]{64}$/);
        else assert.equal(entry.sha256, null);
        if (entry.kind === 'symlink') assert.match(entry.targetHex, /^(?:[0-9a-f]{2})+$/);
        else assert.equal(entry.targetHex, null);
      }
      const tree = new Map(item.before.map((entry) => [entry.pathHex, entry]));
      for (const directory of ['.', 'managed', 'managed/😀']) {
        assert.equal(tree.get(Buffer.from(directory).toString('hex'))?.kind, 'directory');
      }
      for (const [name, target] of [['managed/byte-target', 'ff'], ['managed/dangling-byte', 'fd']]) {
        assert.equal(tree.get(Buffer.from(name).toString('hex'))?.kind, 'symlink');
        assert.equal(tree.get(Buffer.from(name).toString('hex'))?.targetHex, target);
      }
      if (!receipt.cases.some((record) => record.status === 'unavailable')) {
        const byteDirectory = Buffer.concat([Buffer.from('managed/'), Buffer.from([255])]);
        assert.equal(tree.get(byteDirectory.toString('hex'))?.kind, 'directory');
        assert.equal(tree.get(Buffer.concat([byteDirectory, Buffer.from('/data')]).toString('hex'))?.sha256,
          createHash('sha256').update('synthetic').digest('hex'));
        assert.equal(tree.get(Buffer.concat([Buffer.from('managed/'), Buffer.from([254])]).toString('hex'))?.targetHex, '2e');
      }
      if (Object.hasOwn(paths, item.id)) {
        keys(item.outcome, ['kind', 'path', 'pathHex']);
        const suffix = paths[item.id];
        assert.equal(item.outcome.kind, 'path');
        assert.equal(item.outcome.path, '<root>/managed' + (suffix ? '/' + suffix : ''));
        if (item.id === 'managed-high-surrogate-leaf') assert.equal(item.outcome.pathHex, null);
        else {
          const components = [...item.outcome.path].map((character) => {
            const code = character.codePointAt(0);
            return code >= 0xdc80 && code <= 0xdcff ? Buffer.from([code - 0xdc00]) : Buffer.from(character);
          });
          assert.equal(item.outcome.pathHex, Buffer.concat(components).toString('hex'));
        }
      } else {
        const expected = item.id === 'managed-nul-parent' ? 'ValueError'
          : item.id.startsWith('resolve-') ? 'UnicodeEncodeError' : 'StoreError';
        assert.equal(item.outcome.name, expected);
        keys(item.outcome, expected === 'StoreError' ? ['kind', 'name', 'message'] : ['kind', 'name']);
        assert.equal(item.outcome.kind, 'error');
        if (expected === 'StoreError') assert.equal(item.outcome.message, 'managed resume file identity is invalid');
      }
    }
    t.diagnostic(`${receipt.provenance.python}: ${ids.length - unavailable} observed; ${unavailable} native filename cells unavailable`);
    if (unavailable) t.skip('Native invalid-byte filename cells unavailable; partial evidence only');
  });
}

test('POSIX byte reference rejects caller input', () => {
  for (const [args, input] of [[['--path', 'synthetic'], ''], [[], 'data']]) {
    const result = spawnSync(primary, ['-I', driver, ...args], { input, encoding: 'utf8', timeout: 3000 });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'posix_bytes_reference_input_rejected\n');
  }
});
