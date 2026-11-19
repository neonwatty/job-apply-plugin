import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { assertRejections, cliStore } from './native_cli_contract_support.mjs';
import { snapshotFiles } from './legacy_store_migration_support.mjs';

async function input(home, name, payload) {
  const path = join(home, name + '.json');
  await writeFile(path, JSON.stringify(payload), { mode: 0o600 });
  return ['--input', path];
}

const identity = (key, revision) => ['--key', key, '--expected-revision', String(revision)];
const at = (id, revision) => ['--id', id, '--expected-revision', String(revision)];

test('Store answer CLI covers reads and the full revisioned lifecycle', async t => {
  const { home, root, call } = await cliStore(t);
  const before = await snapshotFiles(root);
  const question = 'Are you authorized to work?';
  const { key } = await call('answer-key', ['--question', question]);
  assert.equal(await call('answer-get', ['--key', key]), null);
  const create = await input(home, 'answer', { question, state: 'confirmed', value: 'Yes', aliases: ['Employment authorization?'] });
  const created = await call('answer-put', create);
  assert.equal(created.key, key);
  assert.equal(created.revision, 1);
  assert.equal((await call('answer-find', ['--question', question])).key, key);
  assert.equal((await call('answer-get', ['--key', key])).value, 'Yes');
  assert.equal((await call('answer-list', ['--query', 'authorized'])).total, 1);
  const patch = await input(home, 'answer-patch', { value: 'Yes, without sponsorship' });
  const updated = await call('answer-update', [...identity(key, 1), ...patch]);
  assert.equal(updated.revision, 2);
  assert.equal(updated.value, 'Yes, without sponsorship');
  assert.equal((await call('answer-trash', identity(key, 2))).revision, 3);
  assert.equal(await call('answer-get', ['--key', key]), null);
  assert.equal((await call('answer-get', ['--key', key, '--include-trashed'])).revision, 3);
  assert.equal((await call('answer-list', ['--trashed-only', '--include-trashed'])).total, 1);
  assert.equal((await call('answer-restore', identity(key, 3))).revision, 4);
  assert.equal((await call('answer-trash', identity(key, 4))).revision, 5);
  assert.equal((await call('answer-delete', identity(key, 5))).deleted, true);
  assert.equal(await call('answer-get', ['--key', key, '--include-trashed']), null);
  const after = await snapshotFiles(root);
  delete before['answers.json'];
  delete after['answers.json'];
  assert.deepEqual(after, before);
});

test('Store answer CLI requires consent for private values and rejects stale and invalid edits', async t => {
  const store = await cliStore(t);
  const secret = 'SYNTHETIC-PRIVATE-ANSWER';
  const privateAnswer = await input(store.home, 'private', { question: 'Private answer?', state: 'sensitive', value: secret, sensitivity: 'high' });
  await assertRejections(store, [['answer-put', privateAnswer, /sensitive|consent/i]]);
  const { key } = await store.call('answer-put', [...privateAnswer, '--remember-sensitive']);
  const before = await snapshotFiles(store.root);
  assert.doesNotMatch(JSON.stringify(await store.call('answer-get', ['--key', key])), /SYNTHETIC-PRIVATE-ANSWER|"value":/);
  assert.equal((await store.call('answer-reveal', ['--key', key])).value, secret);
  assert.deepEqual(await snapshotFiles(store.root), before);
  const invalid = await input(store.home, 'invalid', { question: 'Invalid?', state: 'confirmed' });
  await assertRejections(store, [
    ['answer-update', [...identity(key, 2), ...privateAnswer, '--remember-sensitive'], /revision conflict/i],
    ['answer-put', invalid, /value/i],
  ]);
});

test('Store profile CLI preserves unrelated facts and provenance across revisioned writes', async t => {
  const store = await cliStore(t);
  const { home, root, call } = store;
  const before = await snapshotFiles(root);
  assert.deepEqual(await call('profile-get'), {});
  assert.equal((await call('profile-inspect')).revision, 1);
  assert.deepEqual(await call('preferences-get'), {});
  const replace = await input(home, 'replace', { firstName: 'Ada', contact: { email: 'ada@example.invalid' }, preferences: { remote: true } });
  const patch = await input(home, 'patch', { contact: { phone: '555' } });
  const skills = await input(home, 'skills', { skills: ['TypeScript'] });
  const preferences = await input(home, 'preferences', { remote: false, travel: 'occasional' });
  const smaller = await input(home, 'smaller', { travel: 'none' });
  const write = (command, args, revision, source) => call(command, [...args, '--expected-revision', String(revision), '--source', source]);
  assert.equal((await write('profile-replace', replace, 1, 'user')).revision, 2);
  assert.equal((await write('profile-patch', patch, 2, 'user')).revision, 3);
  assert.equal((await write('profile-patch', skills, 3, 'resume')).revision, 4);
  assert.equal((await write('preferences-set', preferences, 4, 'user')).revision, 5);
  await assertRejections(store, [['preferences-set', [...smaller, '--replace', '--expected-revision', '5', '--source', 'agent'], /user-provenanced/i]]);
  assert.equal((await write('preferences-set', [...smaller, '--replace'], 5, 'user')).revision, 6);
  const profile = { firstName: 'Ada', contact: { email: 'ada@example.invalid', phone: '555' },
    skills: ['TypeScript'], preferences: { travel: 'none' } };
  assert.deepEqual(await call('profile-get'), profile);
  const inspected = await call('profile-inspect');
  assert.deepEqual(inspected.profile, profile);
  assert.equal(inspected.factProvenance['/contact/email'].source, 'user');
  assert.equal(inspected.factProvenance['/contact/phone'].source, 'user');
  assert.equal(inspected.factProvenance['/skills'].source, 'resume');
  assert.deepEqual(await call('preferences-get'), profile.preferences);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'profile.json'), 'utf8')).profile, profile);
  const after = await snapshotFiles(root);
  delete before['profile.json'];
  delete after['profile.json'];
  assert.deepEqual(after, before);
});

test('Store profile CLI rejects stale and invalid writes and preserves exact bytes on a no-op', async t => {
  const store = await cliStore(t);
  const patch = await input(store.home, 'patch', { firstName: 'Ada' });
  const empty = await input(store.home, 'empty', {});
  const options = revision => ['--expected-revision', String(revision), '--source', 'user'];
  const saved = await store.call('profile-patch', [...patch, ...options(1)]);
  const before = await snapshotFiles(store.root);
  assert.deepEqual(await store.call('profile-patch', [...patch, ...options(2)]), saved);
  assert.deepEqual(await snapshotFiles(store.root), before);
  await assertRejections(store, [
    ['profile-patch', [...patch, ...options(1)], /revision conflict/i],
    ['profile-replace', [...patch, ...options(1)], /revision conflict/i],
    ['preferences-set', [...empty, ...options(1)], /revision conflict/i],
    ['profile-patch', [...empty, ...options(2)], /empty/i],
  ]);
});

test('Store resume CLI covers lifecycle, private managed bytes, and missing reads', async t => {
  const { home, root, call } = await cliStore(t);
  const source = join(home, 'source.txt');
  const content = 'Synthetic private resume bytes\n';
  await writeFile(source, content, { mode: 0o600 });
  const create = await input(home, 'new-resume', { id: 'resume-one', label: 'First resume', path: source, tags: ['typescript'] });
  const patch = await input(home, 'patch', { label: 'Updated resume', tags: ['typescript', 'job-search'] });
  const args = ['--id', 'resume-one'];
  const before = await snapshotFiles(root);
  assert.equal(await call('resume-get', args), null);
  assert.deepEqual(await call('resume-list'), []);
  assert.deepEqual(await snapshotFiles(root), before);
  const created = await call('resume-create', create);
  assert.equal(created.revision, 1);
  assert.equal(created.storageKind, 'managed');
  assert.equal(JSON.stringify(created).includes(source), false);
  assert.equal(JSON.stringify(created).includes(content.trim()), false);
  assert.deepEqual(await call('resume-get', args), created);
  assert.deepEqual(await call('resume-list'), [created]);
  const resolved = await call('resume-resolve');
  assert.equal(resolved.id, 'resume-one');
  const checked = await call('resume-check', args);
  assert.equal(checked.exists, true);
  assert.equal(checked.changed, false);
  assert.equal(await readFile(resolved.path, 'utf8'), content);
  assert.equal((await stat(resolved.path)).mode & 0o777, 0o600);
  assert.equal((await call('resume-update', [...at('resume-one', 1), ...patch])).label, 'Updated resume');
  const alternate = join(home, 'alternate.txt');
  await writeFile(alternate, 'Synthetic alternate resume bytes\n', { mode: 0o600 });
  const alternateInput = await input(home, 'alternate', { id: 'resume-two', label: 'Alternate', path: alternate });
  assert.equal((await call('resume-create', alternateInput)).default, false);
  const newDefault = await call('resume-set-default', at('resume-two', 1));
  assert.deepEqual([newDefault.default, newDefault.revision], [true, 2]);
  assert.equal((await call('resume-resolve')).id, 'resume-two');
  const oldDefault = await call('resume-get', args);
  assert.deepEqual([oldDefault.default, oldDefault.revision], [false, 3]);

  assert.equal((await call('resume-trash', at('resume-one', 3))).revision, 4);
  assert.equal(await call('resume-get', args), null);
  assert.equal((await call('resume-get', [...args, '--include-trashed'])).revision, 4);
  assert.equal((await call('resume-list', ['--trashed-only'])).length, 1);
  assert.equal((await call('resume-restore', at('resume-one', 4))).revision, 5);
  assert.equal((await call('resume-trash', at('resume-one', 5))).revision, 6);
  assert.deepEqual(await call('resume-delete', at('resume-one', 6)), { id: 'resume-one', deleted: true });
  assert.equal((await call('resume-trash', at('resume-two', 2))).revision, 3);
  assert.deepEqual(await call('resume-delete', at('resume-two', 3)), { id: 'resume-two', deleted: true });
  assert.deepEqual(await call('resume-list', ['--include-trashed']), []);
  assert.equal(await readFile(source, 'utf8'), content);
  await assert.rejects(readFile(resolved.path), { code: 'ENOENT' });
  const after = await snapshotFiles(root);
  delete before['resumes.json'];
  delete after['resumes.json'];
  assert.deepEqual(after, before);
});

test('Store resume CLI rejects stale and invalid changes and preserves bytes on lifecycle no-ops', async t => {
  const store = await cliStore(t);
  const source = join(store.home, 'source.txt');
  await writeFile(source, 'Synthetic resume\n', { mode: 0o600 });
  const create = await input(store.home, 'new-resume', { id: 'resume-one', label: 'First resume', path: source });
  const bad = await input(store.home, 'invalid', { unexpected: true });
  const patch = await input(store.home, 'patch', { label: 'Changed' });
  const created = await store.call('resume-create', create);
  const before = await snapshotFiles(store.root);
  for (const command of ['resume-set-default', 'resume-restore']) {
    assert.equal((await store.call(command, at('resume-one', 1))).revision, created.revision);
  }
  assert.deepEqual(await snapshotFiles(store.root), before);
  await assertRejections(store, [
    ['resume-create', create, /already exists|conflict/i],
    ['resume-create', bad, /unsupported fields/i],
    ['resume-update', [...at('resume-one', 99), ...patch], /revision conflict/i],
    ['resume-update', [...at('resume-one', 1), ...bad], /unsupported fields/i],
    ['resume-trash', at('resume-one', 99), /revision conflict/i],
    ['resume-delete', at('resume-one', 1), /trash/i],
  ]);
  const trashed = await store.call('resume-trash', at('resume-one', 1));
  const afterTrash = await snapshotFiles(store.root);
  assert.deepEqual(await store.call('resume-trash', at('resume-one', 2)), trashed);
  assert.deepEqual(await snapshotFiles(store.root), afterTrash);
  await assertRejections(store, [['resume-restore', at('resume-one', 1), /revision conflict/i]]);
});
