import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, lstat, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
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
  assert.equal((await cli('replay-transition', [
    '--id', 'replay-job', '--transition', 'started', '--ats', 'greenhouse',
  ])).changed, true);
  assert.equal((await cli('session-load', ['--id', 'replay-job'])).ats, 'greenhouse');
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

test('Store state commands recover pending coordinator history before reading', async t => {
  const fixture = await nativeFixture();
  t.after(() => fixture.cleanup());
  const root = join(await realpath(fixture.root), 'recovering-store');
  await initializeJobsFixture(root);
  const at = '2026-09-15T18:00:00Z';
  const claim = { claimId: 'claim-one', jobId: 'job-one', ownerLabel: 'Owner',
    tokenHash: createHash('sha256').update('token').digest('hex'), acquiredAt: at, heartbeatAt: at,
    expiresAt: '2026-09-15T18:05:00Z' };
  const event = { schemaVersion: 1, eventId: 'event-one', applicationId: 'job-one',
    event: 'claim-recovered', company: null, role: null, ats: null, status: 'in_progress', answerKeys: [], at };
  await writeFile(join(root, 'coordinator-journal.json'), JSON.stringify({ schemaVersion: 1, operation: {
    kind: 'recover', operationId: 'recover-one', jobId: 'job-one', at, historyEvent: event, resultClaim: claim,
  } }), { mode: 0o600 });
  await writeFile(join(root, 'applications.jsonl'), '{"torn"', { mode: 0o600 });
  const result = JSON.parse(await runJobsCli([
    '--root', root, '--native-lock', fixture.receipt.artifact, 'history-list',
  ], async () => ''));
  assert.deepEqual(result, [event]);
});

test('production bootstrap locking never mutates an unsafe Store root', async t => {
  const fixture = await nativeFixture();
  t.after(() => fixture.cleanup());
  const parent = await realpath(fixture.root), loose = join(parent, 'loose-store');
  await mkdir(loose, { mode: 0o700 }); await chmod(loose, 0o755);
  const init = root => runJobsCli(['--root', root, '--native-lock', fixture.receipt.artifact, 'init'], async () => '');
  await assert.rejects(init(loose), /private owned directory/);
  assert.equal((await lstat(loose)).mode & 0o777, 0o755);
  await assert.rejects(lstat(join(loose, '.store.lock')), { code: 'ENOENT' });

  const target = join(parent, 'symlink-target'), linked = join(parent, 'linked-store');
  await mkdir(target, { mode: 0o700 }); await symlink(target, linked);
  await assert.rejects(init(linked), /directory without links/);
  assert.equal((await lstat(target)).mode & 0o777, 0o700);
  await assert.rejects(lstat(join(target, '.store.lock')), { code: 'ENOENT' });
});
