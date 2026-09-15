import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createNativeStoreBootstrap, NativeStoreBootstrap, nativeStorePaths } from '../runtime/store/native-store-bootstrap.js';
import { nativeStoreBootstrapCommands, runNativeStoreBootstrapCommand } from '../runtime/cli/native-store-bootstrap.js';
import { serialize } from '../runtime/contracts/workspace/values.js';

const plain = value => JSON.parse(serialize(value));
const python = fileURLToPath(new URL('../scripts/job-apply-store.py', import.meta.url));
const pythonCli = (root, legacy, command) => {
  const run = spawnSync('python3.12', [python, '--root', root, '--legacy-profile', legacy, command], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
};
const fixture = async t => {
  const parent = await mkdtemp(join(tmpdir(), 'native-store-bootstrap-'));
  t.after(async () => (await import('node:fs/promises')).rm(parent, { recursive: true, force: true }));
  return { parent, root: join(parent, 'store'), legacy: join(parent, 'legacy.json') };
};
const keys = [
  'schemaVersion', 'root', 'profile', 'factGroups', 'answers', 'jobs', 'resumes',
  'resumeExtractionRequests', 'history', 'sessions', 'coordinator', 'coordinatorJournal',
  'automationSettings', 'employerAccounts', 'accountOperationJournal', 'trustedFill',
  'autoSubmitPolicy', 'legacyProfile',
];

test('paths projects the exact Python envelope without creating the root', async t => {
  const { root, legacy } = await fixture(t);
  const expected = {
    schemaVersion: 1, root, profile: join(root, 'profile.json'),
    factGroups: join(root, 'fact-groups.json'), answers: join(root, 'answers.json'),
    jobs: join(root, 'jobs.json'), resumes: join(root, 'resumes.json'),
    resumeExtractionRequests: join(root, 'resume-extraction-requests.json'),
    history: join(root, 'applications.jsonl'), sessions: join(root, 'sessions'),
    coordinator: join(root, 'coordinator.json'), coordinatorJournal: join(root, 'coordinator-journal.json'),
    automationSettings: join(root, 'automation-settings.json'), employerAccounts: join(root, 'employer-accounts.json'),
    accountOperationJournal: join(root, 'account-operation-journal.json'), trustedFill: join(root, 'trusted-fill.json'),
    autoSubmitPolicy: join(root, 'auto-submit'), legacyProfile: legacy,
  };
  assert.deepEqual(Object.keys(nativeStorePaths(root, legacy)), keys);
  const result = plain(await runNativeStoreBootstrapCommand('paths', new NativeStoreBootstrap(root, legacy)));
  assert.deepEqual(result, expected);
  assert.deepEqual(result, pythonCli(root, legacy, 'paths'));
  await assert.rejects(lstat(root), { code: 'ENOENT' });
  assert.deepEqual(nativeStoreBootstrapCommands, { init: [], paths: [] });
});

test('root selection matches Python precedence without resolving relative paths', () => {
  const environment = { JOB_APPLY_STORE_DIR: 'relative-store' };
  assert.equal(createNativeStoreBootstrap(undefined, undefined, environment, '/synthetic-home').root, 'relative-store');
  assert.equal(createNativeStoreBootstrap('~/explicit', '~/legacy', environment, '/synthetic-home').root, '/synthetic-home/explicit');
  assert.equal(createNativeStoreBootstrap(undefined, undefined, {}, '/synthetic-home').root, '/synthetic-home/.job-apply');
});

test('init creates the Python core privately and restarts idempotently', async t => {
  const { root, legacy } = await fixture(t);
  const clock = () => '2026-09-15T18:00:00Z';
  const service = new NativeStoreBootstrap(root, legacy, { clock });
  const first = plain(await runNativeStoreBootstrapCommand('init', service));
  assert.equal(first.initialized, true);
  assert.equal(first.migratedLegacyProfile, false);
  assert.deepEqual(Object.keys(first), ['initialized', 'migratedLegacyProfile', ...keys].sort());
  for (const path of [root, join(root, 'sessions'), join(root, 'resume-files')]) {
    assert.equal((await stat(path)).mode & 0o777, 0o700);
  }
  const documents = ['profile.json', 'answers.json', 'fact-groups.json', 'jobs.json', 'resumes.json'];
  for (const name of documents) assert.equal((await stat(join(root, name))).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, 'applications.jsonl'))).mode & 0o777, 0o600);
  const before = Object.fromEntries(await Promise.all(documents.map(async name => [name, await readFile(join(root, name), 'utf8')])));
  assert.deepEqual(plain(await service.initialize()), first);
  assert.deepEqual(Object.fromEntries(await Promise.all(documents.map(async name => [name, await readFile(join(root, name), 'utf8')]))), before);

  await unlink(join(root, 'answers.json'));
  assert.equal(plain(await service.initialize()).migratedLegacyProfile, false);
  assert.equal(JSON.parse(await readFile(join(root, 'answers.json'), 'utf8')).schemaVersion, 1);
});

test('init imports a valid legacy profile once with Python metadata', async t => {
  const { root, legacy } = await fixture(t);
  await writeFile(legacy, '{"firstName":"Ada","nested":{"ok":true},"large":9007199254740993}\n', { mode: 0o600 });
  const service = new NativeStoreBootstrap(root, legacy, { clock: () => '2026-09-15T18:00:00Z' });
  assert.equal(plain(await service.initialize()).migratedLegacyProfile, true);
  const profile = JSON.parse(await readFile(join(root, 'profile.json'), 'utf8'));
  assert.match(await readFile(join(root, 'profile.json'), 'utf8'), /9007199254740993/);
  delete profile.profile.large;
  assert.deepEqual(profile, { schemaVersion: 1, profile: { firstName: 'Ada', nested: { ok: true } }, metadata: {
    createdAt: '2026-09-15T18:00:00Z', factProvenance: {}, migratedAt: '2026-09-15T18:00:00Z',
    migratedFrom: '~/.claude-job-profile.json', revision: 1, updatedAt: '2026-09-15T18:00:00Z',
  } });
  await writeFile(legacy, '{"firstName":"Changed"}\n');
  assert.equal(plain(await service.initialize()).migratedLegacyProfile, false);
  assert.equal(JSON.parse(await readFile(join(root, 'profile.json'), 'utf8')).profile.firstName, 'Ada');
});

test('init rolls forward a Python-compatible pending extraction journal idempotently', async t => {
  const { root, legacy } = await fixture(t);
  const service = new NativeStoreBootstrap(root, legacy, { clock: () => '2026-09-15T18:00:00Z' });
  await service.initialize();
  const profile = JSON.parse(await readFile(join(root, 'profile.json'), 'utf8'));
  profile.profile = { recovered: true };
  profile.metadata.revision = 2;
  const journal = { schemaVersion: 1, operation: { kind: 'review', operationId: 'recovery-one',
    profileDocument: profile, proposalsDocument: null } };
  await writeFile(join(root, 'resume-extraction-journal.json'), JSON.stringify(journal), { mode: 0o600 });
  await service.initialize();
  assert.deepEqual(JSON.parse(await readFile(join(root, 'profile.json'), 'utf8')).profile, { recovered: true });
  assert.equal(JSON.parse(await readFile(join(root, 'resume-extraction-journal.json'), 'utf8')).operation, null);
  await service.initialize();
  assert.deepEqual(JSON.parse(await readFile(join(root, 'profile.json'), 'utf8')).profile, { recovered: true });
});

test('preflight rejects corrupt or unsafe existing state before writing', async t => {
  await t.test('corrupt JSON leaves a partial root byte-for-byte unchanged', async t => {
    const { root, legacy } = await fixture(t);
    await mkdir(root, { mode: 0o700 });
    await writeFile(join(root, 'profile.json'), '{broken\n', { mode: 0o600 });
    const before = await readdir(root);
    await assert.rejects(new NativeStoreBootstrap(root, legacy).initialize(), /profile|JSON/);
    assert.deepEqual(await readdir(root), before);
    assert.equal(await readFile(join(root, 'profile.json'), 'utf8'), '{broken\n');
  });
  for (const kind of ['symlink', 'loose', 'special']) await t.test(kind, async t => {
    const { root, legacy, parent } = await fixture(t);
    if (kind === 'symlink') {
      const target = join(parent, 'target'); await mkdir(target, { mode: 0o700 }); await symlink(target, root);
    } else {
      await mkdir(root, { mode: kind === 'loose' ? 0o755 : 0o700 });
      if (kind === 'special') await mkdir(join(root, 'profile.json'), { mode: 0o700 });
    }
    await assert.rejects(new NativeStoreBootstrap(root, legacy).initialize(), /private|directory|regular|link/);
    if (kind !== 'symlink') assert.deepEqual(await readdir(root), kind === 'special' ? ['profile.json'] : []);
  });
});

test('init refuses a root identity swap between preflight and mutation', async t => {
  const { root, legacy } = await fixture(t);
  await mkdir(root, { mode: 0o700 });
  const moved = `${root}.moved`;
  const service = new NativeStoreBootstrap(root, legacy, { boundary: async stage => {
    if (stage !== 'preflight-complete') return;
    await rename(root, moved);
    await mkdir(root, { mode: 0o700 });
  } });
  await assert.rejects(service.initialize(), /identity changed/);
  assert.deepEqual(await readdir(root), []);
  assert.deepEqual(await readdir(moved), []);
});

test('init refuses a symlink introduced after an absent-root preflight', async t => {
  const { root, legacy, parent } = await fixture(t);
  const target = join(parent, 'target');
  await mkdir(target, { mode: 0o700 });
  const service = new NativeStoreBootstrap(root, legacy, { boundary: async stage => {
    if (stage === 'preflight-complete') await symlink(target, root);
  } });
  await assert.rejects(service.initialize(), /directory without links/);
  assert.deepEqual(await readdir(target), []);
});
