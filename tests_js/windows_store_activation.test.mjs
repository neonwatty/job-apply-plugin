import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Windows install path: the packaged lock, no Python, and no clone or writer switch.
const command = fileURLToPath(new URL('../apps/companion/command.mjs', import.meta.url));
const windows = process.platform === 'win32';
const loadAddon = () => createRequire(import.meta.url)('../native/packaged-lock/win32-x64-napi8/flock.node');

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
  json(cli(temporary, 'store', 'init', '--root', optedIn, '--legacy-profile', explicitProfile));
  const imported = await readFile(join(optedIn, 'profile.json'));
  assert.equal(JSON.parse(imported).profile.name, 'Legacy profile');
  const partial = join(temporary, 'partial');
  addon.createStoreEntry(partial, true);
  for (const name of ['.store.lock', '.native-store-pending', 'profile.json', 'resume-operation.json']) {
    addon.createStoreEntry(join(partial, name), false);
  }
  await writeFile(join(partial, 'profile.json'), imported);
  await writeFile(join(partial, 'resume-operation.json'), '{"schemaVersion":1,"operation":null}\n');
  json(cli(temporary, 'store', 'init', '--root', partial));
  assert.deepEqual(await readFile(join(partial, 'profile.json')), imported);
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

  for (const args of [['store', 'init'], ['store', 'job-list'], ['task', 'snapshot']]) {
    const result = cli(temporary, ...args, '--root', legacy);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, /not a native Job Apply Store\. It was left unchanged\./);
    assert.match(result.stderr, /--root or JOB_APPLY_STORE_DIR/);
    assert.doesNotMatch(result.stderr + result.stdout, /PRIVATE/);
    assert.deepEqual(await snapshot(legacy), before);
    assert.deepEqual(await readdir(join(legacy, 'sessions')), []);
  }
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
