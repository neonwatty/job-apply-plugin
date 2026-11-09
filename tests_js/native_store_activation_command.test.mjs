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

test('activation accepts owned read/searchable parents without changing their permissions', { timeout: 60_000 }, async t => {
  const fixture = await installed(t);
  const { chmod, stat } = await import('node:fs/promises');
  for (const mode of [0o700, 0o750, 0o755]) {
    const parent = join(fixture.home, `parent-${mode}`); await mkdir(parent, { mode }); await chmod(parent, mode);
    const root = join(parent, 'store');
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = run(fixture, 'store', ['--root', root, 'init']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal((await stat(parent)).mode & 0o777, mode);
      assert.equal((await stat(root)).mode & 0o777, 0o700);
    }
  }
  for (const mode of [0o770, 0o777]) {
    const parent = join(fixture.home, `unsafe-${mode}`); await mkdir(parent); await chmod(parent, mode);
    const root = join(parent, 'store');
    assert.equal(run(fixture, 'store', ['--root', root, 'init']).status, 2);
    await assert.rejects(realpath(root), { code: 'ENOENT' });
  }
});

test('public initialization imports the selected legacy profile and preserves an existing canonical profile', async t => {
  const fixture = await installed(t), selected = join(fixture.home, 'selected.json');
  const defaultLegacy = join(fixture.home, '.claude-job-profile.json');
  await mkdir(dirname(defaultLegacy), { recursive: true });
  await writeFile(defaultLegacy, '{"name":"Wrong default"}', { mode: 0o600 });
  await writeFile(selected, '{"name":"Selected applicant"}', { mode: 0o600 });
  const args = ['--root', fixture.root, '--legacy-profile', selected, 'init'];
  assert.equal(run(fixture, 'store', args).status, 0);
  const profile = JSON.parse(await readFile(join(fixture.root, 'profile.json'), 'utf8'));
  assert.equal(profile.profile.name, 'Selected applicant');
  await writeFile(selected, '{"name":"Later legacy edit"}', { mode: 0o600 });
  assert.equal(run(fixture, 'store', args).status, 0);
  assert.deepEqual(JSON.parse(await readFile(join(fixture.root, 'profile.json'), 'utf8')), profile);
});

test('attempt equals and abbreviated roots activate only the selected Store', async t => {
  const fixture = await installed(t);
  for (const option of ['--root=', '--roo=']) {
    const selected = join(fixture.home, `selected-${option.length}`);
    const result = run(fixture, 'attempt', [`${option}${selected}`, 'heartbeat']);
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).error.code, 'attempt_unavailable');
    assert.equal(JSON.parse(await readFile(join(selected, '.native-store-clone'), 'utf8')).mode, 'canonical-store-clone');
    await assert.rejects(realpath(fixture.root), { code: 'ENOENT' });
    await assert.rejects(realpath(`${fixture.root}.python-rollback`), { code: 'ENOENT' });
  }
});

test('invalid attempt options preserve the native JSON envelope without activating any Store', async t => {
  const fixture = await installed(t);
  const selected = join(fixture.home, 'selected-invalid');
  const result = run(fixture, 'attempt', [`--root=${selected}`, 'heartbeat', '--unknown']);
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).error.code, 'invalid_invocation');
  assert.equal(result.stderr, '');
  await assert.rejects(realpath(fixture.root), { code: 'ENOENT' });
  await assert.rejects(realpath(selected), { code: 'ENOENT' });
});

test('paths with an explicit legacy source remains non-creating', async t => {
  const fixture = await installed(t), selected = join(fixture.home, 'legacy.json');
  await writeFile(selected, '{"name":"Synthetic legacy"}', { mode: 0o600 });
  const result = run(fixture, 'store', ['--legacy-profile', selected, 'paths']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).legacyProfile, selected);
  await assert.rejects(realpath(fixture.root), { code: 'ENOENT' });
});
