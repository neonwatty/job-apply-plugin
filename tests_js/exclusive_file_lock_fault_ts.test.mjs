import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { withExclusiveFileLock } from '../runtime/store/exclusive-file-lock.js';
import { nativeFixture } from './exclusive_file_lock_support.mjs';

const reference = fileURLToPath(new URL('../tools/contracts/exclusive-file-lock/reference.py', import.meta.url));
const ids = ['normal', 'parent-mode-error', 'open-error', 'file-mode-error', 'acquire-error',
  'body-error', 'release-error', 'close-error', 'body-release-error', 'body-close-error',
  'acquire-release-error', 'release-close-error', 'existing-file', 'symlink-file'];

async function snapshot(root) {
  const rows = [];
  for (const name of ['.', ...(await readdir(root)).sort()]) {
    const path = name === '.' ? root : join(root, name);
    const info = await lstat(path);
    const kind = info.isSymbolicLink() ? 'link' : info.isFile() ? 'file' : 'directory';
    rows.push({ path: name, kind, mode: info.mode & 0o7777,
      bytes: kind === 'file' ? (await readFile(path)).toString('hex') : null,
      target: kind === 'link' ? await readlink(path) : null });
  }
  return rows;
}

for (const executable of ['python3', 'python3.12', 'python3.13', 'python3.14']) {
  test(`native lock failures preserve actual Python ordering and descriptor witnesses: ${executable}`, async t => {
    if (!['darwin', 'linux'].includes(process.platform)) return t.skip('Native POSIX reference required');
    const run = spawnSync(executable, ['-I', reference], { input: '', encoding: 'utf8', timeout: 10000 });
    if (run.error?.code === 'ENOENT' && executable !== 'python3') return t.skip('Interpreter alias unavailable');
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout);
    const profile = receipt.profile.python.split('.').slice(0, 2).join('.');
    if (executable !== 'python3') assert.equal(profile, executable.slice(6));
    assert.equal(receipt.status, 'observed');
    assert.deepEqual(receipt.cases.map(row => row.id), ids);
    const fixture = await nativeFixture();
    try {
      const native = loadPosixFlockProvider(fixture.receipt.artifact);
      for (const expected of receipt.cases) await t.test(expected.id, async () => {
        const root = join(fixture.root, expected.id);
        await mkdir(root, { mode: 0o755 });
        await chmod(root, 0o755);
        const path = join(root, 'synthetic.lock');
        if (expected.id === 'existing-file') {
          await writeFile(path, 'synthetic existing lock'); await chmod(path, 0o644);
        }
        if (expected.id === 'symlink-file') {
          await writeFile(join(root, 'target'), 'synthetic target'); await chmod(join(root, 'target'), 0o644);
          await symlink('target', path);
        }
        const handles = new Map();
        const calls = [];
        const errors = new Map();
        const step = stage => {
          calls.push(stage);
          if (expected.failures.includes(stage)) {
            const failure = Object.assign(new Error(`synthetic ${stage}`), { name: 'OSError', errno: 5 });
            errors.set(stage, failure);
            throw failure;
          }
        };
        const io = {
          async ensurePrivateDirectory(candidate) {
            assert.equal(candidate, root);
            await mkdir(candidate, { recursive: true, mode: 0o700 });
            step('parent-mode');
            await chmod(candidate, 0o700);
          },
          async open(candidate, flags, mode) {
            assert.equal(candidate, path);
            assert.equal(flags, constants.O_RDWR | constants.O_CREAT);
            assert.equal(mode, 0o600);
            step('open');
            const handle = await open(candidate, flags, mode);
            const descriptor = handle.fd;
            handles.set(descriptor, handle);
            return { fd: descriptor, async close() {
              assert.ok(handles.has(descriptor));
              step('close');
              await handle.close(); handles.delete(descriptor);
            } };
          },
          async chmod(candidate, mode) {
            assert.equal(candidate, path); assert.equal(mode, 0o600);
            step('file-mode'); await chmod(candidate, mode);
          },
        };
        const provider = {
          tryLock(descriptor) {
            assert.ok(handles.has(descriptor));
            step('acquire');
            const acquired = native.tryLock(descriptor);
            assert.equal(acquired, true, 'Each baseline fixture has no competing holder');
            return acquired;
          },
          unlock(descriptor) { assert.ok(handles.has(descriptor)); step('release'); native.unlock(descriptor); },
        };
        try {
          assert.deepEqual(await snapshot(root), expected.before);
          let failure;
          try { await withExclusiveFileLock(path, async () => { step('body'); }, { provider, pathProfile: profile, io }); }
          catch (caught) { failure = caught; }
          assert.deepEqual(calls, expected.calls);
          assert.deepEqual(failure === undefined ? { kind: 'value' }
            : { kind: 'error', name: failure.name, errno: failure.errno, message: failure.message }, expected.outcome);
          assert.equal(handles.size, expected.openDescriptorsAtReturn);
          for (const handle of handles.values()) assert.ok((await handle.stat()).isFile(), 'Leak witness must be a genuinely open descriptor');
          assert.deepEqual(await snapshot(root), expected.after);
          const context = { 'body-release-error': ['release', 'body'], 'body-close-error': ['close', 'body'],
            'acquire-release-error': ['release', 'acquire'] }[expected.id];
          if (context) {
            assert.equal(failure, errors.get(context[0]));
            assert.equal(failure.cause, errors.get(context[1]));
          }
          if (expected.id === 'release-close-error') assert.equal(errors.has('close'), false);
        } finally {
          // Leaks were measured first; closing owned native handles releases any
          // retained kernel lock without changing the recorded helper behavior.
          for (const handle of handles.values()) await handle.close();
          await rm(root, { recursive: true, force: true });
        }
      });
    } finally { await fixture.cleanup(); }
  });
}
