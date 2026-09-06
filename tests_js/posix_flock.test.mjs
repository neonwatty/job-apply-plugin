import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { buildNativeLock } from '../tools/build-native-lock.mjs';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { nativeFixture } from './exclusive_file_lock_support.mjs';

test('native nonblocking flock binds descriptors, validates arguments and preserves kernel ownership', async (t) => {
  if (!['darwin', 'linux'].includes(process.platform)) { t.skip('Native POSIX compiler/host required'); return; }
  const fixture = await nativeFixture();
  const handles = [];
  try {
    assert.equal(fixture.receipt.nodeApiVersion, 8);
    assert.equal(fixture.receipt.artifactSha256, createHash('sha256').update(await readFile(fixture.receipt.artifact)).digest('hex'));
    await assert.rejects(buildNativeLock({ outputDirectory: join(fixture.root, 'addon') }), { code: 'EEXIST' });
    const provider = loadPosixFlockProvider(fixture.receipt.artifact);
    const path = join(fixture.root, 'synthetic.lock');
    const first = await open(path, 'a+'); handles.push(first);
    const second = await open(path, 'a+'); handles.push(second);
    assert.equal(provider.tryLock(first.fd), true);
    assert.equal(provider.tryLock(second.fd), false);
    assert.equal(provider.tryLock(first.fd), true);
    let ticks = 0;
    const interval = setInterval(() => { ticks += 1; }, 1);
    try {
      for (let index = 0; index < 20; index += 1) {
        assert.equal(provider.tryLock(second.fd), false);
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      assert.ok(ticks > 0, 'Contended calls must not block the event loop');
    } finally { clearInterval(interval); }
    provider.unlock(first.fd);
    assert.equal(provider.tryLock(second.fd), true);
    provider.unlock(second.fd);
    for (const invalid of [NaN, Infinity, 1.5, '1', null, undefined, {}, 2 ** 40]) {
      assert.throws(() => provider.tryLock(invalid));
      assert.throws(() => provider.unlock(invalid));
    }
    const closed = second.fd;
    await second.close(); handles.pop();
    assert.throws(() => provider.tryLock(closed), error => error.code === 'EBADF' && error.name === 'OSError');
  } finally {
    for (const handle of handles) await handle.close();
    await fixture.cleanup();
  }
});
