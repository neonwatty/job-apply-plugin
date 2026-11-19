import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';

// Native Windows contracts for native/windows/flock.c; POSIX hosts cover native/posix.
const windows = process.platform === 'win32';
const options = { skip: windows ? false : 'native Windows lock contracts' };

// Build once: Windows cannot delete a loaded addon, so only its directory removal is best effort.
let built;
async function addon(t) {
  built ??= nativeFixture().then(fixture => {
    process.once('exit', () => { fixture.cleanup().catch(() => {}); });
    return fixture;
  });
  const fixture = await built;
  const root = mkdtempSync(join(fixture.root, 'case-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { native: createRequire(import.meta.url)(fixture.receipt.artifact), root, artifact: fixture.receipt.artifact };
}
function otherProcessLocks(artifact, path) {
  const script = `const fs=require('fs');const a=require(${JSON.stringify(artifact)});`
    + `process.stdout.write(String(a.tryLock(fs.openSync(${JSON.stringify(path)},'r+'))));`;
  return spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' }).stdout;
}

test('Windows lock is exclusive across descriptors and processes and keeps content readable', options, async t => {
  const { native, root, artifact } = await addon(t);
  const path = join(root, 'held.lock');
  writeFileSync(path, '1234\n');
  const first = openSync(path, 'r+'), second = openSync(path, 'r+');
  try {
    assert.equal(native.tryLock(first), true);
    assert.equal(native.tryLock(second), false);
    assert.equal(otherProcessLocks(artifact, path), 'false');
    assert.equal(readFileSync(path, 'utf8'), '1234\n');
    native.unlock(first);
    assert.equal(native.tryLock(second), true);
    native.unlock(second);
    native.unlock(second);
  } finally { closeSync(first); closeSync(second); }
  assert.equal(otherProcessLocks(artifact, path), 'true');
  assert.throws(() => native.tryLock(2 ** 30), error => error.code === 'EBADF' && typeof error.errno === 'number');
});

test('Windows owner-only DACL is applied, verified, and inherited', options, async t => {
  const { native, root } = await addon(t);
  const directory = join(root, 'private');
  mkdirSync(directory);
  assert.equal(native.isOwnerOnly(directory), false);
  native.restrictToOwner(directory);
  assert.equal(native.isOwnerOnly(directory), true);
  writeFileSync(join(directory, 'child.json'), '{}');
  mkdirSync(join(directory, 'nested'));
  assert.equal(native.isOwnerOnly(join(directory, 'child.json')), true);
  assert.equal(native.isOwnerOnly(join(directory, 'nested')), true);
  assert.throws(() => native.isOwnerOnly(join(root, 'missing')), error => error.code === 'ENOENT');
});

test('Windows directory descriptors list, inspect, and open entries without escaping', options, async t => {
  const { native, root } = await addon(t);
  const directory = join(root, 'reports');
  mkdirSync(directory);
  writeFileSync(join(directory, 'search-1.md'), 'report');
  writeFileSync(join(directory, 'naïve-ü.md'), 'x');
  mkdirSync(join(directory, 'sub'));
  const descriptor = openSync(directory, 'r');
  try {
    assert.deepEqual(native.listNames(descriptor).map(name => name.toString('utf8')).sort(), ['naïve-ü.md', 'search-1.md', 'sub']);
    const metadata = native.inspect(descriptor, 'search-1.md');
    assert.equal(metadata.size, 6n);
    assert.equal(metadata.mode & 0o170000, 0o100000);
    assert.equal(native.inspect(descriptor, 'sub').mode & 0o170000, 0o040000);
    const opened = native.openFile(descriptor, 'search-1.md');
    try {
      const stat = fstatSync(opened, { bigint: true });
      assert.equal(stat.ino, metadata.ino);
      assert.equal(readFileSync(opened, 'utf8'), 'report');
    } finally { closeSync(opened); }
    for (const name of ['search-1.md:stream', '..', '.', 'a/b']) {
      assert.throws(() => native.inspect(descriptor, name), /basename is invalid/);
    }
    assert.throws(() => native.openFile(descriptor, 'absent.md'), error => error.code === 'ENOENT');
  } finally { closeSync(descriptor); }
});
