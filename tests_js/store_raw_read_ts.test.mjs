import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readFileText } from '../runtime/store/read-file.js';
import { readJsonObject } from '../runtime/store/read-json-object.js';
import { StoreValidationError } from '../runtime/store/validation.js';
import { NumericAtomError } from '../runtime/contracts/raw-json/numeric-atom.js';
import { serializePythonScope } from '../runtime/contracts/raw-json/serializer.js';

const reference = fileURLToPath(new URL('../tools/contracts/store-raw-read/reference.py', import.meta.url));
const primary = process.platform === 'win32' ? 'python' : 'python3';
const ids = ['empty-object', 'typed-values', 'future-schema', 'duplicate-key', 'utf8',
  'invalid-utf8', 'truncated-utf8', 'bom', 'crlf', 'bare-cr', 'empty-file', 'invalid-json',
  'array', 'scalar', 'null', 'missing-file', 'missing-parent', 'directory', 'symlink',
  'broken-symlink', 'parent-symlink', 'integer-digit-limit'];

async function snapshot(root) {
  const entries = [];
  async function visit(path, relative) {
    const info = await lstat(path, { bigint: true });
    const kind = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file';
    entries.push({ path: relative, kind, mode: Number(info.mode & 0o7777n),
      mtimeNs: String(info.mtimeNs), target: kind === 'symlink' ? await readlink(path) : null,
      sha256: kind === 'file' ? createHash('sha256').update(await readFile(path)).digest('hex') : null });
    if (kind === 'directory') {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), relative === '.' ? name : `${relative}/${name}`);
    }
  }
  await visit(root, '.');
  return entries;
}

async function prepare(root, item) {
  const requested = join(root, 'input.json');
  const bytes = item.inputHex === null ? null : Buffer.from(item.inputHex, 'hex');
  if (item.id === 'missing-parent') return join(root, 'absent', 'input.json');
  if (item.id === 'missing-file') return requested;
  if (item.id === 'directory') await mkdir(requested);
  else if (item.id === 'symlink' || item.id === 'broken-symlink') {
    if (bytes) await writeFile(join(root, 'target.json'), bytes);
    await symlink('target.json', requested, 'file');
  } else if (item.id === 'parent-symlink') {
    await mkdir(join(root, 'target'));
    await writeFile(join(root, 'target', 'input.json'), bytes);
    await symlink('target', join(root, 'alias'), 'dir');
    return join(root, 'alias', 'input.json');
  } else await writeFile(requested, bytes);
  return requested;
}

for (const executable of [primary, 'python3.12', 'python3.13', 'python3.14']) {
  test(`inert TS raw reads match fixed Python reference on separate clones: ${executable}`, async (t) => {
    const run = spawnSync(executable, ['-I', reference], {
      input: '', encoding: 'utf8', timeout: 10000, maxBuffer: 256 * 1024,
    });
    if (run.error?.code === 'ENOENT' && executable !== primary) {
      t.skip('Interpreter unavailable; no reference profile acceptance');
      return;
    }
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    const receipt = JSON.parse(run.stdout);
    assert.deepEqual(receipt.cases.map((item) => item.id), ids);
    assert.equal(receipt.provenance.intMaxStrDigits, 4300);
    for (const item of receipt.cases) {
      await t.test(item.id, async (subtest) => {
        if (item.status === 'unavailable') {
          assert.equal(item.native, true);
          subtest.skip('Python native link creation unavailable; not a passing native cell');
          return;
        }
        assert.equal(item.status, 'observed');
        assert.equal(item.unchanged, true);
        assert.deepEqual(item.after, item.before);
        const root = await mkdtemp(join(tmpdir(), 'ts-raw-read-'));
        try {
          let requested;
          try {
            requested = await prepare(root, item);
          } catch (error) {
            if (item.native && ['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) {
              subtest.skip('TS native link creation unavailable; not a passing native cell');
              return;
            }
            throw error;
          }
          const before = await snapshot(root);
          if (item.outcome.kind === 'value') {
            const value = await readJsonObject(requested, 'synthetic document', { intMaxStrDigits: 4300 });
            assert.ok(value instanceof Map);
            assert.equal(serializePythonScope(value), item.outcome.json);
          } else if (item.id === 'integer-digit-limit') {
            assert.equal(item.outcome.name, 'ValueError');
            await assert.rejects(readJsonObject(requested, 'synthetic document', { intMaxStrDigits: 4300 }),
              (error) => error instanceof NumericAtomError && error.reason === 'integer-digit-limit');
          } else {
            assert.equal(item.outcome.name, 'StoreError');
            await assert.rejects(readJsonObject(requested, 'synthetic document', { intMaxStrDigits: 4300 }),
              (error) => error instanceof StoreValidationError && error.message.replace(root, '<fixture>') === item.outcome.message);
          }
          assert.deepEqual(await snapshot(root), before, 'reads must preserve bytes, mode, mtime, entries and links');
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    }
    t.diagnostic(`${receipt.provenance.python}/Unicode ${receipt.provenance.unicode}; 22 fixed reference cases; native skips remain explicit`);
  });
}

test('text reader preserves BOM, decodes strictly and applies only universal newline conversion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ts-text-read-'));
  const path = join(root, 'input');
  try {
    for (const [bytes, expected] of [
      [Buffer.from('\ufeffé😀\r\nx\ry\n'), '\ufeffé😀\nx\ny\n'],
      [Buffer.from('a\u2028b\u0085c\u0000'), 'a\u2028b\u0085c\u0000'],
    ]) {
      await writeFile(path, bytes);
      const before = await snapshot(root);
      assert.equal(await readFileText(path), expected);
      assert.deepEqual(await snapshot(root), before);
    }
    for (const bytes of [Buffer.from([0xff]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xe2, 0x82])]) {
      await writeFile(path, bytes);
      await assert.rejects(readFileText(path), (error) => error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reader propagates configuration/type failures and honors disabled integer digit limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ts-read-errors-'));
  const path = join(root, 'input.json');
  try {
    await writeFile(path, '{"a":' + '9'.repeat(4301) + '}');
    const before = await snapshot(root);
    const result = await readJsonObject(path, 'synthetic', { intMaxStrDigits: 0 });
    assert.equal(result.get('a').kind, 'int');
    assert.equal(result.get('a').value.toString().length, 4301);
    await assert.rejects(readJsonObject(path, 'synthetic', { intMaxStrDigits: -1 }), RangeError);
    await assert.rejects(readJsonObject(null, 'synthetic', { intMaxStrDigits: 4300 }),
      (error) => error instanceof TypeError && !(error instanceof StoreValidationError));
    assert.deepEqual(await snapshot(root), before);
    await writeFile(path, '{"s":"\\ud800","pair":"\\ud83d\\ude00"}');
    const escaped = await readJsonObject(path, 'synthetic', { intMaxStrDigits: 4300 });
    assert.equal(escaped.get('s'), '\ud800');
    assert.equal(escaped.get('pair'), '😀');
    assert.equal(serializePythonScope(escaped), '{"pair":"\\ud83d\\ude00","s":"\\ud800"}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
