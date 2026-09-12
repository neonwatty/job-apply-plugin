import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, link, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { initializeJobsFixture, NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { AutomationService } from '../runtime/workspace-core/automation.js';
import { AccountsService } from '../runtime/workspace-core/accounts.js';
import { JobsService } from '../runtime/workspace-core/jobs.js';
import { jobsHttp } from '../runtime/workspace-core/jobs-http.js';
import { serialize } from '../runtime/contracts/workspace/values.js';

const execute = promisify(execFile);
const plain = value => JSON.parse(serialize(value));
const portal = 'https://example.wd1.myworkdayjobs.com/en-US/careers/job/42';
const settingsName = 'automation-settings.json';
const accountsName = 'employer-accounts.json';

async function snapshot(root) {
  const files = (await readdir(root)).filter(name => name.endsWith('.json') || name.endsWith('.jsonl') || name === '.native-jobs-fixture');
  return Object.fromEntries(await Promise.all(files.sort().map(async name => [name, await readFile(join(root, name), 'utf8')])));
}
function unchangedExcept(before, after, names) {
  for (const name of names) { delete before[name]; delete after[name]; }
  assert.deepEqual(after, before);
}

test('integrated native automation registry uses private fixture storage and serialized HTTP revisions', { timeout: 60000 }, async t => {
  const fixture = await nativeFixture();
  t.after(() => fixture.cleanup());
  const parent = await realpath(fixture.root);
  const root = join(parent, 'registry');
  await initializeJobsFixture(root);
  const provider = loadPosixFlockProvider(fixture.receipt.artifact);
  const repository = new NativeJobsRepository(root, provider);
  const jobs = new JobsService(repository);
  const settings = new AutomationService(repository);
  const accounts = new AccountsService(repository);
  const call = (method, path, payload) => jobsHttp(jobs, repository, method, path, JSON.stringify(payload));
  let realm;

  await t.test('settings and account HTTP routes persist only their own documents and redact identities', async () => {
    assert.deepEqual(JSON.parse(await readFile(join(root, '.native-jobs-fixture'), 'utf8')), { mode: 'native-jobs-fixture', version: 12 });
    for (const name of [settingsName, accountsName]) assert.equal((await stat(join(root, name))).mode & 0o777, 0o600);
    const initial = await snapshot(root);
    const updated = await call('PATCH', '/api/automation/settings', {
      patch: { enabled: true, signupEmail: 'private-settings@example.invalid' }, expectedRevision: 1,
    });
    assert.equal(updated.status, 200, updated.body);
    assert.equal(JSON.parse(updated.body).revision, 2);
    assert.doesNotMatch(updated.body, /private-settings@example/);
    assert.equal(plain(await settings.get()).signupEmail, 'private-settings@example.invalid');
    unchangedExcept(initial, await snapshot(root), [settingsName]);
    const beforeAccount = await snapshot(root);
    const resolved = await call('POST', '/api/automation/realm-resolve', { url: portal });
    assert.equal(resolved.status, 200);
    realm = JSON.parse(resolved.body).realmRef;
    const created = await call('POST', '/api/employer-accounts', { url: portal, signupEmailOverride: 'private-account@example.invalid' });
    assert.equal(created.status, 200, created.body);
    assert.equal(JSON.parse(created.body).realmRef, realm);
    assert.doesNotMatch(created.body, /private-account@example|workday:v1/);
    assert.equal(plain(await accounts.get(realm)).signupEmailOverride, 'private-account@example.invalid');
    assert.equal((await call('GET', `/api/employer-accounts/${realm}`)).body, created.body);
    unchangedExcept(beforeAccount, await snapshot(root), [accountsName]);
    const accountUpdate = await call('PATCH', `/api/employer-accounts/${realm}`, { patch: { signupEmailOverride: null }, expectedRevision: 1 });
    assert.equal(accountUpdate.status, 200, accountUpdate.body);
    assert.equal(JSON.parse(accountUpdate.body).revision, 2);
    assert.equal(plain(await accounts.get(realm)).signupEmailOverride, null);
    const beforeRejected = await snapshot(root);
    assert.equal((await call('PATCH', '/api/automation/settings', { patch: { enabled: false }, expectedRevision: 1 })).status, 409);
    assert.equal((await call('PATCH', `/api/employer-accounts/${realm}`, { patch: { signupEmailOverride: null }, expectedRevision: 1 })).status, 409);
    assert.equal((await call('PATCH', '/api/automation/settings', { patch: {}, expectedRevision: true })).status, 400);
    assert.equal((await call('GET', '/api/employer-accounts/missing')).status, 404);
    assert.equal((await call('GET', '/api/automation')).status, 501);
    assert.equal((await call('POST', '/api/trusted-fill/approve', {})).status, 400);
    assert.deepEqual(JSON.parse((await call('GET', '/api/account-operation')).body), { status: 'idle', operation: null });
    assert.deepEqual(JSON.parse((await call('POST', '/api/account-operation/recover', {})).body), { status: 'idle', recovered: false });
    assert.deepEqual(await snapshot(root), beforeRejected);
  });

  await t.test('profile email copy checks both revisions, preserves profile and exposes no email', async () => {
    const profilePath = join(root, 'profile.json');
    const profile = JSON.parse(await readFile(profilePath, 'utf8'));
    profile.profile.email = 'private-profile@example.invalid';
    await writeFile(profilePath, JSON.stringify(profile));
    const before = await snapshot(root);
    const path = '/api/automation/settings/copy-profile-email';
    assert.equal((await call('POST', path, { expectedProfileRevision: 2, expectedSettingsRevision: 2 })).status, 409);
    assert.equal((await call('POST', path, { expectedProfileRevision: 1, expectedSettingsRevision: 1 })).status, 409);
    assert.deepEqual(await snapshot(root), before);
    const copied = await call('POST', path, { expectedProfileRevision: 1, expectedSettingsRevision: 2 });
    assert.equal(copied.status, 200, copied.body);
    assert.equal(JSON.parse(copied.body).revision, 3);
    assert.doesNotMatch(copied.body, /private-profile@example/);
    assert.equal(plain(await settings.get()).signupEmail, 'private-profile@example.invalid');
    unchangedExcept(before, await snapshot(root), [settingsName]);
  });

  await t.test('independent Python-free processes allow only one writer per expected revision', async () => {
    const script = `
      import { NativeJobsRepository } from ${JSON.stringify(new URL('../runtime/store/native-jobs.js', import.meta.url).href)};
      import { loadPosixFlockProvider } from ${JSON.stringify(new URL('../runtime/store/posix-flock.js', import.meta.url).href)};
      import { JobsService } from ${JSON.stringify(new URL('../runtime/workspace-core/jobs.js', import.meta.url).href)};
      import { jobsHttp } from ${JSON.stringify(new URL('../runtime/workspace-core/jobs-http.js', import.meta.url).href)};
      const repository = new NativeJobsRepository(process.argv[1], loadPosixFlockProvider(process.argv[2]));
      console.log(JSON.stringify(await jobsHttp(new JobsService(repository), repository, 'PATCH', process.argv[3], process.argv[4])));
    `;
    for (const [path, payload, name] of [
      ['/api/automation/settings', { patch: { enabled: false }, expectedRevision: 3 }, settingsName],
      [`/api/employer-accounts/${realm}`, { patch: { signupEmailOverride: 'concurrent@example.invalid' }, expectedRevision: 2 }, accountsName],
    ]) {
      const before = await snapshot(root);
      const results = await Promise.all(Array.from({ length: 4 }, () => execute(process.execPath,
        ['--input-type=module', '-e', script, root, fixture.receipt.artifact, path, JSON.stringify(payload)], { env: { PATH: '' } })));
      const responses = results.map(result => JSON.parse(result.stdout));
      assert.deepEqual(responses.map(response => response.status).sort(), [200, 409, 409, 409]);
      assert.equal(JSON.parse(responses.find(response => response.status === 200).body).revision, payload.expectedRevision + 1);
      unchangedExcept(before, await snapshot(root), [name]);
    }
    assert.equal(plain(await new AutomationService(new NativeJobsRepository(root, provider)).get()).revision, 4);
    assert.equal(plain(await new AccountsService(new NativeJobsRepository(root, provider)).get(realm)).revision, 3);
  });

  await t.test('private file checks reject public modes, symlinks and hard links without replacing data', async () => {
    for (const [name, read] of [[settingsName, () => settings.get()], [accountsName, () => accounts.list()]]) {
      const path = join(root, name), bytes = await readFile(path);
      await chmod(path, 0o644);
      try { await assert.rejects(read(), /private and owned/); }
      finally { await chmod(path, 0o600); }
      const outside = join(parent, `saved-${name}`);
      await rename(path, outside);
      try {
        await symlink(outside, path);
        await assert.rejects(read());
        assert.deepEqual(await readFile(outside), bytes);
        await rm(path);
        await link(outside, path);
        await assert.rejects(read(), /private and owned/);
        assert.deepEqual(await readFile(outside), bytes);
      } finally { await rm(path, { force: true }); await rename(outside, path); }
      assert.deepEqual(await readFile(path), bytes);
    }
  });

  await t.test('v11, missing new documents and unsupported recovery journals are rejected without adoption', async () => {
    const markerPath = join(root, '.native-jobs-fixture');
    const marker = await readFile(markerPath);
    await writeFile(markerPath, '{"mode":"native-jobs-fixture","version":11}\n');
    const old = await snapshot(root);
    await assert.rejects(settings.get(), /explicitly initialized synthetic fixture/);
    await assert.rejects(initializeJobsFixture(root), /EEXIST/);
    assert.deepEqual(await snapshot(root), old);
    await writeFile(markerPath, marker);
    for (const name of [settingsName, accountsName, 'account-operation-journal.json', 'trusted-fill.json']) {
      const path = join(root, name), saved = join(parent, `missing-${name}`);
      await rename(path, saved);
      try {
        const before = await snapshot(root);
        await assert.rejects(settings.get(), /unsupported state/);
        assert.deepEqual(await snapshot(root), before);
      } finally { await rename(saved, path); }
    }
    const journal = join(root, 'account-operation.json');
    await writeFile(journal, '{"schemaVersion":1,"operation":{"kind":"unsupported"}}', { mode: 0o600 });
    const before = await snapshot(root);
    await assert.rejects(settings.get(), /unsupported state or recovery journals/);
    assert.deepEqual(await snapshot(root), before);
    await rm(journal);
    assert.equal(plain(await settings.get()).revision, 4);
  });
});
