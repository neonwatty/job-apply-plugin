import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
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
  assert.equal(createNativeStoreBootstrap(`~${userInfo().username}/explicit`, undefined, {}, '/synthetic-home').root,
    '/synthetic-home/explicit');
  const lexical = createNativeStoreBootstrap('a/../b', undefined, {}, '/synthetic-home');
  assert.equal(plain(lexical.paths()).root, 'a/../b');
  assert.equal(plain(lexical.paths()).profile, 'a/../b/profile.json');
  assert.equal(plain(createNativeStoreBootstrap('a//./b/', undefined, {}, '/synthetic-home').paths()).root, 'a/b');
  const named = `~${userInfo().username}/job-apply-store`;
  const namedLegacy = join(tmpdir(), 'legacy');
  assert.deepEqual(plain(createNativeStoreBootstrap(named, namedLegacy).paths()), pythonCli(named, namedLegacy, 'paths'));
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

test('init accepts legacy pending fields without mutating stored session bytes', async t => {
  const { root, legacy } = await fixture(t);
  const service = new NativeStoreBootstrap(root, legacy, { clock: () => '2026-09-15T18:00:00Z' });
  await service.initialize();
  const session = JSON.stringify({ schemaVersion: 1, applicationId: 'legacy-job', status: 'active',
    ats: 'linkedin', answerKeys: [], pendingFields: [{ question: 'Legacy question', state: 'missing',
      answerKey: null, sensitive: false }], createdAt: 'old', updatedAt: 'old' }) + '\n';
  const path = join(root, 'sessions', 'legacy-job.json');
  await writeFile(path, session, { mode: 0o600 });

  await service.initialize();

  assert.equal(await readFile(path, 'utf8'), session);
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

test('init repairs a torn history tail and replays a pending coordinator claim journal', async t => {
  const { root, legacy } = await fixture(t);
  const now = '2026-09-15T18:00:00Z';
  const service = new NativeStoreBootstrap(root, legacy, { clock: () => now });
  await service.initialize();
  const claim = { claimId: 'claim-one', jobId: 'job-one', ownerLabel: 'Owner',
    tokenHash: createHash('sha256').update('token').digest('hex'), acquiredAt: now, heartbeatAt: now,
    expiresAt: '2026-09-15T18:05:00Z' };
  const historyEvent = { schemaVersion: 1, eventId: 'event-one', applicationId: 'job-one',
    event: 'claim-recovered', company: null, role: null, ats: null, status: 'in_progress', answerKeys: [], at: now };
  await writeFile(join(root, 'coordinator.json'), JSON.stringify({ schemaVersion: 1, claim: null }), { mode: 0o600 });
  await writeFile(join(root, 'coordinator-journal.json'), JSON.stringify({ schemaVersion: 1, operation: {
    kind: 'recover', operationId: 'recover-one', jobId: 'job-one', at: now, historyEvent, resultClaim: claim,
  } }), { mode: 0o600 });
  await writeFile(join(root, 'applications.jsonl'), '{"torn"', { mode: 0o600 });
  await service.initialize();
  assert.deepEqual(JSON.parse(await readFile(join(root, 'coordinator.json'), 'utf8')).claim, claim);
  assert.equal(JSON.parse(await readFile(join(root, 'coordinator-journal.json'), 'utf8')).operation, null);
  assert.deepEqual((await readFile(join(root, 'applications.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse), [historyEvent]);
});

test('init restores referenced managed resume bytes from a Python quarantine', async t => {
  const { root, legacy } = await fixture(t);
  const now = '2026-09-15T18:00:00Z', bytes = Buffer.from('resume bytes');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const service = new NativeStoreBootstrap(root, legacy, { clock: () => now });
  await service.initialize();
  const record = { id: 'resume', label: 'Resume', storageKind: 'managed', managedFile: 'resume.txt',
    originalFilename: 'resume.txt', mediaType: 'text/plain; charset=utf-8', digest,
    contentRevision: `content_${'a'.repeat(32)}`, tags: [], default: true, observedSize: bytes.length,
    observedModifiedAt: now, revision: 1, createdAt: now, updatedAt: now, deletedAt: null };
  await writeFile(join(root, 'resumes.json'), JSON.stringify({ schemaVersion: 1, resumes: { resume: record },
    metadata: { createdAt: now, updatedAt: now } }), { mode: 0o600 });
  const quarantine = join(root, 'resume-files', `.resume.txt.${'b'.repeat(32)}.quarantine`);
  await writeFile(quarantine, bytes, { mode: 0o600 });
  const staged = join(root, 'resume-files', '.resume.interrupted.tmp');
  const orphan = join(root, 'resume-files', 'orphan.txt');
  await writeFile(staged, 'partial', { mode: 0o600 });
  await writeFile(orphan, 'orphan', { mode: 0o600 });
  await service.initialize();
  assert.deepEqual(await readFile(join(root, 'resume-files/resume.txt')), bytes);
  await assert.rejects(lstat(quarantine), { code: 'ENOENT' });
  await assert.rejects(lstat(staged), { code: 'ENOENT' });
  await assert.rejects(lstat(orphan), { code: 'ENOENT' });
});

test('unsupported resume operation schema blocks initialization before recovery writes', async t => {
  const { root, legacy } = await fixture(t);
  const service = new NativeStoreBootstrap(root, legacy);
  await service.initialize();
  const journal = '{"schemaVersion":999,"operation":null}\n';
  const journalPath = join(root, 'resume-operation.json');
  await writeFile(journalPath, journal, { mode: 0o600 });
  const entries = await readdir(root);
  await assert.rejects(service.initialize(), /resume recovery schema version is unsupported/);
  assert.deepEqual(await readdir(root), entries);
  assert.equal(await readFile(journalPath, 'utf8'), journal);

  const orphan = join(root, 'resume-files', 'orphan.txt');
  await writeFile(orphan, 'must remain', { mode: 0o600 });
  await assert.rejects(service.initialize(), /resume recovery schema version is unsupported/);
  assert.equal(await readFile(orphan, 'utf8'), 'must remain');
  assert.equal(await readFile(journalPath, 'utf8'), journal);
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

test('init reruns preflight when a private root appears after absent-root preflight', async t => {
  const { root, legacy } = await fixture(t);
  const service = new NativeStoreBootstrap(root, legacy, { boundary: async stage => {
    if (stage !== 'preflight-complete') return;
    await mkdir(root, { mode: 0o700 });
    await writeFile(join(root, 'profile.json'), '{broken\n', { mode: 0o600 });
  } });
  await assert.rejects(service.initialize(), /profile|JSON/);
  assert.deepEqual(await readdir(root), ['profile.json']);
});
