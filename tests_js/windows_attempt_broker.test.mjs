import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { nativeFixture } from './exclusive_file_lock_support.mjs';

test('Windows attempt broker authenticates its named pipe and keeps runtime state private', {
  skip: process.platform !== 'win32',
  timeout: 220_000,
}, async t => {
  const fixture = await nativeFixture();
  t.after(fixture.cleanup);
  const witness = fileURLToPath(new URL('./windows_attempt_witness.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [witness, '--witness', fixture.receipt.artifact, await realpath(fixture.root)], {
    encoding: 'utf8', timeout: 90_000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
