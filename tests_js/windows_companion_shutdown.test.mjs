import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { nativeFixture } from './exclusive_file_lock_support.mjs';

test('Windows Companion starts on a fresh native Store and shuts down without orphans', {
  skip: process.platform !== 'win32', timeout: 180_000,
}, async t => {
  const fixture = await nativeFixture();
  t.after(fixture.cleanup);
  // A separate process loads the addon, so the fixture can delete it afterwards.
  const witness = fileURLToPath(new URL('./windows_companion_witness.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [witness, fixture.receipt.artifact, await realpath(fixture.root)], {
    encoding: 'utf8', timeout: 150_000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
