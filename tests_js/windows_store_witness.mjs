import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { link, mkdir, readFile, readdir, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolvePosixPath } from '../runtime/contracts/posix-path.js';
import { canonicalJson } from '../runtime/contracts/workspace/canonical-json.js';
import { validateResumeReferences } from '../runtime/contracts/workspace/resume-reference.js';
import { fromJSON } from '../runtime/contracts/workspace/values.js';
import { withExclusiveFileLock } from '../runtime/store/exclusive-file-lock.js';
import { createNativeJsonlHistoryIO } from '../runtime/store/jsonl-history-io.js';
import { initializeJobsFixture, NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { createNativeStoreBootstrap, NativeStoreBootstrap } from '../runtime/store/native-store-bootstrap.js';
import { appendPointHistoryEvent, atomicWritePointJson } from '../runtime/store/point-persistence.js';
import { checkWindowsStoreWrite, openWindowsStoreFile, requireWindowsPrivate, windowsFileIdentity, windowsMetadata, withWindowsStore } from '../runtime/store/windows-store.js';
import { JobUpsertService } from '../runtime/workspace-core/job-upsert.js';

const [artifact, temporary] = process.argv.slice(2);
const addon = createRequire(import.meta.url)(artifact);
const options = { pathProfile: '3.12', intMaxStrDigits: 4300 };
const plain = value => JSON.parse(canonicalJson(value));
const now = () => '2026-11-20T00:00:00Z';

function grantRead(path, access) {
  const granted = spawnSync('icacls.exe', [path, '/grant', `*S-1-1-0:${access}`], {
    encoding: 'utf8', windowsHide: true, timeout: 5_000,
  });
  assert.ifError(granted.error);
  assert.equal(granted.status, 0, granted.stderr || granted.stdout);
}

const ordinaryParent = join(temporary, 'ordinary');
await mkdir(ordinaryParent);
grantRead(ordinaryParent, '(OI)(CI)(R)');
const privateChild = join(ordinaryParent, 'private');
addon.createStoreEntry(privateChild, true);
assert.equal(addon.storeMetadata(privateChild).private, true);
const privateFile = join(ordinaryParent, 'private.txt');
addon.createStoreEntry(privateFile, false);
assert.equal(addon.storeMetadata(privateFile).private, true);
assert.throws(() => addon.createStoreEntry(privateFile, false), { code: 'EEXIST' });

const bootRoot = join(temporary, 'new parent', 'fresh café');
const legacy = join(temporary, 'legacy profile.json');
await writeFile(legacy, '{"firstName":"Ada","exact":9007199254740993}\n');
addon.restrictToOwner(legacy);
const service = createNativeStoreBootstrap('~\\new parent\\fresh café', '~/legacy profile.json', {}, temporary, { clock: now });
assert.equal(service.root, bootRoot);
assert.equal(plain(service.paths()).profile, join(bootRoot, 'profile.json'));
const legacyReference = path => fromJSON({ legacy: {
  id: 'legacy', label: 'Legacy', path, default: false, revision: 1, createdAt: now(), updatedAt: now(),
} });
validateResumeReferences(legacyReference(join(temporary, 'source.txt')));
assert.throws(() => validateResumeReferences(legacyReference('\\resumes\\source.txt')), /not normalized/);
assert.throws(() => validateResumeReferences(legacyReference('/resumes/source.txt')), /not normalized/);

await withWindowsStore(bootRoot, artifact, async () => {
  const first = plain(await service.initialize());
  assert.equal(first.migratedLegacyProfile, true);
  const profile = join(bootRoot, 'profile.json');
  const initial = await readFile(profile, 'utf8');
  assert.match(initial, /9007199254740993/);
  requireWindowsPrivate(bootRoot, true);
  requireWindowsPrivate(join(bootRoot, 'sessions'), true);
  requireWindowsPrivate(join(bootRoot, 'resume-files'), true);
  requireWindowsPrivate(profile, false);
  assert.equal(plain(await new NativeStoreBootstrap(bootRoot, legacy, { clock: now }).initialize()).migratedLegacyProfile, false);
  assert.equal(await readFile(profile, 'utf8'), initial);

  const history = join(bootRoot, 'history-witness.jsonl');
  const append = value => appendPointHistoryEvent(history, fromJSON(value), {
    serialization: options, isIdempotent: async () => false,
  });
  await append({ value: 'first' });
  await append({ value: 'second' });
  const historyBytes = '{"value": "first"}\n{"value": "second"}\n';
  assert.equal(await readFile(history, 'utf8'), historyBytes);
  const historyIO = createNativeJsonlHistoryIO('3.12');
  await assert.rejects(appendPointHistoryEvent(history, fromJSON({ value: 'failed' }), {
    serialization: options, isIdempotent: async () => false,
    io: {
      ...historyIO,
      async open(...args) {
        const handle = await historyIO.open(...args);
        return {
          ...handle,
          async write(bytes) {
            await handle.write(bytes.subarray(0, 4));
            throw new Error('injected append failure');
          },
        };
      },
    },
  }), /injected append failure/);
  assert.equal(await readFile(history, 'utf8'), historyBytes);
  requireWindowsPrivate(history, false);

  const alias = join(bootRoot, 'alias');
  const external = join(temporary, 'external');
  await mkdir(external);
  addon.restrictToOwner(external);
  await symlink(external, alias, 'junction');
  assert.equal(await resolvePosixPath(join(alias, 'missing', 'child'), '3.12'), join(external, 'missing', 'child'));
  await assert.rejects(atomicWritePointJson(join(alias, 'outside.json'), fromJSON({}), options));
  assert.deepEqual(await readdir(external), []);
  await assert.rejects(atomicWritePointJson(join(bootRoot, 'profile.json:stream'), fromJSON({}), options), /Windows Store path/);
  await assert.rejects(atomicWritePointJson(join(temporary, 'outside.json'), fromJSON({}), options), /outside the selected Windows Store/);
  await assert.rejects(checkWindowsStoreWrite(join(temporary, 'new parent', 'FRESH CAFÉ', 'profile.json')),
    /outside the selected Windows Store/);

  const hardlink = join(bootRoot, 'hardlink.json');
  await link(profile, hardlink);
  await assert.rejects(openWindowsStoreFile(profile, constants.O_RDONLY), /without links/);
  await unlink(hardlink);

  const held = await openWindowsStoreFile(profile, constants.O_RDONLY);
  const before = windowsFileIdentity(windowsMetadata(held.fd));
  const retained = join(bootRoot, 'retained.json');
  try {
    await rename(profile, retained);
    await atomicWritePointJson(profile, fromJSON({ replacement: true }), options);
    assert.equal(windowsFileIdentity(windowsMetadata(retained)), before);
    assert.notEqual(windowsFileIdentity(windowsMetadata(profile)), before);
    assert.equal(await held.readFile('utf8'), initial);
  } finally { await held.close(); }
});

const root = join(temporary, 'existing 工作');
const payload = fromJSON({ jobs: [{ url: 'https://example.invalid/jobs/windows', role: 'Windows role' }] });
const originalAnswers = join(root, 'answers.json');
let untouched;
await withWindowsStore(root, artifact, async provider => {
  await initializeJobsFixture(root);
  untouched = await readFile(originalAnswers);
  const updates = new JobUpsertService(new NativeJobsRepository(root, provider), now);
  const preview = plain(await updates.preview(payload, 'human'));
  await updates.commit(payload, 'human', preview.token);
  await assert.rejects(updates.commit(payload, 'human', preview.token), /drifted/);
  const file = join(root, '.store.lock');
  const order = [];
  const params = { provider, pathProfile: '3.12' };
  await Promise.all([
    withExclusiveFileLock(file, async () => { order.push('a-start'); await delay(20); order.push('a-end'); }, params),
    withExclusiveFileLock(file, async () => { order.push('b-start'); await delay(20); order.push('b-end'); }, params),
  ]);
  assert.equal(order[0].slice(0, 1), order[1].slice(0, 1));
  assert.equal(order[2].slice(0, 1), order[3].slice(0, 1));
  for (const name of await readdir(root)) requireWindowsPrivate(join(root, name));
});

await withWindowsStore(root, artifact, async provider => {
  const repository = new NativeJobsRepository(root, provider);
  const reopened = await repository.transaction(async ({ document }) => plain(document));
  assert.equal(Object.values(reopened.jobs)[0].role, 'Windows role');
  assert.deepEqual(await readFile(originalAnswers), untouched);
  const source = join(temporary, 'résumé.txt');
  await writeFile(source, 'Synthetic resume\n');
  await repository.resumeImport(fromJSON({ id: 'Sample', label: 'Resume' }), 'résumé.txt', await readFile(source), true);
  await assert.rejects(repository.resumeImport(fromJSON({ id: 'sample', label: 'Different' }),
    'different.txt', Buffer.from('Different resume\n'), true), /canonical spelling|filenames collide/);
  assert.equal(await readFile(join(root, 'resume-files', 'Sample.txt'), 'utf8'), 'Synthetic resume\n');
  await assert.rejects(openWindowsStoreFile(join(root, 'resume-files', 'sample.txt'), constants.O_RDONLY),
    { code: 'ENOENT' });
  assert.equal((await repository.resumeSummaries()).length, 1);

  const different = join(temporary, 'public profile.json');
  await writeFile(different, '{}');
  grantRead(different, '(R)');
  const profile = join(root, 'profile.json');
  const original = await readFile(profile);
  await unlink(profile);
  await rename(different, profile);
  assert.equal(windowsMetadata(profile).private, false);
  await assert.rejects(repository.transaction(async () => {}), /private and owned/);
  assert.equal(await readFile(profile, 'utf8'), '{}');
  await unlink(profile);
  await writeFile(profile, original);
});
