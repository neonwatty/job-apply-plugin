import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { nativeFixture } from './exclusive_file_lock_support.mjs';

test('Windows x64 addon builds and satisfies the native filesystem contracts', {
  skip: process.platform !== 'win32',
  timeout: 220_000,
}, async t => {
  const fixture = await nativeFixture();
  t.after(fixture.cleanup);
  assert.equal(fixture.receipt.arch, 'x64');
  // Run the witness in a child so Windows releases the DLL before fixture cleanup.
  const witness = fileURLToPath(new URL('./windows_native_lock_witness.mjs', import.meta.url));
  for (const [name, label] of [
    ['lock', 'descriptor and process locking'],
    ['acl', 'owner identity, ACL protection and inheritance'],
    ['directory', 'handle-relative listing, inspection and open'],
  ]) {
    await t.test(label, () => {
      const result = spawnSync(process.execPath, [witness, fixture.receipt.artifact, fixture.root, name], {
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
    });
  }
});
