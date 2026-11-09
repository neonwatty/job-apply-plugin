import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { NativeJobsRepository, initializeJobsFixture } from '../runtime/store/native-jobs.js';
import { ProfileService } from '../runtime/workspace-core/profile.js';
import { FactGroupsService } from '../runtime/workspace-core/fact-groups.js';
import { JobsService } from '../runtime/workspace-core/jobs.js';
import { parse, serialize, fromJSON } from '../runtime/contracts/workspace/values.js';
import { jobsHttp } from '../runtime/workspace-core/jobs-http.js';
import { atomicWritePointJson, createNativePointAtomicWriteIO } from '../runtime/store/point-persistence.js';
import { casefold } from '../runtime/contracts/workspace/casefold.js';
const execute = promisify(execFile), fixed = '2026-09-09T12:00:00Z';
const plain = value => JSON.parse(serialize(value));

test('native profile/facts: independent Python parity, durable edits and transport boundaries', { timeout: 60000 }, async t => {
  const fixture = await nativeFixture();
  try {
    const root = join(await realpath(fixture.root), 'native');
    await initializeJobsFixture(root);
    const provider = loadPosixFlockProvider(fixture.receipt.artifact);
    const repository = new NativeJobsRepository(root, provider), profile = new ProfileService(repository, () => fixed);
    const initial = { schemaVersion: 1, profile: { unknown: { preserved: [1, false, null] } }, metadata: { createdAt: fixed, updatedAt: fixed, revision: 1, factProvenance: {} } };
    await writeFile(join(root, 'profile.json'), JSON.stringify(initial));
    await t.test('profile patch/replace/preferences/provenance and no-op differential sequence', async () => {
      const operations = [
        ['patch_profile', { contact: { email: 'a@example.invalid', phone: '123' } }, 1, 'user'],
        ['patch_profile', { contact: { email: 'b@example.invalid' } }, 2, 'agent'],
        ['patch_profile', { contact: { email: 'b@example.invalid' } }, 2, 'user'],
        ['patch_profile', { contact: { phone: '456' } }, 3, 'resume'],
        ['patch_profile', { contact: { email: 'b@example.invalid' } }, 3, 'user'],
        ['patch_profile', { stale: true }, 1, 'user'],
        ['patch_profile', { 'a/b~': { nested: 1 } }, 3, 'resume'],
        ['patch_profile', { 'a/b~': null }, 4, 'user'],
        ['set_preferences', { remote: true, salary: 100 }, 5, 'user'],
        ['set_preferences', { remote: true }, 6, 'user', true],
        ['patch_profile', { atomic: { keep: null } }, 7, 'user', ['/atomic'], []],
        ['patch_profile', { atomic: null }, 8, 'user', ['/atomic'], []],
        ['patch_profile', { atomic: null }, 9, 'user', ['/atomic'], ['/atomic']],
        ['replace_profile', { final: [1, false], unknown: { preserved: [1, false, null] } }, 10, 'user'],
        ['patch_profile', {}, 11, 'user'],
        ['patch_profile', { nope: 1 }, 11, 'invalid'],
      ];
      const script = `
import sys,json,importlib.util
from pathlib import Path
sys.path.insert(0,str(Path('scripts').resolve()))
spec=importlib.util.spec_from_file_location('profile_reference','scripts/job-apply-store.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.utc_now=lambda:'${fixed}'
s=m.Store(Path(sys.argv[1]));s.initialize()
s.profile_path.write_text(sys.argv[2])
out=[]
for name,*args in json.loads(sys.argv[3]):
 try: out.append({'value':getattr(s,name)(*args)})
 except m.StoreError as error: out.append({'error':str(error)})
print(json.dumps(out))
`;
      const reference = await execute('python3', ['-c', script, join(fixture.root, 'python'), JSON.stringify(initial), JSON.stringify(operations)]);
      const actual = [];
      for (const [name, value, revision, source, extra, deleted] of operations) {
        try {
          const result = name === 'replace_profile' ? await profile.replace(fromJSON(value), BigInt(revision), source)
            : name === 'set_preferences' ? await profile.setPreferences(fromJSON(value), BigInt(revision), source, extra)
            : await profile.patch(fromJSON(value), BigInt(revision), source, extra, deleted);
          actual.push({ value: plain(result) });
        } catch (error) { actual.push({ error: error.message }); }
      }
      assert.deepEqual(actual, JSON.parse(reference.stdout));
      assert.deepEqual(JSON.parse(await readFile(join(root, 'profile.json'), 'utf8')), JSON.parse(await readFile(join(fixture.root, 'python/profile.json'), 'utf8')));
    });
    await t.test('large integers, float tokens and unknown metadata survive selective edits/restart', async () => {
      const raw = '{"schemaVersion":1,"profile":{"opaque":{"huge":9007199254740993,"float":1.0,"nil":null}},"metadata":{"revision":1,"unknown":{"a":true},"updatedAt":"fixed"}}';
      await writeFile(join(root, 'profile.json'), raw);
      await profile.patch(parse('{"firstName":"Synthetic"}'), 1n, 'user');
      const saved = await readFile(join(root, 'profile.json'), 'utf8');
      assert.match(saved, /9007199254740993/);
      assert.match(saved, /1\.0/);
      assert.deepEqual(plain(await new ProfileService(new NativeJobsRepository(root, provider)).get()).opaque.nil, null);
      assert.deepEqual(JSON.parse(saved).metadata.unknown, { a: true });
      const before = await stat(join(root, 'profile.json'), { bigint: true });
      await profile.patch(fromJSON({ firstName: 'Synthetic' }), 2n, 'user');
      assert.equal((await stat(join(root, 'profile.json'), { bigint: true })).mtimeNs, before.mtimeNs);
      assert.equal(await readFile(join(root, 'profile.json'), 'utf8'), saved);
    });
    await t.test('HTTP rejects authority overrides, named atomic replacement and stale edits', async () => {
      const jobs = new JobsService(repository);
      const call = payload => jobsHttp(jobs, repository, 'PATCH', '/api/profile', JSON.stringify(payload));
      assert.equal((await call({ patch: { firstName: 'bad' }, expectedRevision: 2, source: 'agent' })).status, 400);
      assert.equal((await call({ patch: { preferences: {} }, atomicPaths: ['/preferences'], expectedRevision: 2 })).status, 400);
      assert.equal((await call({ patch: { firstName: 'stale' }, expectedRevision: 1 })).status, 409);
      assert.equal((await call({ patch: { firstName: 'Saved' }, expectedRevision: 2 })).status, 200);
      assert.equal((await call({ patch: { firstName: 'stale' }, expectedRevision: true })).status, 400);
    });
    await t.test('CLI uses same revision lock with no Python in PATH', async () => {
      const cli = resolve('runtime/cli/native-jobs.js');
      const args = [cli, '--root', root, '--native-lock', fixture.receipt.artifact, 'profile-patch', '--input', '-', '--source', 'user', '--expected-revision', '3'];
      // Input files allow independent execFile processes without inherited stdin.
      const input = join(fixture.root, 'patch.json');
      await writeFile(input, '{"phone":"555"}');
      args[args.indexOf('-')] = input;
      const results = await Promise.allSettled([execute(process.execPath, args, { env: { PATH: '' } }), execute(process.execPath, args, { env: { PATH: '' } })]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.match(results.find(result => result.status === 'rejected').reason.stderr, /revision conflict/);
      assert.equal(plain(await profile.inspect()).revision, 4);
    });
    await t.test('corrupt metadata is never overwritten', async () => {
      const path = join(root, 'profile.json'), valid = await readFile(path, 'utf8');
      const corrupt = JSON.parse(valid); corrupt.metadata.revision = true;
      await writeFile(path, JSON.stringify(corrupt));
      const before = await readFile(path, 'utf8');
      await assert.rejects(profile.patch(fromJSON({ email: 'none' }), 4n, 'user'), /revision must/);
      assert.equal(await readFile(path, 'utf8'), before);
      await writeFile(path, valid);
    });
    await t.test('profile replacement failure preserves bytes and releases the lock', async () => {
      const before = await readFile(join(root, 'profile.json'));
      const failing = new NativeJobsRepository(root, provider, async (path, value, options) => {
        const io = createNativePointAtomicWriteIO(options.pathProfile);
        io.replace = async () => { throw Error('injected profile replacement failure'); };
        await atomicWritePointJson(path, value, options, io);
      });
      await assert.rejects(new ProfileService(failing).patch(fromJSON({ phone: 'lost' }), 4n, 'user'), /injected profile replacement failure/);
      assert.deepEqual(await readFile(join(root, 'profile.json')), before);
      assert.equal(plain(await profile.inspect()).revision, 4);
    });
    await t.test('fact groups match an independently initialized Python Store', async () => {
      const nativeRoot = join(await realpath(fixture.root), 'groups-native');
      await initializeJobsFixture(nativeRoot);
      const initial = { schemaVersion: 1, groups: {}, metadata: { createdAt: fixed, updatedAt: fixed } };
      await writeFile(join(nativeRoot, 'fact-groups.json'), JSON.stringify(initial));
      let counter = 0;
      const native = new FactGroupsService(new NativeJobsRepository(nativeRoot, provider), () => fixed, () => (++counter).toString(16).padStart(32,'0'));
      const first = '1'.padStart(32, '0');
      const operations = [
        ['create_fact_group', { label: ' Identity ', paths: ['/firstName'] }],
        ['create_fact_group', { label: 'IDENTITY', paths: ['/email'] }],
        ['update_fact_group', first, { paths: ['/firstName', '/email'], order: 100 }, 1],
        ['update_fact_group', first, { label: 'Identity' }, 2],
        ['update_fact_group', first, { label: 'Stale' }, 1],
        ['delete_fact_group', first, 1], ['delete_fact_group', first, 2],
        ['delete_fact_group', first, 2],
      ];
      const script = `
import sys,json,importlib.util,uuid
from pathlib import Path
sys.path.insert(0,str(Path('scripts').resolve()))
spec=importlib.util.spec_from_file_location('groups_reference','scripts/job-apply-store.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.utc_now=lambda:'${fixed}'
counter=iter(range(1,100));m.uuid.uuid4=lambda:uuid.UUID(int=next(counter))
s=m.Store(Path(sys.argv[1]));s.initialize();s._now=lambda:'${fixed}';s.fact_groups_path.write_text(sys.argv[2])
out=[]
for name,*args in json.loads(sys.argv[3]):
 try:out.append({'value':getattr(s,name)(*args)})
 except m.StoreError as error:out.append({'error':str(error)})
print(json.dumps(out))
`;
      const reference = await execute('python3', ['-c', script, join(fixture.root,'groups-python'), JSON.stringify(initial), JSON.stringify(operations)]);
      const actual = [];
      for (const [name, a, b, c] of operations) {
        try {
          const value = name === 'create_fact_group' ? await native.create(fromJSON(a))
            : name === 'update_fact_group' ? await native.update(a, fromJSON(b), BigInt(c)) : await native.delete(a, BigInt(b));
          actual.push({ value: plain(value) });
        } catch (error) { actual.push({ error: error.message }); }
      }
      assert.deepEqual(actual, JSON.parse(reference.stdout));
      assert.deepEqual(JSON.parse(await readFile(join(nativeRoot, 'fact-groups.json'), 'utf8')), JSON.parse(await readFile(join(fixture.root,'groups-python/fact-groups.json'), 'utf8')));
    });
    await t.test('groups preserve Unicode identity, stable ordering, revision and deletion semantics', async () => {
      let counter = 0;
      const groups = new FactGroupsService(repository, () => fixed, () => (++counter).toString(16).padStart(32, '0'));
      const first = plain(await groups.create(fromJSON({ label: ' Straße ', paths: ['/firstName'] })));
      assert.equal(first.order, 0);
      await assert.rejects(groups.create(fromJSON({ label: 'STRASSE', paths: ['/phone'] })), /already exists/);
      const second = plain(await groups.create(fromJSON({ label: 'Other', paths: ['/phone'] })));
      assert.equal(second.order, 100);
      assert.equal(plain(await groups.update(first.id, fromJSON({ label: 'Straße' }), 1n)).revision, 1);
      await assert.rejects(groups.update(first.id, fromJSON({ order: true }), 1n), /integer/);
      await groups.update(first.id, fromJSON({ paths: ['/phone'], order: 200 }), 1n);
      assert.deepEqual(plain(await groups.list()).map(item => item.id), [second.id, first.id]);
      await assert.rejects(groups.delete(first.id, 1n), /revision conflict/);
      assert.deepEqual(plain(await groups.delete(first.id, 2n)), { deleted: true, id: first.id });
      assert.equal(await groups.get(first.id), null);
      await assert.rejects(groups.create(fromJSON({ label: 'Invalid', paths: ['/a/~2'] })), /path is invalid/);
      assert.equal(casefold('Σςẞİ'), 'σσssi\u0307');
    });
  } finally { await fixture.cleanup(); }
});
