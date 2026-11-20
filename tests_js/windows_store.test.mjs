import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { nativeFixture } from './exclusive_file_lock_support.mjs';

test('Windows Store bootstrap, ACLs, file identity and persistence', {
  skip: process.platform !== 'win32',
  timeout: 220_000,
}, async t => {
  const fixture = await nativeFixture();
  t.after(fixture.cleanup);
  const witness = fileURLToPath(new URL('./windows_store_witness.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [witness, fixture.receipt.artifact, await realpath(fixture.root)], {
    encoding: 'utf8', timeout: 75_000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
