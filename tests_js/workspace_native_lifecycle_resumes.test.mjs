import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { cli, plain, read, snapshot, write } from './workspace_native_claims_support.mjs';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { NativeJobsRepository, initializeJobsFixture } from '../runtime/store/native-jobs.js';
import { atomicWritePointJson } from '../runtime/store/point-persistence.js';
import { ResumeService } from '../runtime/workspace-core/resumes.js';
import { ResumeLifecycleService } from '../runtime/workspace-core/resume-lifecycle.js';
import { ExtractionRequests } from '../runtime/workspace-core/extraction-requests.js';
import { JobsService } from '../runtime/workspace-core/jobs.js';
import { TrashService } from '../runtime/workspace-core/trash.js';
import { jobsHttp } from '../runtime/workspace-core/jobs-http.js';
import { fromJSON } from '../runtime/contracts/workspace/values.js';

const absent = async path => access(path).then(() => false, error => {
  if (error.code === 'ENOENT') return true;
  throw error;
});

async function setup(fixture, name, checkpoint) {
  const root = join(await realpath(fixture.root), name);
  await initializeJobsFixture(root);
  const provider = loadPosixFlockProvider(fixture.receipt.artifact);
  const repository = new NativeJobsRepository(root, provider, atomicWritePointJson, checkpoint);
  return { root, provider, repository };
}

test('native resume lifecycle enforces references, closes extraction work, and exposes HTTP and CLI actions', {timeout: 60000}, async () => {
  const fixture = await nativeFixture();
  try {
    const state = await setup(fixture, 'resume-lifecycle');
    const resumes = new ResumeService(state.repository, () => '2026-09-11T10:00:00Z');
    const created = plain(await resumes.import(fromJSON({id:'source',label:'PRIVATE LABEL'}), 'source.txt', Buffer.from('PRIVATE BYTES')));
    const request = plain(await new ExtractionRequests(state.repository).createRequest('source', BigInt(created.revision)));
    const jobs = new JobsService(state.repository, () => '2026-09-11T10:01:00Z');
    const job = plain(await jobs.create(fromJSON({id:'job',url:'https://example.invalid/job'})));
    const http = async (operation, revision) => {
      const result = await jobsHttp(jobs, state.repository, 'POST', `/api/resumes/source/${operation}`,
        JSON.stringify({expectedRevision:revision}));
      return {status:result.status, value:JSON.parse(result.body)};
    };
    const implicit = await http('trash', created.revision);
    assert.equal(implicit.status, 409);
    assert.deepEqual(implicit.value.error.counts, {jobReferences:1});
    assert.equal(implicit.value.error.code, 'default_reference_blocked');
    const assigned = plain(await jobs.update('job', fromJSON({resumeId:'source'}), BigInt(job.revision)));
    const implicitJob = plain(await jobs.create(fromJSON({id:'implicit-job',url:'https://example.invalid/implicit'})));
    const blocked = await http('trash', created.revision);
    assert.equal(blocked.status, 409);
    assert.deepEqual(blocked.value.error.counts, {jobReferences:2});
    assert.equal(JSON.stringify(blocked.value).includes('PRIVATE'), false);
    const trashedJob = plain(await new TrashService(state.repository).trashJob('job', BigInt(assigned.revision)));
    await new TrashService(state.repository).trashJob('implicit-job', BigInt(implicitJob.revision));

    const times = ['2026-09-11T10:02:00Z','2026-09-11T10:02:01Z','2026-09-11T10:03:00Z',
      '2026-09-11T10:04:00Z','2026-09-11T10:04:01Z','2026-09-11T10:05:00Z'];
    const lifecycle = new ResumeLifecycleService(state.repository, () => times.shift());
    const trashed = plain(await lifecycle.trash('source', BigInt(created.revision)));
    assert.equal(trashed.deletedAt, '2026-09-11T10:02:00Z');
    assert.equal(trashed.updatedAt, '2026-09-11T10:02:01Z');
    assert.equal(trashed.default, false);
    assert.deepEqual(plain(await lifecycle.trash('source', BigInt(trashed.revision))), trashed);
    assert.equal((await read(state.root, 'resume-extraction-requests.json')).requests[request.requestId].status, 'cancelled');
    const restored = plain(await lifecycle.restore('source', BigInt(trashed.revision)));
    assert.equal(restored.default, true);
    assert.equal(restored.updatedAt, '2026-09-11T10:03:00Z');
    const trashedAgain = plain(await lifecycle.trash('source', BigInt(restored.revision)));
    const referenced = await http('delete', trashedAgain.revision);
    assert.equal(referenced.status, 409);
    assert.equal(referenced.value.error.code, 'job_reference_blocked');
    assert.deepEqual(referenced.value.error.counts, {jobReferences:1});
    await new TrashService(state.repository).deleteJob('job', BigInt(trashedJob.revision));
    assert.deepEqual(plain(await lifecycle.delete('source', BigInt(trashedAgain.revision))), {id:'source',deleted:true});
    assert.equal(await absent(join(state.root, 'resume-files/source.txt')), true);
    assert.deepEqual(plain(await lifecycle.delete('source', 999n)), {id:'source',deleted:false});

    const cliResume = plain(await resumes.import(fromJSON({id:'cli',label:'CLI'}), 'cli.txt', Buffer.from('CLI')));
    const cliTrashed = await cli(fixture, state.root, 'resume-trash', ['--id','cli','--expected-revision',String(cliResume.revision)]);
    const cliRestored = await cli(fixture, state.root, 'resume-restore', ['--id','cli','--expected-revision',String(cliTrashed.revision)]);
    const cliTrashedAgain = await cli(fixture, state.root, 'resume-trash', ['--id','cli','--expected-revision',String(cliRestored.revision)]);
    assert.deepEqual(await cli(fixture, state.root, 'resume-delete', ['--id','cli','--expected-revision',String(cliTrashedAgain.revision)]), {id:'cli',deleted:true});
  } finally { await fixture.cleanup(); }
});

test('managed resume delete rolls back reported write failures and recovers every crash boundary', {timeout: 60000}, async t => {
  const fixture = await nativeFixture();
  try {
    await t.test('reported metadata failure restores the exact tree', async () => {
      const state = await setup(fixture, 'resume-delete-rollback');
      const resumes = new ResumeService(state.repository);
      const created = plain(await resumes.import(fromJSON({id:'resume',label:'Rollback'}), 'resume.txt', Buffer.from('rollback')));
      const trashed = plain(await new ResumeLifecycleService(state.repository).trash('resume', BigInt(created.revision)));
      const before = await snapshot(state.root);
      let fail = true;
      const write = async (path, value, options) => {
        if (fail && path.endsWith('/resumes.json')) { fail = false; throw Error('injected metadata failure'); }
        return atomicWritePointJson(path, value, options);
      };
      const repository = new NativeJobsRepository(state.root, state.provider, write);
      await assert.rejects(new ResumeLifecycleService(repository).delete('resume', BigInt(trashed.revision)), /injected metadata failure/);
      assert.deepEqual(await snapshot(state.root), before);
      assert.equal(await readFile(join(state.root, 'resume-files/resume.txt'), 'utf8'), 'rollback');
    });
    await t.test('post-replace metadata failure preserves deletion recovery', async () => {
      const state = await setup(fixture, 'resume-delete-post-replace');
      const resumes = new ResumeService(state.repository);
      const created = plain(await resumes.import(fromJSON({id:'resume',label:'Post replace'}), 'resume.txt', Buffer.from('private')));
      const trashed = plain(await new ResumeLifecycleService(state.repository).trash('resume', BigInt(created.revision)));
      let fail = true;
      const write = async (path, value, options) => {
        await atomicWritePointJson(path, value, options);
        if (fail && path.endsWith('/resumes.json')) { fail = false; throw Error('post-replace metadata failure'); }
      };
      const repository = new NativeJobsRepository(state.root, state.provider, write);
      await assert.rejects(new ResumeLifecycleService(repository).delete('resume', BigInt(trashed.revision)), /post-replace metadata failure/);
      assert.equal(await absent(join(state.root, 'resume-files/resume.txt')), true);
      assert.notEqual((await read(state.root, 'resume-operation.json')).operation, null);
      assert.deepEqual(plain(await new ResumeService(new NativeJobsRepository(state.root, state.provider)).list(true)), []);
      assert.equal((await read(state.root, 'resume-operation.json')).operation, null);
    });
    for (const stage of ['delete-journal','delete-quarantined','delete-metadata','delete-cleared']) {
      await t.test(`restart completes ${stage}`, async () => {
        let injected = false;
        const state = await setup(fixture, `resume-${stage}`, async current => {
          if (!injected && current === stage) { injected = true; throw Error(`injected ${stage}`); }
        });
        const resumes = new ResumeService(state.repository);
        const created = plain(await resumes.import(fromJSON({id:'resume',label:'Crash'}), 'resume.txt', Buffer.from(stage)));
        const trashed = plain(await new ResumeLifecycleService(state.repository).trash('resume', BigInt(created.revision)));
        await assert.rejects(new ResumeLifecycleService(state.repository).delete('resume', BigInt(trashed.revision)), new RegExp(stage));
        const recovered = new ResumeService(new NativeJobsRepository(state.root, state.provider));
        assert.deepEqual(plain(await recovered.list(true)), []);
        assert.equal(await absent(join(state.root, 'resume-files/resume.txt')), true);
        assert.equal((await read(state.root, 'resume-operation.json')).operation, null);
      });
    }
  } finally { await fixture.cleanup(); }
});

test('quarantine recovery restores referenced bytes, removes orphans, and rejects unknown names', {timeout: 60000}, async () => {
  const fixture = await nativeFixture();
  try {
    const state = await setup(fixture, 'resume-quarantine');
    const resumes = new ResumeService(state.repository);
    await resumes.import(fromJSON({id:'resume',label:'Recovery'}), 'resume.txt', Buffer.from('recover'));
    const directory = join(state.root, 'resume-files');
    const source = join(directory, 'resume.txt');
    const quarantine = join(directory, `.resume.txt.${'a'.repeat(32)}.quarantine`);
    await rename(source, quarantine);
    assert.equal(plain(await resumes.get('resume')).id, 'resume');
    assert.equal(await readFile(source, 'utf8'), 'recover');
    const replacement = join(directory, `.resume.txt.${'c'.repeat(32)}.quarantine`);
    await rename(source, replacement);
    await writeFile(source, 'corrupt', {mode:0o600});
    assert.equal(plain(await resumes.get('resume')).id, 'resume');
    assert.equal(await readFile(source, 'utf8'), 'recover');
    const orphan = join(directory, `.orphan.txt.${'b'.repeat(32)}.quarantine`);
    await writeFile(orphan, 'orphan', {mode:0o600});
    await resumes.list();
    assert.equal(await absent(orphan), true);
    await writeFile(join(directory, '.resume.txt.synthetic.quarantine'), 'unknown', {mode:0o600});
    await assert.rejects(resumes.list(), /unsupported resume recovery state/);
    assert.equal((await readdir(directory)).includes('.resume.txt.synthetic.quarantine'), true);
  } finally { await fixture.cleanup(); }
});

test('resume restore and delete preserve duplicate, request, missing-file, and legacy-file guards', {timeout: 60000}, async () => {
  const fixture = await nativeFixture();
  try {
    const state = await setup(fixture, 'resume-edge-contracts');
    const resumes = new ResumeService(state.repository, () => '2026-09-11T11:00:00Z');
    const first = plain(await resumes.import(fromJSON({id:'first',label:'First'}), 'first.txt', Buffer.from('first')));
    const second = plain(await resumes.import(fromJSON({id:'second',label:'Second'}), 'second.txt', Buffer.from('second')));
    const request = plain(await new ExtractionRequests(state.repository).createRequest('first', BigInt(first.revision)));
    const lifecycle = new ResumeLifecycleService(state.repository, () => '2026-09-11T11:01:00Z');
    const trashed = plain(await lifecycle.trash('first', BigInt(first.revision)));
    const document = await read(state.root, 'resumes.json');
    const originalDigest = document.resumes.first.digest;
    document.resumes.first.digest = document.resumes.second.digest;
    await write(state.root, 'resumes.json', document);
    const beforeDuplicate = await snapshot(state.root);
    await assert.rejects(lifecycle.restore('first', BigInt(trashed.revision)), /active resume file already exists/);
    assert.deepEqual(await snapshot(state.root), beforeDuplicate);
    document.resumes.first.digest = originalDigest;
    await write(state.root, 'resumes.json', document);

    const requests = await read(state.root, 'resume-extraction-requests.json');
    const closedAt = requests.requests[request.requestId].closedAt;
    requests.requests[request.requestId].status = 'requested';
    requests.requests[request.requestId].closedAt = null;
    await write(state.root, 'resume-extraction-requests.json', requests);
    await assert.rejects(lifecycle.delete('first', BigInt(trashed.revision)), /open extraction request/);
    requests.requests[request.requestId].status = 'cancelled';
    requests.requests[request.requestId].closedAt = closedAt;
    await write(state.root, 'resume-extraction-requests.json', requests);
    await unlink(join(state.root, 'resume-files/first.txt'));
    assert.deepEqual(plain(await lifecycle.delete('first', BigInt(trashed.revision))), {id:'first',deleted:true});

    const external = join(fixture.root, 'legacy.txt');
    await writeFile(external, 'legacy');
    const current = await read(state.root, 'resumes.json');
    current.resumes.legacy = {id:'legacy',label:'Legacy',path:external,tags:[],default:false,
      observedSize:6,observedModifiedAt:'2026-09-11T11:00:00Z',revision:3,
      createdAt:'2026-09-11T11:00:00Z',updatedAt:'2026-09-11T11:00:00Z',deletedAt:'2026-09-11T11:00:00Z'};
    await write(state.root, 'resumes.json', current);
    assert.deepEqual(plain(await lifecycle.delete('legacy', 3n)), {id:'legacy',deleted:true});
    assert.equal(await readFile(external, 'utf8'), 'legacy');
    assert.equal(plain(await resumes.get('second')).id, second.id);
  } finally { await fixture.cleanup(); }
});

test('resume lifecycle reads unrelated documents only after earlier guards', {timeout: 60000}, async () => {
  const fixture = await nativeFixture();
  try {
    const state = await setup(fixture, 'resume-lazy-guards');
    const resumes = new ResumeService(state.repository);
    const created = plain(await resumes.import(fromJSON({id:'resume',label:'Lazy'}), 'resume.txt', Buffer.from('lazy')));
    const lifecycle = new ResumeLifecycleService(state.repository);
    const trashed = plain(await lifecycle.trash('resume', BigInt(created.revision)));
    const jobs = await read(state.root, 'jobs.json');
    jobs.jobs.invalid = {id:'invalid',unexpected:true};
    await write(state.root, 'jobs.json', jobs);
    const requests = await read(state.root, 'resume-extraction-requests.json');
    requests.requests.invalid = {unexpected:true};
    await write(state.root, 'resume-extraction-requests.json', requests);

    const restored = plain(await lifecycle.restore('resume', BigInt(trashed.revision)));
    assert.deepEqual(plain(await lifecycle.restore('resume', BigInt(restored.revision))), restored);
    assert.deepEqual(plain(await lifecycle.delete('missing', 999n)), {id:'missing',deleted:false});
    await assert.rejects(lifecycle.delete('resume', 999n), /resume revision conflict/);
    await assert.rejects(lifecycle.delete('resume', BigInt(restored.revision)), /resume must be trashed/);
  } finally { await fixture.cleanup(); }
});
