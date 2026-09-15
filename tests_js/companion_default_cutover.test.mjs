import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { activateNativeWriter } from '../runtime/store/native-writer-switch.js';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { assertNoLiveDetachedAttempt, parseSupervisorOptions, prepareNativeDefault, resolveSupervisorRoot, runSupervisor } from '../apps/companion/supervise.mjs';

const app = new URL('../apps/companion/', import.meta.url).pathname;
const execute = promisify(execFile);

test('Companion supervisor resolves the ordinary Store root with closed options', () => {
  assert.equal(resolveSupervisorRoot(parseSupervisorOptions(['--root', '/tmp/explicit'], app), {}, '/tmp/home'), '/tmp/explicit');
  assert.equal(resolveSupervisorRoot(parseSupervisorOptions([], app), { JOB_APPLY_STORE_DIR: '/tmp/environment' }, '/tmp/home'), '/tmp/environment');
  assert.equal(resolveSupervisorRoot(parseSupervisorOptions([], app), {}, '/tmp/home'), '/tmp/home/.job-apply');
  assert.throws(() => parseSupervisorOptions(['--writer', 'python'], app), /Unknown supervisor option/);
  assert.throws(() => parseSupervisorOptions(['--rollback', '--rollback'], app), /Duplicate supervisor option/);
  assert.equal(resolveSupervisorRoot(parseSupervisorOptions([], app), {}, homedir()).endsWith('/.job-apply'), true);
});

test('Companion prepares empty and initialized Stores for native activation, then restarts native', { timeout: 60_000 }, async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const parent = await realpath(fixture.root), provider = loadPosixFlockProvider(fixture.receipt.artifact);
  for (const name of ['empty', 'initialized']) {
    const root = join(parent, name);
    if (name === 'initialized') await mkdir(root, { mode: 0o700 });
    const prepared = await prepareNativeDefault(root, provider, { now: () => '2026-09-15T00:00:00Z' });
    assert.equal(prepared.mode, 'python');
    assert.equal(JSON.parse(await readFile(join(root, 'jobs.json'), 'utf8')).schemaVersion, 1);
    await activateNativeWriter(root, prepared.candidate, { provider });
    const restarted = await prepareNativeDefault(root, provider, { now: () => '2026-09-15T00:00:00Z' });
    assert.equal(restarted.mode, 'native');
    assert.equal(await readFile(join(root, '.native-store-clone'), 'utf8').then(Boolean), true);
  }
});

test('Companion refuses a live detached attempt before activation or rollback', { timeout: 60_000 }, async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const root = join(await realpath(fixture.root), 'attempt');
  await prepareNativeDefault(root, loadPosixFlockProvider(fixture.receipt.artifact));
  await writeFile(join(root, '.job-apply-attempt.pid'), `${process.pid}\n`, { mode: 0o600 });
  await assert.rejects(assertNoLiveDetachedAttempt(root), /detached attempt broker is live/);
});

test('Companion fails native activation without creating a Python fallback', async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const root = join(await realpath(fixture.root), 'unavailable-native');
  await assert.rejects(runSupervisor({ root, pluginRoot: new URL('../', import.meta.url).pathname,
    port: 0, nativeLock: join(root, 'missing.node'), dev: false, rollback: false }));
  await assert.rejects(stat(root), { code: 'ENOENT' });
});

test('no-flag launcher delegates failure to the native supervisor without serving Python', async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const root = join(await realpath(fixture.root), 'launcher-failure');
  await assert.rejects(execute(process.execPath, ['apps/companion/launch.mjs', '--root', root,
    '--plugin-root', new URL('../', import.meta.url).pathname, '--native-lock', join(root, 'missing.node')], {
    cwd: new URL('../', import.meta.url).pathname, env: process.env,
  }), error => {
    assert.equal(error.code, 1); assert.equal(error.stdout, '');
    assert.equal(error.stderr, 'Companion native supervisor failed\n'); return true;
  });
  await assert.rejects(stat(root), { code: 'ENOENT' });
});
