import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [artifact, root] = process.argv.slice(2);
const native = createRequire(import.meta.url)(artifact);
const lockPath = join(root, 'lock');
writeFileSync(lockPath, '1234\n');

function probeInChild() {
  // Leave the descriptor open to exercise release on process exit.
  const script = `
    const [artifact, path] = process.argv.slice(1);
    const descriptor = require('node:fs').openSync(path, 'r+');
    process.stdout.write(String(require(artifact).tryLock(descriptor)));
  `;
  const result = spawnSync(process.execPath, ['-e', script, artifact, lockPath], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function assertLockReleased(descriptor) {
  const deadline = Date.now() + 3_000;
  do {
    if (native.tryLock(descriptor)) return;
    await delay(20);
  } while (Date.now() < deadline);
  assert.fail('Lock remained held after its descriptor closed or its process exited');
}

const first = openSync(lockPath, 'r+');
try {
  const second = openSync(lockPath, 'r+');
  try {
    assert.equal(native.tryLock(first), true, 'First descriptor can acquire the lock');
    assert.equal(native.tryLock(second), false, 'Second descriptor sees contention');
    native.unlock(second);
    assert.equal(probeInChild(), 'false', 'Another process sees contention after an unrelated unlock');
    assert.equal(readFileSync(lockPath, 'utf8'), '1234\n', 'Lock does not cover file contents');
    native.unlock(first);
    assert.equal(native.tryLock(second), true, 'Explicit unlock releases the lock');
  } finally {
    closeSync(second);
  }
  await assertLockReleased(first);
  native.unlock(first);
  assert.equal(probeInChild(), 'true', 'Child process can acquire a released lock');
  await assertLockReleased(first);
  native.unlock(first);
} finally {
  closeSync(first);
}

for (const method of [native.tryLock, native.unlock]) {
  assert.throws(() => method('0'), TypeError);
  assert.throws(() => method(-1), RangeError);
  assert.throws(() => method(2 ** 30), error => error.code === 'EBADF' && Number.isInteger(error.errno));
}
