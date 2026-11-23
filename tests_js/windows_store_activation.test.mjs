import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { activateWindowsStoreScoped } from '../runtime/store/windows-activation.js';
import { copyWindowsStoreForMigration, rollbackWindowsStoreMigration } from '../runtime/store/windows-store-migration.js';
import { openWindowsStoreFile, withWindowsStore } from '../runtime/store/windows-store.js';

// Windows activation and explicit migration use the packaged lock without Python.
const command = fileURLToPath(new URL('../apps/companion/command.mjs', import.meta.url));
const windows = process.platform === 'win32';
const addonPath = fileURLToPath(new URL('../native/packaged-lock/win32-x64-napi8/flock.node', import.meta.url));
const loadAddon = () => createRequire(import.meta.url)(addonPath);

function cli(home, ...args) {
  const result = spawnSync(process.execPath, [command, ...args], {
    cwd: home, encoding: 'utf8', timeout: 60_000, windowsHide: true,
    // An isolated home keeps the developer's legacy profile and default Store out of the test.
    env: { ...process.env, USERPROFILE: home, HOME: home, JOB_APPLY_STORE_DIR: '' },
  });
  assert.ifError(result.error);
  return result;
}
function grantInheritedRead(path) {
  const result = spawnSync('icacls.exe', [path, '/grant', '*S-1-1-0:(R)'], { encoding: 'utf8', windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
const json = result => {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
};
async function snapshot(root) {
  const entries = {};
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    entries[entry.name] = entry.isDirectory() ? 'directory' : (await readFile(join(root, entry.name))).toString('base64');
  }
  return entries;
}

test('Windows CLI creates a fresh native Store and reopens it', { skip: !windows, timeout: 120_000 }, async t => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'job-apply-activation-')));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const addon = loadAddon();
  const root = join(temporary, 'store'), input = join(temporary, 'job.json');
  const legacyProfile = join(temporary, '.claude-job-profile.json');
  const legacyBytes = '{"name":"Legacy profile"}\n';
  await writeFile(legacyProfile, legacyBytes);
  grantInheritedRead(legacyProfile);

  const initialized = json(cli(temporary, 'store', 'init', '--root', root));
  assert.equal(initialized.root, root);
  assert.equal(initialized.migratedLegacyProfile, false);
  assert.equal(await readFile(legacyProfile, 'utf8'), legacyBytes);
  const entries = await readdir(root);
  assert.ok(entries.includes('.native-store-clone'));
  assert.ok(!entries.includes('.native-store-pending'));
  const marker = JSON.parse(await readFile(join(root, '.native-store-clone'), 'utf8'));
  assert.equal(marker.mode, 'canonical-store-clone');
  assert.match(marker.candidateTree, /^sha256:[0-9a-f]{64}$/);
  // Nothing is written beside the Store: no candidate, retained or rollback directories.
  assert.deepEqual((await readdir(temporary)).sort(), ['.claude-job-profile.json', 'store']);

  await writeFile(input, JSON.stringify({ id: 'job', url: 'https://example.invalid/job', role: 'Engineer', company: 'Synthetic', ats: 'greenhouse' }));
  assert.equal(json(cli(temporary, 'store', 'job-create', '--root', root, '--input', input)).id, 'job');
  const marked = await readFile(join(root, '.native-store-clone'));

  // A second process reopens the validated native Store without re-initializing it.
  assert.deepEqual(json(cli(temporary, 'store', 'job-list', '--root', root)).map(job => job.id), ['job']);
  assert.deepEqual(await readFile(join(root, '.native-store-clone')), marked);
  assert.equal(json(cli(temporary, 'store', 'init', '--root', root)).root, root);
  assert.deepEqual(json(cli(temporary, 'store', 'job-list', '--root', 'STORE')).map(job => job.id), ['job']);
  assert.equal(json(cli(temporary, 'store', 'paths', '--root', 'STORE')).root, root);
  assert.deepEqual(json(cli(temporary, 'policy', '--root', 'STORE', 'status')),
    json(cli(temporary, 'policy', '--root', root, 'status')));
  const alias = join(temporary, 'alias');
  await symlink(root, alias, 'junction');
  const aliasedStore = cli(temporary, 'store', 'job-list', '--root', alias);
  assert.equal(aliasedStore.status, 2);
  const aliasedAttempt = cli(temporary, 'attempt', '--root', alias, 'heartbeat');
  assert.equal(aliasedAttempt.status, 2);
  assert.equal(aliasedAttempt.stderr, aliasedStore.stderr);
  assert.equal(aliasedAttempt.stdout, '');

  // Ordinary reopen waits for the current Store writer's staged file to disappear.
  await withWindowsStore(root, addonPath, async provider => {
    const lock = await openWindowsStoreFile(join(root, '.store.lock'), constants.O_RDWR);
    const stage = join(root, '.jobs.json.12345678.tmp');
    assert.equal(provider.tryLock(lock.fd), true);
    addon.createStoreEntry(stage, false);
    const attempt = Promise.withResolvers();
    const reopening = activateWindowsStoreScoped(root, {
      tryLock(fd) {
        const acquired = provider.tryLock(fd);
        attempt.resolve(acquired);
        return acquired;
      },
      unlock: provider.unlock,
    });
    try {
      assert.equal(await Promise.race([attempt.promise, reopening]), false);
    } finally {
      await unlink(stage);
      try { provider.unlock(lock.fd); } finally { await lock.close(); }
    }
    assert.equal((await reopening).state, 'reopened');
  });

  // A stopped writer can leave an unpublished atomic write beside the installed document.
  const abandoned = join(root, '.jobs.json.87654321.tmp');
  const committed = await readFile(join(root, 'jobs.json'));
  addon.createStoreEntry(abandoned, false);
  await writeFile(abandoned, '{"unpublished":true}');
  const unknown = join(root, 'unrecognized.json');
  addon.createStoreEntry(unknown, false);
  const beforeRefusal = await snapshot(root);
  assert.equal(cli(temporary, 'store', 'job-list', '--root', root).status, 2);
  assert.deepEqual(await snapshot(root), beforeRefusal, 'unknown roots are never cleaned');
  await unlink(unknown);
  assert.deepEqual(json(cli(temporary, 'store', 'job-list', '--root', root)).map(job => job.id), ['job']);
  assert.deepEqual(await readFile(join(root, 'jobs.json')), committed);
  assert.ok(!(await readdir(root)).includes('.jobs.json.87654321.tmp'));

  const unsafeStage = join(root, '.jobs.json.12345678.tmp');
  addon.createStoreEntry(unsafeStage, false);
  grantInheritedRead(unsafeStage);
  const beforeUnsafeStage = await snapshot(root);
  assert.equal(cli(temporary, 'store', 'job-list', '--root', root).status, 2);
  assert.deepEqual(await snapshot(root), beforeUnsafeStage, 'recovery requires private staging');
  await unlink(unsafeStage);

  assert.equal(cli(temporary, 'task', '--ro', root, 'snapshot').status, 0);
  assert.ok(!(await readdir(temporary)).includes('.job-apply'), 'the router activates the parsed task root');
  for (const args of [['legacy-jobs-preview'], ['--select', 'report-id', 'legacy-jobs-preview']]) {
    const reports = cli(temporary, 'store', ...args);
    assert.equal(reports.status, 2);
    assert.match(reports.stderr, /Legacy search report import is available on macOS and Linux/);
  }
  for (const args of [['--select', 'paths'], ['--input', 'legacy-jobs-preview', 'unknown-command']]) {
    const invalidStore = cli(temporary, 'store', ...args);
    assert.equal(invalidStore.status, 2);
    assert.match(invalidStore.stderr, /unsupported native Jobs command or option/);
  }
  assert.ok(!(await readdir(temporary)).includes('.job-apply'));

  // An interruption after marker publication leaves the completed Store and its data authoritative.
  const beforePending = await snapshot(root);
  addon.createStoreEntry(join(root, '.native-store-pending'), false);
  assert.deepEqual(json(cli(temporary, 'store', 'job-list', '--root', root)).map(job => job.id), ['job']);
  assert.deepEqual(await snapshot(root), beforePending);

  const interrupted = join(temporary, 'interrupted');
  addon.createStoreEntry(interrupted, true);
  addon.createStoreEntry(join(interrupted, '.store.lock'), false);
  assert.equal(json(cli(temporary, 'store', 'init', '--root', interrupted)).root, interrupted);
  assert.ok((await readdir(interrupted)).includes('.native-store-clone'));

  // Bootstrap can resume partial initialization in place, even after adopting missing journals.
  const optedIn = join(temporary, 'opted-in');
  const explicitProfile = join(temporary, 'private-profile.json');
  addon.createStoreEntry(explicitProfile, false);
  await writeFile(explicitProfile, legacyBytes);
  const importArgs = ['store', 'init', '--root', optedIn, '--legacy-profile', 'private-profile.json'];
  assert.equal(json(cli(temporary, ...importArgs)).migratedLegacyProfile, true);
  assert.equal(json(cli(temporary, ...importArgs)).migratedLegacyProfile, false);
  const imported = await readFile(join(optedIn, 'profile.json'));
  assert.equal(JSON.parse(imported).profile.name, 'Legacy profile');
  const partial = join(temporary, 'partial');
  addon.createStoreEntry(partial, true);
  for (const name of ['.store.lock', '.native-store-pending', 'profile.json', 'resume-operation.json']) {
    addon.createStoreEntry(join(partial, name), false);
  }
  await writeFile(join(partial, 'profile.json'), imported);
  await writeFile(join(partial, 'resume-operation.json'), '{"schemaVersion":1,"operation":null}\n');
  for (const name of ['.profile.json.12345678.tmp', '..native-store-clone.87654321.tmp']) {
    const stage = join(partial, name);
    addon.createStoreEntry(stage, false);
    await writeFile(stage, 'unfinished initialization write');
  }
  json(cli(temporary, 'store', 'init', '--root', partial));
  assert.deepEqual(await readFile(join(partial, 'profile.json')), imported);
  assert.equal((await readdir(partial)).some(name => name.endsWith('.tmp')), false);

  const recovery = JSON.parse(imported);
  recovery.profile = { recovered: true };
  recovery.metadata.revision += 1;
  const journal = join(partial, 'resume-extraction-journal.json');
  await writeFile(journal, JSON.stringify({ schemaVersion: 1, operation: {
    kind: 'review', operationId: 'recovery-one', profileDocument: recovery, proposalsDocument: null,
  } }));
  json(cli(temporary, 'store', 'init', '--root', partial));
  assert.deepEqual(JSON.parse(await readFile(join(partial, 'profile.json'), 'utf8')).profile, { recovered: true });
  assert.equal(JSON.parse(await readFile(journal, 'utf8')).operation, null);
});

test('Windows CLI leaves legacy and unrecognized Store data untouched', { skip: !windows, timeout: 120_000 }, async t => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'job-apply-legacy-')));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const legacy = join(temporary, 'legacy');
  await mkdir(join(legacy, 'sessions'), { recursive: true });
  // The shape a Python-era Store leaves behind, without a native ownership marker.
  await writeFile(join(legacy, 'jobs.json'), '{"schemaVersion": 1, "jobs": {"python": {}}, "metadata": {}}\n');
  await writeFile(join(legacy, 'profile.json'), '{"schemaVersion": 1, "profile": {"name": "PRIVATE"}}\n');
  await writeFile(join(legacy, '.store.lock'), '');
  const before = await snapshot(legacy);

  for (const args of [
    ['store', 'init', '--root', legacy],
    ['store', 'job-list', '--root', legacy],
    ['task', '--root', legacy, 'snapshot'],
  ]) {
    const result = cli(temporary, ...args);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, /not a native Job Apply Store\. It was left unchanged\./);
    assert.match(result.stderr, /--root or JOB_APPLY_STORE_DIR/);
    assert.doesNotMatch(result.stderr + result.stdout, /PRIVATE/);
    assert.deepEqual(await snapshot(legacy), before);
    assert.deepEqual(await readdir(join(legacy, 'sessions')), []);
  }
  const invalidTask = cli(temporary, 'task', 'snapshot', '--root', legacy);
  assert.equal(invalidTask.status, 2);
  assert.equal(JSON.parse(invalidTask.stdout).error.code, 'invalid_request');
  assert.deepEqual(await snapshot(legacy), before);

  // The guidance works: a separate root next to it becomes a fresh native Store.
  const separate = join(temporary, 'separate');
  assert.equal(json(cli(temporary, 'store', 'init', '--root', separate)).root, separate);
  assert.deepEqual(await snapshot(legacy), before);

  const empty = join(temporary, 'empty');
  await mkdir(empty);
  grantInheritedRead(empty);
  const emptyResult = cli(temporary, 'store', 'init', '--root', empty);
  assert.equal(emptyResult.status, 2);
  assert.match(emptyResult.stderr, /accessible only to your account.*path that does not exist yet/);
  assert.deepEqual(await readdir(empty), []);

  const addon = loadAddon();
  const corrupt = join(temporary, 'corrupt');
  const corruptMarker = join(corrupt, '.native-store-clone');
  addon.createStoreEntry(corrupt, true);
  addon.createStoreEntry(corruptMarker, false);
  await writeFile(corruptMarker, '{}\n');
  assert.equal(cli(temporary, 'store', 'init', '--root', corrupt).status, 2);
  assert.deepEqual(await readdir(corrupt), ['.native-store-clone']);
  assert.equal(await readFile(corruptMarker, 'utf8'), '{}\n');

  const unknown = join(temporary, 'unknown');
  const foreign = join(unknown, 'other.json');
  addon.createStoreEntry(unknown, true);
  addon.createStoreEntry(join(unknown, '.store.lock'), false);
  addon.createStoreEntry(join(unknown, '.native-store-pending'), false);
  addon.createStoreEntry(foreign, false);
  await writeFile(foreign, 'Unrecognized data');
  const unknownBefore = await snapshot(unknown);
  assert.equal(cli(temporary, 'store', 'init', '--root', unknown).status, 2);
  assert.deepEqual(await snapshot(unknown), unknownBefore);
});

const legacyFixtureFiles = ['profile.json', 'answers.json', 'applications.jsonl', 'sessions/legacy-application.json'];
async function prepareLegacyFixture(source) {
  const addon = loadAddon();
  const fixture = new URL('../test/fixtures/python-store-v1.1.0/store/', import.meta.url);
  addon.createStoreEntry(source, true);
  addon.createStoreEntry(join(source, 'sessions'), true);
  addon.createStoreEntry(join(source, '.store.lock'), false);
  for (const name of legacyFixtureFiles) {
    const path = join(source, ...name.split('/'));
    addon.createStoreEntry(path, false);
    await writeFile(path, await readFile(new URL(name, fixture)));
  }
}

async function migrationSnapshot(root) {
  return [await snapshot(root), await snapshot(join(root, 'sessions'))];
}

test('Windows migration check validates an explicit legacy Store without activating it', {
  skip: !windows, timeout: 120_000,
}, async t => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'job-apply-migration-check-')));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = join(temporary, 'legacy');
  await prepareLegacyFixture(source);
  const addon = loadAddon();
  const sourceSnapshot = () => migrationSnapshot(source);
  const runCheck = (path = source) => cli(temporary, 'migration', 'check', '--source', path);
  const expectRefusal = async path => {
    const before = await sourceSnapshot();
    const refused = runCheck(path);
    assert.equal(refused.status, 2);
    assert.equal(refused.stdout, '');
    assert.match(refused.stderr, /could not be verified.*left unchanged/);
    assert.doesNotMatch(refused.stderr, /SYNTHETIC_PRIVATE_VALUE/);
    assert.deepEqual(await sourceSnapshot(), before);
  };

  const original = await sourceSnapshot();
  assert.deepEqual(json(runCheck()), { schemaVersion: 1, status: 'source-checked' });
  assert.deepEqual(await sourceSnapshot(), original);
  assert.deepEqual(await readdir(temporary), ['legacy']);

  const marker = join(source, '.native-store-clone');
  addon.createStoreEntry(marker, false);
  await writeFile(marker, '{}\n');
  await expectRefusal(source);
  await unlink(marker);

  const profile = join(source, 'profile.json');
  const validProfile = await readFile(profile);
  await writeFile(profile, '{"schemaVersion":999,"profile":{"name":"SYNTHETIC_PRIVATE_VALUE"}}');
  await expectRefusal(source);
  await writeFile(profile, validProfile);

  const policy = join(source, 'auto-submit');
  addon.createStoreEntry(policy, true);
  await expectRefusal(source);
  await rm(policy, { recursive: true });

  const resumeFiles = join(source, 'resume-files');
  const orphan = join(resumeFiles, '.browser-upload.12345678.txt');
  addon.createStoreEntry(resumeFiles, true);
  addon.createStoreEntry(orphan, false);
  await writeFile(orphan, 'Unpublished legacy upload');
  await expectRefusal(source);
  const target = join(temporary, 'unused-native');
  assert.equal(cli(temporary, 'migration', 'copy', '--source', source, '--target', target).status, 2);
  assert.equal(await readFile(orphan, 'utf8'), 'Unpublished legacy upload');
  assert.ok(!(await readdir(temporary)).includes('unused-native'));
  await rm(resumeFiles, { recursive: true });

  const alias = join(temporary, 'alias');
  await symlink(source, alias, 'junction');
  await expectRefusal(alias);
  assert.ok((await readdir(temporary)).includes('alias'));

  await unlink(join(source, '.store.lock'));
  await expectRefusal(source);
  assert.ok(!(await readdir(source)).includes('.store.lock'));
});

test('Windows publishes a verified migration copy that opens independently of the legacy Store', {
  skip: !windows, timeout: 120_000,
}, async t => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'job-apply-migration-copy-')));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = join(temporary, 'legacy'), target = join(temporary, 'native');
  await prepareLegacyFixture(source);
  const addon = loadAddon(), resumeFile = join('resume-files', 'legacy-resume.txt');
  addon.createStoreEntry(join(source, 'resume-files'), true);
  addon.createStoreEntry(join(source, resumeFile), false);
  await writeFile(join(source, resumeFile), 'Synthetic résumé');
  const original = await migrationSnapshot(source);
  const runCopy = path => cli(temporary, 'migration', 'copy', '--source', source, '--target', path);
  assert.equal(runCopy(join(source, 'nested')).status, 2);
  assert.deepEqual(await migrationSnapshot(source), original);

  assert.deepEqual(json(runCopy(target)), { schemaVersion: 1, status: 'copy-ready' });
  for (const name of [...legacyFixtureFiles, resumeFile]) {
    assert.deepEqual(await readFile(join(target, name)), await readFile(join(source, name)), name);
  }
  const marker = JSON.parse(await readFile(join(target, '.native-store-clone'), 'utf8'));
  assert.equal(marker.mode, 'canonical-store-clone');
  assert.match(marker.sourceTree, /^sha256:[a-f0-9]{64}$/);
  assert.match(marker.candidateTree, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(json(cli(temporary, 'store', 'job-list', '--root', target)), []);

  const input = join(temporary, 'job.json');
  await writeFile(input, JSON.stringify({ id: 'after-migration', url: 'https://example.invalid/migrated-job', role: 'Synthetic' }));
  assert.equal(json(cli(temporary, 'store', 'job-create', '--root', target, '--input', input)).id, 'after-migration');
  const migrated = await migrationSnapshot(target);
  assert.equal(runCopy(target).status, 2, 'a retry must preserve an existing target');
  assert.deepEqual(await migrationSnapshot(target), migrated);
  assert.deepEqual(await migrationSnapshot(source), original);
  assert.deepEqual((await readdir(temporary)).sort(), ['job.json', 'legacy', 'native']);
});

test('Windows migration cancellation, source drift, and target collisions leave the original usable', {
  skip: !windows, timeout: 120_000,
}, async t => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'job-apply-migration-interrupted-')));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = join(temporary, 'legacy'), target = join(temporary, 'native');
  await prepareLegacyFixture(source);
  const original = await migrationSnapshot(source);
  const controller = new AbortController();
  const interrupted = new Error('Interrupted migration');
  await assert.rejects(copyWindowsStoreForMigration(source, target, addonPath, {
    signal: controller.signal,
    beforePublish: async () => controller.abort(interrupted),
  }), interrupted);
  assert.deepEqual(await readdir(temporary), ['legacy']);
  assert.deepEqual(await migrationSnapshot(source), original);

  const profile = join(source, 'profile.json');
  const bytes = await readFile(profile);
  await assert.rejects(copyWindowsStoreForMigration(source, target, addonPath, {
    beforePublish: () => writeFile(profile, Buffer.concat([bytes, Buffer.from('\n')])),
  }), /legacy Store changed/);
  assert.deepEqual(await readdir(temporary), ['legacy']);
  await writeFile(profile, bytes);

  const collision = join(target, 'keep.txt');
  await assert.rejects(copyWindowsStoreForMigration(source, target, addonPath, {
    beforePublish: async () => {
      await mkdir(target);
      await writeFile(collision, 'existing destination');
    },
  }), /migration target already exists/);
  assert.equal(await readFile(collision, 'utf8'), 'existing destination');
  assert.deepEqual((await readdir(temporary)).sort(), ['legacy', 'native']);
  assert.deepEqual(await migrationSnapshot(source), original);
  await rm(target, { recursive: true });

  assert.deepEqual(json(cli(temporary, 'migration', 'copy', '--source', source, '--target', target)),
    { schemaVersion: 1, status: 'copy-ready' });
  assert.deepEqual(await migrationSnapshot(source), original);
});

test('Windows rollback restores the verified legacy snapshot and preserves post-migration edits', {
  skip: !windows, timeout: 120_000,
}, async t => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'job-apply-migration-rollback-')));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = join(temporary, 'legacy');
  const migrated = join(temporary, 'native'), recovery = join(temporary, 'recovery');
  await prepareLegacyFixture(source);
  const original = await migrationSnapshot(source);
  await copyWindowsStoreForMigration(source, migrated, addonPath);

  const input = join(temporary, 'job.json');
  await writeFile(input, JSON.stringify({ id: 'post-migration', url: 'https://example.invalid/post-migration', role: 'Synthetic' }));
  assert.equal(json(cli(temporary, 'store', 'job-create', '--root', migrated, '--input', input)).id, 'post-migration');
  const withEdits = await migrationSnapshot(migrated);
  const runRollback = (from = source, reference = migrated, target = recovery) =>
    cli(temporary, 'migration', 'rollback', '--source', from, '--migrated', reference, '--target', target);

  assert.equal(runRollback(source, migrated, join(migrated, 'nested')).status, 2);
  assert.equal(runRollback(migrated, migrated).status, 2);
  assert.equal(runRollback(source, source).status, 2);
  const receipt = join(migrated, '.native-store-clone');
  const receiptBytes = await readFile(receipt);
  await writeFile(receipt, '{"mode":"canonical-store-clone","version":2}');
  assert.equal(runRollback().status, 2, 'rollback requires a valid receipt');
  await writeFile(receipt, receiptBytes);

  const profile = join(source, 'profile.json');
  const profileBytes = await readFile(profile);
  await writeFile(profile, Buffer.concat([profileBytes, Buffer.from('\n')]));
  const drifted = await migrationSnapshot(source);
  assert.equal(runRollback().status, 2, 'rollback requires the exact source bytes');
  assert.deepEqual(await migrationSnapshot(source), drifted);
  await writeFile(profile, profileBytes);

  const controller = new AbortController();
  const interrupted = new Error('Interrupted rollback');
  await assert.rejects(rollbackWindowsStoreMigration(source, migrated, recovery, addonPath, {
    signal: controller.signal,
    beforePublish: async () => controller.abort(interrupted),
  }), interrupted);
  assert.deepEqual((await readdir(temporary)).sort(), ['job.json', 'legacy', 'native']);
  assert.deepEqual(await migrationSnapshot(source), original);
  assert.deepEqual(await migrationSnapshot(migrated), withEdits);

  assert.deepEqual(json(runRollback()), { schemaVersion: 1, status: 'recovery-ready' });
  for (const name of legacyFixtureFiles) {
    assert.deepEqual(await readFile(join(recovery, name)), await readFile(join(source, name)), name);
  }
  assert.deepEqual(json(cli(temporary, 'store', 'job-list', '--root', recovery)), []);
  assert.deepEqual(json(cli(temporary, 'store', 'job-list', '--root', migrated)).map(job => job.id), ['post-migration']);
  const recovered = await migrationSnapshot(recovery);
  assert.equal(runRollback().status, 2);
  assert.deepEqual(await migrationSnapshot(recovery), recovered);
  assert.deepEqual(await migrationSnapshot(source), original);
  assert.deepEqual(await migrationSnapshot(migrated), withEdits);
});
