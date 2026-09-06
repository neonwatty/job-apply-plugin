import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { appendFile, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { privateFileDigest } from '../runtime/store/private-file-digest.js';

const reference = fileURLToPath(new URL('../tools/contracts/private-file-digest/reference.py', import.meta.url));
const primary = process.platform === 'win32' ? 'python' : 'python3';
const maximum = 10 * 1024 * 1024;
const hash = (data) => createHash('sha256').update(data).digest('hex');
const standard = Buffer.from('73796e74686574696300ff0d0a6279746573', 'hex');
const ids = ['empty', 'binary', 'multichunk', 'exact-max', 'max-plus-one', 'missing',
  'missing-parent', 'directory', 'symlink', 'broken-link', 'open-error', 'fstat-error',
  'read-error', 'close-error', 'swap-symlink', 'grow-after-stat'];
const fault = () => Object.assign(new Error('synthetic IO failure'), { errno: -5, code: 'EIO' });

async function snapshot(root) {
  const result = [];
  async function visit(path, relative) {
    const info = await lstat(path, { bigint: true });
    const kind = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file';
    result.push({ path: relative, kind, mode: String(info.mode), mtime: String(info.mtimeNs),
      hash: kind === 'file' ? hash(await readFile(path)) : null,
      target: kind === 'symlink' ? await readlink(path) : null });
    if (kind === 'directory') for (const name of (await readdir(path)).sort()) {
      await visit(join(path, name), relative === '.' ? name : `${relative}/${name}`);
    }
  }
  await visit(root, '.');
  return result;
}

async function setup(root, id) {
  const sizes = { empty: 0, multichunk: 1024 * 1024 + 17, 'exact-max': maximum, 'max-plus-one': maximum + 1 };
  const data = Object.hasOwn(sizes, id) ? Buffer.alloc(sizes[id], 'x') : standard;
  let path = join(root, 'input.bin');
  if (id === 'missing-parent') path = join(root, 'absent', 'input.bin');
  else if (id === 'directory') await mkdir(path);
  else if (id === 'symlink' || id === 'broken-link') {
    if (id === 'symlink') await writeFile(join(root, 'target.bin'), data);
    await symlink('target.bin', path, 'file');
  } else if (id !== 'missing') await writeFile(path, data);
  if (id === 'swap-symlink') await writeFile(join(root, 'foreign.bin'), 'synthetic foreign bytes');
  return { path, data };
}

function observedIO(id, path) {
  const state = { events: [], opened: 0, closed: 0, bytes: 0, buffers: new Set(), handles: [] };
  const io = {
    noFollow: constants.O_NOFOLLOW ?? 0,
    async isSymbolicLink(value) {
      try { return (await lstat(value)).isSymbolicLink(); }
      catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error; }
    },
    async open(value, flags) {
      state.events.push({ op: 'open', flags });
      if (id === 'open-error') throw fault();
      if (id === 'swap-symlink') { await unlink(path); await symlink('foreign.bin', path, 'file'); }
      const handle = await open(value, flags);
      state.handles.push(handle);
      state.opened += 1;
      return {
        async stat() {
          state.events.push({ op: 'fstat' });
          if (id === 'fstat-error') throw fault();
          const info = await handle.stat();
          if (id === 'grow-after-stat') await appendFile(path, Buffer.alloc(maximum + 1, 'x'));
          return info;
        },
        async read(buffer, offset, length, position) {
          state.events.push({ op: 'read', requested: length });
          assert.equal(offset, 0);
          assert.equal(position, null);
          state.buffers.add(buffer);
          if (id === 'read-error') throw fault();
          const result = await handle.read(buffer, offset, length, position);
          state.bytes += result.bytesRead;
          return result;
        },
        async close() {
          state.events.push({ op: 'close' });
          await handle.close();
          state.closed += 1;
          if (id === 'close-error') throw fault();
        },
      };
    },
  };
  return { io, state };
}

for (const executable of [primary, 'python3.12', 'python3.13', 'python3.14']) {
  test(`TS digest matches Python descriptor evidence: ${executable}`, async (t) => {
    const run = spawnSync(executable, ['-I', reference], { input: '', encoding: 'utf8', timeout: 15000, maxBuffer: 256 * 1024 });
    if (run.error?.code === 'ENOENT' && executable !== primary) { t.skip('Interpreter alias unavailable'); return; }
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    const receipt = JSON.parse(run.stdout);
    assert.deepEqual(receipt.cases.map((item) => item.id), ids);
    for (const item of receipt.cases) await t.test(item.id, async (subtest) => {
      if (item.status === 'unavailable') { subtest.skip('Python native cell unavailable; not accepted'); return; }
      if (item.id === 'swap-symlink' && !constants.O_NOFOLLOW) { subtest.skip('Native O_NOFOLLOW unavailable'); return; }
      const root = await mkdtemp(join(tmpdir(), 'ts-digest-'));
      let state;
      try {
        let fixture;
        try { fixture = await setup(root, item.id); }
        catch (error) {
          if (item.native && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { subtest.skip('Native symlinks unavailable'); return; }
          throw error;
        }
        const before = await snapshot(root);
        const observed = observedIO(item.id, fixture.path);
        state = observed.state;
        if (item.outcome.kind === 'error') {
          assert.equal(item.id, 'close-error');
          await assert.rejects(privateFileDigest(fixture.path, observed.io), (error) => error.errno === -5);
        } else assert.equal(await privateFileDigest(fixture.path, observed.io), item.outcome.digest);
        assert.deepEqual(state.events, item.events);
        assert.equal(state.opened, item.openedCount);
        assert.equal(state.closed, item.closedCount);
        assert.equal(state.bytes, item.readBytes);
        assert.ok(state.buffers.size <= 1, 'reuse one chunk buffer');
        for (const handle of state.handles) assert.equal(handle.fd, -1, 'descriptor closed');
        const after = await snapshot(root);
        if (!['swap-symlink', 'grow-after-stat'].includes(item.id)) assert.deepEqual(after, before);
        else if (item.id === 'grow-after-stat') {
          assert.equal(after.find((entry) => entry.path === 'input.bin').hash,
            hash(Buffer.concat([fixture.data, Buffer.alloc(maximum + 1, 'x')])));
        } else {
          assert.deepEqual(after.find((entry) => entry.path === 'foreign.bin'), before.find((entry) => entry.path === 'foreign.bin'));
          assert.equal(after.find((entry) => entry.path === 'input.bin').target, 'foreign.bin');
          assert.equal(state.bytes, 0);
        }
        // Exercise default real adapter as well as the instrumented descriptor.
        if (!item.id.endsWith('error') && !['swap-symlink', 'grow-after-stat'].includes(item.id)) {
          assert.equal(await privateFileDigest(fixture.path), item.outcome.digest);
          assert.deepEqual(await snapshot(root), after);
        }
      } finally {
        if (state) for (const handle of state.handles) { if (handle.fd !== -1) await handle.close(); }
        await rm(root, { recursive: true, force: true });
      }
    });
  });
}

test('digest propagates non-OS failures, closes after failures and hashes short reads exactly', async () => {
  for (const stage of ['isSymbolicLink', 'open', 'stat', 'read', 'close']) {
    const failure = new TypeError('synthetic programmer failure');
    let closed = 0;
    const io = { noFollow: 0,
      async isSymbolicLink() { if (stage === 'isSymbolicLink') throw failure; return false; },
      async open() {
        if (stage === 'open') throw failure;
        return {
          async stat() { if (stage === 'stat') throw failure; return { size: 0, isFile: () => true }; },
          async read() { if (stage === 'read') throw failure; return { bytesRead: 0 }; },
          async close() { closed += 1; if (stage === 'close') throw failure; },
        };
      },
    };
    await assert.rejects(privateFileDigest('synthetic', io), (error) => error === failure);
    assert.equal(closed, ['isSymbolicLink', 'open'].includes(stage) ? 0 : 1);
  }
  const bytes = Buffer.from('synthetic-short-reads');
  let cursor = 0;
  let closed = false;
  const io = { noFollow: 0, async isSymbolicLink() { return false; }, async open() { return {
    async stat() { return { size: bytes.length, isFile: () => true }; },
    async read(buffer) {
      const length = Math.min(3, bytes.length - cursor);
      bytes.copy(buffer, 0, cursor, cursor + length);
      cursor += length;
      return { bytesRead: length };
    },
    async close() { closed = true; },
  }; } };
  assert.equal(await privateFileDigest('synthetic', io), hash(bytes));
  assert.equal(closed, true);
});
