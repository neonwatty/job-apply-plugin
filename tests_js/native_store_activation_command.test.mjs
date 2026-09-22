import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { packageNativeLock } from '../scripts/smoke/package_native_lock.mjs';
import { attemptSocketPath } from '../runtime/cli/attempt-protocol.js';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { initializeJobsFixture } from '../runtime/store/native-jobs-fixture.js';

const repository = new URL('../', import.meta.url).pathname;
async function installed(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'native-activation-command-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const plugin = join(home, 'plugin'); await mkdir(plugin);
  for (const path of ['apps/companion', 'runtime', 'native', 'package.json']) await cp(join(repository, path), join(plugin, path), { recursive: true });
  await packageNativeLock(plugin);
  return { home, plugin, root: join(home, '.job-apply'), command: join(plugin, 'apps/companion/command.mjs') };
}
function run(fixture, surface, args, environment = {}) {
  return spawnSync(process.execPath, [fixture.command, surface, ...args], { cwd: fixture.plugin, encoding: 'utf8',
    env: { HOME: fixture.home, PATH: '', ...environment } });
}
test('ordinary native command activates a fresh Store and then serves Store and task surfaces without Python', { timeout: 60_000 }, async t => {
  const fixture = await installed(t);
  const initialized = run(fixture, 'store', ['init']);
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(JSON.parse(initialized.stdout).initialized, true);
  assert.equal(JSON.parse(await readFile(join(fixture.root, '.native-store-clone'), 'utf8')).mode, 'canonical-store-clone');
  assert.ok((await readdir(fixture.home)).includes('.job-apply.python-rollback'));
  const snapshot = run(fixture, 'task', ['snapshot']);
  assert.equal(snapshot.status, 0, snapshot.stderr); assert.equal(JSON.parse(snapshot.stdout).ok, true);
  const lockPath = `${attemptSocketPath(fixture.root, process.getuid())}.lock`;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const handle = await open(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  const provider = loadPosixFlockProvider(join(fixture.plugin, 'native/packaged-lock', `${process.platform}-${process.arch}-napi8/flock.node`));
  assert.equal(provider.tryLock(handle.fd), true);
  try {
    const whileAttemptOwnsEndpoint = run(fixture, 'task', ['snapshot']);
    assert.equal(whileAttemptOwnsEndpoint.status, 0, whileAttemptOwnsEndpoint.stderr);
  } finally { provider.unlock(handle.fd); await handle.close(); }
  const resumePath = join(fixture.home, 'resume.txt'), input = join(fixture.home, 'resume.json');
  await writeFile(resumePath, 'Private resume bytes', { mode: 0o600 });
  await writeFile(input, JSON.stringify({ id: 'native-resume', label: 'Native resume', path: resumePath }), { mode: 0o600 });
  const imported = run(fixture, 'store', ['resume-import', '--input', input]);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(JSON.parse(imported.stdout).id, 'native-resume');
  assert.equal(imported.stdout.includes(resumePath), false);
});

test('ordinary native command clones and activates existing Python state without modifying rollback bytes', { timeout: 60_000 }, async t => {
  const fixture = await installed(t), input = join(fixture.home, 'job.json');
  await writeFile(input, '{"id":"python-job","role":"Existing job","url":"https://example.invalid/python-job"}', { mode: 0o600 });
  const python = spawnSync('python3', [join(fixture.plugin, 'scripts/job-apply-store.py'), '--root', fixture.root, 'job-create', '--input', input],
    { cwd: fixture.plugin, encoding: 'utf8' });
  // The minimal installed fixture deliberately omits Python; initialize the existing Store from the repository helper.
  if (python.status !== 0) {
    const source = join(repository, 'scripts/job-apply-store.py');
    const created = spawnSync('python3', [source, '--root', fixture.root, 'job-create', '--input', input], { cwd: repository, encoding: 'utf8' });
    assert.equal(created.status, 0, created.stderr);
  }
  const before = await readFile(join(fixture.root, 'jobs.json'));
  const listed = run(fixture, 'store', ['--root', fixture.root, 'job-list']);
  assert.equal(listed.status, 0, listed.stderr); assert.equal(JSON.parse(listed.stdout)[0].id, 'python-job');
  assert.deepEqual(await readFile(join(`${fixture.root}.python-rollback`, 'jobs.json')), before);
  assert.equal(JSON.parse(await readFile(join(fixture.root, '.native-store-clone'), 'utf8')).mode, 'canonical-store-clone');
});

test('paths and absent policy status remain non-creating reads', { timeout: 60_000 }, async t => {
  const fixture = await installed(t);
  const paths = run(fixture, 'store', ['paths']); assert.equal(paths.status, 0, paths.stderr);
  const status = run(fixture, 'policy', ['status']); assert.equal(status.status, 0, status.stderr);
  await assert.rejects(realpath(fixture.root), { code: 'ENOENT' });
});

test('ordinary command accepts an explicitly initialized native QA fixture without cloning it', { timeout: 60_000 }, async t => {
  const fixture = await installed(t);
  await initializeJobsFixture(fixture.root);
  const inspected = run(fixture, 'store', ['--root', fixture.root, 'profile-inspect']);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).revision, 1);
  assert.equal((await readdir(fixture.root)).includes('.native-jobs-fixture'), true);
  assert.equal((await readdir(fixture.root)).includes('.native-store-clone'), false);
  const alias = join(fixture.home, 'fixture-alias');
  await symlink(fixture.root, alias);
  const symlinked = run(fixture, 'store', ['--root', alias, 'profile-inspect']);
  assert.equal(symlinked.status, 2);
  assert.match(symlinked.stderr, /activation failed/);
  await writeFile(join(fixture.root, '.native-jobs-fixture'), '{"mode":"native-jobs-fixture","version":11}\n', { mode: 0o600 });
  const rejected = run(fixture, 'store', ['--root', fixture.root, 'profile-inspect']);
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /activation failed/);
});
