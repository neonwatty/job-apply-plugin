import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runJobsCli } from '../runtime/cli/native-jobs.js';
import { initializeJobsFixture } from '../runtime/store/native-jobs.js';
import { nativeFixture } from './exclusive_file_lock_support.mjs';

test('production native CLI composes Store state and account automation commands', async t => {
  const fixture = await nativeFixture();
  t.after(() => fixture.cleanup());
  const root = join(await realpath(fixture.root), 'integrated-store');
  await initializeJobsFixture(root);
  let stdin = {};
  const cli = async (command, args = []) => JSON.parse(await runJobsCli([
    '--root', root, '--native-lock', fixture.receipt.artifact, command, ...args,
  ], async () => JSON.stringify(stdin)));

  assert.equal((await cli('automation-settings-get')).revision, 1);
  assert.deepEqual(await cli('history-list'), []);
  stdin = { status: 'active', step: 'standalone' };
  const saved = await cli('session-save', ['--id', 'standalone', '--input', '-']);
  assert.equal(saved.applicationId, 'standalone');
  assert.equal((await cli('session-load', ['--id', 'standalone'])).step, 'standalone');
  assert.equal((await cli('profile-preparedness-get')).essentialSetup.length, 4);
});

test('production native CLI exposes bootstrap paths without mutation and locks init', async t => {
  const fixture = await nativeFixture();
  t.after(() => fixture.cleanup());
  const root = join(await realpath(fixture.root), 'bootstrapped-store');
  const paths = JSON.parse(await runJobsCli(['--root', root, 'paths'], async () => ''));
  assert.equal(paths.root, root);
  const initialized = JSON.parse(await runJobsCli([
    '--root', root, '--native-lock', fixture.receipt.artifact, 'init',
  ], async () => ''));
  assert.equal(initialized.initialized, true);
  await writeFile(join(root, 'sentinel'), 'kept');
  assert.equal(JSON.parse(await runJobsCli([
    '--root', root, '--native-lock', fixture.receipt.artifact, 'init',
  ], async () => '')).initialized, true);
});
