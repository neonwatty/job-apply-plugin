import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, readdir, symlink, rm, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { nativeFixture, child } from './exclusive_file_lock_support.mjs';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { NativeJobsRepository, initializeJobsFixture } from '../runtime/store/native-jobs.js';
import { JobsService } from '../runtime/workspace-core/jobs.js';
import { normalizeJobUrl } from '../runtime/contracts/workspace/job-url.js';
import { parse, serialize, fromJSON } from '../runtime/contracts/workspace/values.js';
import { jobsHttp } from '../runtime/workspace-core/jobs-http.js';
import { atomicWritePointJson, createNativePointAtomicWriteIO } from '../runtime/store/point-persistence.js';

const execute = promisify(execFile);
const fixed = '2026-09-09T12:00:00Z';
const pythonPrelude = `
import sys, json, importlib.util
from pathlib import Path
sys.path.insert(0, str(Path('scripts').resolve()))
spec=importlib.util.spec_from_file_location('native_jobs_reference', 'scripts/job-apply-store.py')
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.utc_now=lambda: '${fixed}'
`;

test('native Jobs preserves Python contracts on independent Stores and survives restart, contention and faults', { timeout: 60000 }, async t => {
  const fixture = await nativeFixture();
  try {
    const root = join(await realpath(fixture.root), 'native');
    await initializeJobsFixture(root);
    const provider = loadPosixFlockProvider(fixture.receipt.artifact);
    const repository = new NativeJobsRepository(root, provider);
    const service = new JobsService(repository, () => fixed);
    const run = async (service, operations) => {
      const output = [];
      for (const operation of operations) {
        try {
          const value = operation.kind === 'create' ? await service.create(fromJSON(operation.input), operation.origin)
            : operation.kind === 'update' ? await service.update(operation.id, fromJSON(operation.input), BigInt(operation.revision), operation.origin)
            : operation.kind === 'get' ? await service.get(operation.id) : await service.list(operation.options);
          output.push({ value: JSON.parse(serialize(value)) });
        } catch (error) { output.push({ error: error.message }); }
      }
      return output;
    };
    await t.test('differential create/update/noop/agent provenance/errors/list', async () => {
      const operations = [
        { kind: 'create', input: { id: ' ', url: 'https://example.invalid/invalid-id' } },
        { kind: 'create', input: { id: 'one', url: ' HTTPS://Jobs.Example.com:443/a/../job?q=%2f#apply ', role: 'Owner', priority: 4 } },
        { kind: 'create', input: { id: 'duplicate', url: 'https://jobs.example.com/a/../job?q=%2f' } },
        { kind: 'update', id: 'one', revision: 1, input: { role: 'Agent overwrite', company: 'Agent company' }, origin: 'agent' },
        { kind: 'update', id: 'one', revision: 2, input: { company: 'Agent refreshed', notes: 'A note' }, origin: 'agent' },
        { kind: 'update', id: 'one', revision: 3, input: { company: 'Owner company', notes: '' } },
        { kind: 'update', id: 'one', revision: 4, input: { company: 'Owner company' } },
        { kind: 'update', id: 'one', revision: 3, input: { notes: 'Stale' } },
        { kind: 'update', id: 'one', revision: 4, input: { resumeId: 'missing' } },
        { kind: 'update', id: 'one', revision: 4, input: { priority: true } },
        { kind: 'create', input: { id: 'two', url: 'https://example.invalid/2', provenance: { '/notes': { origin: 'migration' } } } },
        { kind: 'create', input: { id: 'two', url: 'https://example.invalid/2', priority: 5 } },
        { kind: 'get', id: 'one' }, { kind: 'get', id: 'missing' }, { kind: 'list' },
      ];
      const script = pythonPrelude + `
s=m.Store(Path(sys.argv[1])); s.initialize()
out=[]
for op in json.loads(sys.argv[2]):
 try:
  if op['kind']=='create': value=s.create_job(op['input'], origin=op.get('origin','human'))
  elif op['kind']=='update': value=s.update_job(op['id'], op['input'], op['revision'], origin=op.get('origin','human'))
  elif op['kind']=='get': value=s.get_job(op['id'])
  else: value=s.list_jobs()
  out.append({'value':value})
 except m.StoreError as error: out.append({'error':str(error)})
print(json.dumps(out))
`;
      const result = await execute('python3', ['-c', script, join(fixture.root, 'python'), JSON.stringify(operations)]);
      assert.deepEqual(await run(service, operations), JSON.parse(result.stdout));
      const nativeJobs = JSON.parse(await readFile(join(root, 'jobs.json'), 'utf8'));
      const pythonJobs = JSON.parse(await readFile(join(fixture.root, 'python/jobs.json'), 'utf8'));
      assert.deepEqual(nativeJobs.jobs, pythonJobs.jobs);
    });
    await t.test('URL identity retains urllib path/query behavior', async () => {
      const urls = ['https://EXAMPLE.com:443', 'http://a:0/p', 'https://a/p?', 'https://a/a/../b',
        'https://a/%2F?q=a+b&z=2#f', 'https://user:pass@a', 'https://a:65536', 'https://a:bad',
        'https://[::1]:443/x', 'https://[fe80::1%Zone]/', 'https://a:/', 'https://例え.test/é',
        'https://a\\b/c', 'https://a\n/b', 'https://a：443/', '', 'ftp://a/', 'https://[bad]/'];
      const script = pythonPrelude + `
out=[]
for value in json.loads(sys.argv[1]):
 try: out.append({'value':m.normalize_job_url(value)})
 except m.StoreError as e: out.append({'error':str(e)})
print(json.dumps(out))
`;
      const reference = JSON.parse((await execute('python3', ['-c', script, JSON.stringify(urls)])).stdout);
      const actual = urls.map(value => { try { return { value: normalizeJobUrl(value) }; } catch (error) { return { error: error.message }; } });
      assert.deepEqual(actual, reference);
    });
    await t.test('Python-empty ids generate an id while whitespace ids are invalid', async () => {
      let index = 0;
      const generated = new JobsService(repository, () => fixed, () => `generated-${++index}`);
      for (const id of ['', false, 0, null, [], {}]) {
        const result = await generated.create(fromJSON({ id, url: `https://example.invalid/generated/${index}` }));
        assert.equal(JSON.parse(serialize(result)).id, `generated-${index}`);
      }
    });
    await t.test('large unknown provenance values and revisions persist without rounding', async () => {
      await service.update('one', parse('{"provenance":{"/opaque":{"integer":900719925474099312345,"float":1.0,"__proto__":"kept","text":"😀"}}}'), 4n);
      const bytes = await readFile(join(root, 'jobs.json'), 'utf8');
      assert.match(bytes, /900719925474099312345/);
      assert.match(bytes, /"float": 1\.0/);
      assert.match(bytes, /"__proto__": "kept"/);
      assert.equal(JSON.parse(serialize(await new JobsService(new NativeJobsRepository(root, provider)).get('one'))).revision, 5);
    });
    await t.test('HTTP contract validation and unsupported workflows', async () => {
      assert.equal((await jobsHttp(service, repository, 'PATCH', '/api/jobs/one', '{"patch":{"notes":"stale"},"expectedRevision":1}')).status, 409);
      assert.equal((await jobsHttp(service, repository, 'PATCH', '/api/jobs/one', '{"patch":{},"expectedRevision":true}')).status, 400);
      assert.equal((await jobsHttp(service, repository, 'GET', '/api/jobs/missing')).status, 404);
      assert.equal((await jobsHttp(service, repository, 'POST', '/api/jobs/one/transition', '{}')).status, 400);
      assert.equal((await jobsHttp(service, repository, 'GET', '/api/trash')).status, 200);
      assert.equal((await jobsHttp(service, repository, 'POST', '/api/jobs/job/delete', '{"expectedRevision":1}')).status, 501);
    });
    await t.test('independent CLI writers serialize revisions without Python', async () => {
      const cli = resolve('runtime/cli/native-jobs.js');
      const patch = join(fixture.root, 'patch.json');
      await writeFile(patch, '{"notes":"concurrent update"}');
      const args = [cli, '--root', root, '--native-lock', fixture.receipt.artifact, 'job-update', '--id', 'one', '--input', patch, '--expected-revision', '5'];
      const outcomes = await Promise.allSettled(Array.from({ length: 4 }, () => execute(process.execPath, args, { env: { PATH: '' } })));
      assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
      for (const outcome of outcomes.filter(value => value.status === 'rejected')) assert.match(outcome.reason.stderr, /revision conflict/);
      assert.equal(JSON.parse(serialize(await service.get('one'))).revision, 6);
    });
    await t.test('failed replacement retains old document and releases the lock', async () => {
      const before = await readFile(join(root, 'jobs.json'));
      const failing = new NativeJobsRepository(root, provider, async (path, value, options) => {
        const io = createNativePointAtomicWriteIO(options.pathProfile);
        io.replace = async () => { throw new Error('injected replace failure'); };
        await atomicWritePointJson(path, value, options, io);
      });
      await assert.rejects(new JobsService(failing).update('one', fromJSON({ notes: 'lost' }), 6n), /injected replace failure/);
      assert.deepEqual(await readFile(join(root, 'jobs.json')), before);
      assert.equal((await readdir(root)).some(name => name.endsWith('.tmp')), false);
      assert.equal(JSON.parse(serialize(await service.get('one'))).revision, 6);
    });
    await t.test('unknown state and symlinks are rejected without adopting a Store', async () => {
      await assert.rejects(initializeJobsFixture(root), /EEXIST/);
      const before = await readFile(join(root, 'jobs.json'));
      await writeFile(join(root, 'pending-journal.json'), '{}');
      await assert.rejects(service.list(), /unsupported state/);
      assert.deepEqual(await readFile(join(root, 'jobs.json')), before);
      await rm(join(root, 'pending-journal.json'));
      const link = join(fixture.root, 'linked');
      await symlink(root, link);
      await assert.rejects(new JobsService(new NativeJobsRepository(link, provider)).list(), /real absolute directory/);
    });
    await t.test('resume selection validates the registry without modifying profile or resumes', async () => {
      const path = join(root, 'resumes.json');
      const snapshot = await readFile(path);
      const profile = await readFile(join(root, 'profile.json'));
      const document = JSON.parse(snapshot);
      document.resumes.resume = { id: 'resume', label: 'Synthetic resume', path: '/synthetic/resume.txt',
        default: true, revision: 1, createdAt: fixed, updatedAt: fixed, deletedAt: null };
      await writeFile(path, JSON.stringify(document));
      const seeded = await readFile(path);
      await service.update('one', fromJSON({ resumeId: 'resume' }), 6n);
      assert.deepEqual(await readFile(path), seeded);
      assert.deepEqual(await readFile(join(root, 'profile.json')), profile);
      document.resumes.resume.deletedAt = fixed;
      await writeFile(path, JSON.stringify(document));
      await assert.rejects(service.create(fromJSON({ id: 'bad-resume', url: 'https://example.invalid/resume', resumeId: 'resume' })), /assigned resume does not exist/);
      document.resumes.resume.revision = true;
      await writeFile(path, JSON.stringify(document));
      await assert.rejects(service.list(), /resume revision/);
      await writeFile(path, snapshot);
    });
    await t.test('write and fsync faults preserve old bytes; post-replace failure remains visible', async () => {
      for (const stage of ['write', 'sync', 'directory-sync']) {
        const before = await readFile(join(root, 'jobs.json'));
        const failing = new NativeJobsRepository(root, provider, async (path, value, options) => {
          const io = createNativePointAtomicWriteIO(options.pathProfile);
          if (stage === 'directory-sync') {
            const original = io.openDirectory;
            io.openDirectory = async (...args) => {
              const handle = await original(...args);
              handle.sync = async () => { throw new Error('injected directory-sync'); };
              return handle;
            };
          } else {
            const original = io.createTemporary;
            io.createTemporary = async (...args) => {
              const handle = await original(...args);
              handle[stage] = async () => { throw new Error(`injected ${stage}`); };
              return handle;
            };
          }
          await atomicWritePointJson(path, value, options, io);
        });
        await assert.rejects(new JobsService(failing).update('one', fromJSON({ notes: `fault ${stage}` }), 7n), /injected/);
        if (stage !== 'directory-sync') assert.deepEqual(await readFile(join(root, 'jobs.json')), before);
        else assert.equal(JSON.parse(serialize(await service.get('one'))).revision, 8);
        assert.equal((await readdir(root)).some(name => name.endsWith('.tmp')), false);
      }
    });
    await t.test('process death releases the native lock without changing the document', async () => {
      const before = await readFile(join(root, 'jobs.json'));
      const holder = child(`
        import { NativeJobsRepository } from ${JSON.stringify(new URL('../runtime/store/native-jobs.js', import.meta.url).href)};
        import { loadPosixFlockProvider } from ${JSON.stringify(new URL('../runtime/store/posix-flock.js', import.meta.url).href)};
        const repository = new NativeJobsRepository(process.argv[1], loadPosixFlockProvider(process.argv[2]));
        await repository.transaction(async () => {
          console.log('locked');
          await new Promise(() => setInterval(() => {}, 1000));
        });
      `, [root, fixture.receipt.artifact]);
      try { await holder.line('locked'); }
      finally { holder.process.kill('SIGKILL'); await holder.exited; }
      assert.deepEqual(await readFile(join(root, 'jobs.json')), before);
      assert.equal(JSON.parse(serialize(await service.get('one'))).revision, 8);
    });
  } finally { await fixture.cleanup(); }
});
