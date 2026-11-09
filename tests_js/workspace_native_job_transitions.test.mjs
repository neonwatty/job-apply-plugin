import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, plain, read, write, snapshot } from './workspace_native_claims_support.mjs';
import { NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { fromJSON, text } from '../runtime/contracts/workspace/values.js';
import { atomicWritePointJson, createNativePointAtomicWriteIO } from '../runtime/store/point-persistence.js';

const loaded = await import('../runtime/workspace-core/job-transitions.js').catch(() => ({}));
const fixed = '2026-09-10T13:00:00Z';
const statuses = ['saved', 'needs_info', 'ready', 'in_progress', 'awaiting_review', 'applied', 'closed'];
const python = `
import sys, json, importlib.util
from pathlib import Path
sys.path.insert(0, str(Path('scripts').resolve()))
spec=importlib.util.spec_from_file_location('transition_reference','scripts/job-apply-store.py')
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.utc_now=lambda: '${fixed}'
s=m.Store(Path(sys.argv[1])); s.initialize()
base=json.loads(s.jobs_path.read_text()); out=[]
profile_path=Path(sys.argv[1])/'profile.json'; profile=json.loads(profile_path.read_text())
resumes_path=Path(sys.argv[1])/'resumes.json'; resumes=json.loads(resumes_path.read_text())
for case in json.loads(sys.argv[2]):
 current_profile=json.loads(json.dumps(profile)); current_resumes=json.loads(json.dumps(resumes))
 if case.get('emptyProfile'): current_profile['profile']={}
 if case.get('missingResume'): current_resumes['resumes']={}
 profile_path.write_text(json.dumps(current_profile)); resumes_path.write_text(json.dumps(current_resumes))
 document=json.loads(json.dumps(base)); job=document['jobs']['job']
 job['status']=case['source']; job['closedOutcome']='expired' if case['source']=='closed' else None
 job['deletedAt']=case.get('deletedAt')
 s.jobs_path.write_text(json.dumps(document))
 try:
  value=s.transition_job(case.get('id','job'),case['target'],case.get('revision',1),case.get('outcome'),case.get('confirmed',False))
  result={'value':value}
 except (m.StoreError, TypeError) as error: result={'error':str(error)}
 result['jobs']=json.loads(s.jobs_path.read_text()); out.append(result)
print(json.dumps(out))
`;

async function unchanged(root, operation, pattern) {
  const before = await snapshot(root);
  await assert.rejects(operation, pattern);
  assert.deepEqual(await snapshot(root), before);
}

test('native transitions preserve Python lifecycle and durable write boundaries', { timeout: 60000 }, async t => {
  assert.equal(typeof loaded.JobTransitionsService, 'function');
  const { JobTransitionsService } = loaded;
  const fixture = await nativeFixture();
  try {
    const state = await setup(fixture, 'transitions');
    const { root, repository } = state;
    const service = new JobTransitionsService(repository, () => fixed);
    await t.test('actual Python differential for every status pair, outcomes, revisions and invalid inputs', async () => {
      const cases = statuses.flatMap(source => statuses.map(target => ({source, target, outcome:'rejected', confirmed:true})));
      for (const outcome of [null, '', 'unknown', true, 3, 'withdrawn', 'expired', 'duplicate', 'not_interested']) {
        cases.push({source:'saved',target:'closed',outcome});
      }
      cases.push({source:'saved',target:'ready',emptyProfile:true}, {source:'saved',target:'ready',missingResume:true},
        {source:'ready',target:'ready',emptyProfile:true}, {source:'awaiting_review',target:'applied'}, {source:'saved',target:'saved',outcome:'invalid'},
        {source:'closed',target:'closed',outcome:null}, {source:'saved',target:'closed',revision:2},
        {source:'saved',target:'invalid'}, {source:'saved',target:'saved',id:'missing'},
        {source:'saved',target:'saved',id:'../bad'}, {source:'saved',target:'saved',deletedAt:fixed});
      const referenceRoot = join(fixture.root, 'python');
      await cp(root, referenceRoot, { recursive:true, preserveTimestamps:true });
      const expected = JSON.parse((await promisify(execFile)('python3', ['-c',python,referenceRoot,JSON.stringify(cases)])).stdout);
      const base = await read(root, 'jobs.json');
      const profile = await read(root,'profile.json'), resumes = await read(root,'resumes.json');
      for (const [index, item] of cases.entries()) {
        await write(root,'profile.json',item.emptyProfile ? {...profile,profile:{}} : profile);
        await write(root,'resumes.json',item.missingResume ? {...resumes,resumes:{}} : resumes);
        const document = structuredClone(base);
        Object.assign(document.jobs.job, {status:item.source,closedOutcome:item.source === 'closed' ? 'expired' : null,deletedAt:item.deletedAt ?? null});
        await write(root, 'jobs.json', document);
        const before = await snapshot(root);
        let actual;
        try {
          actual = {value:plain(await service.transition(item.id ?? 'job',item.target,BigInt(item.revision ?? 1),fromJSON(item.outcome ?? null),item.confirmed ?? false))};
        } catch (error) { actual = {error:error.message}; }
        actual.jobs = await read(root, 'jobs.json');
        assert.deepEqual(actual, expected[index], JSON.stringify(item));
        const after = await snapshot(root);
        if (actual.error || item.source === item.target) assert.deepEqual(after, before);
        else {
          delete before['jobs.json']; delete after['jobs.json'];
          assert.deepEqual(after, before, 'only jobs.json may change');
        }
      }
      await write(root, 'jobs.json', base);
      await write(root,'profile.json',profile);
      await write(root,'resumes.json',resumes);
    });
    await t.test('strict revisions and confirmation reject ambiguous direct callers without writes', async () => {
      for (const revision of [0n,-1n,1,1.0,true,'1',null,undefined]) {
        await unchanged(root, () => service.transition('job','saved',revision), /job revision is invalid/);
      }
      for (const outcome of [[],{}]) {
        await unchanged(root, () => service.transition('job','closed',1n,fromJSON(outcome)), /closed job requires a supported outcome/);
      }
      for (const confirmation of [1,'true',null,{}]) {
        await unchanged(root, () => service.transition('job','saved',1n,null,confirmation), /confirmation.*boolean/);
      }
    });
    await t.test('claim guards precede same-status noops, including expired claims; stale revisions precede guards', async () => {
      await state.claims.select('job',1n,true);
      await state.claims.acquire('job',text('Synthetic'),2n);
      const guarded = new JobTransitionsService(repository, () => state.clock.now);
      for (const at of [state.clock.now,'2026-09-10T12:05:00Z','2026-09-11T12:00:00Z']) {
        state.clock.now = at;
        await unchanged(root, () => guarded.transition('job','in_progress',3n), /claimed job requires/);
        await unchanged(root, () => guarded.transition('job','closed',3n,text('expired')), /claimed job requires/);
        await unchanged(root, () => guarded.transition('job','in_progress',2n), /revision conflict/);
      }
      const claimCases = [
        {source:'in_progress',target:'in_progress',revision:3},
        {source:'in_progress',target:'closed',revision:3,outcome:'expired'},
        {source:'in_progress',target:'in_progress',revision:2},
        {source:'in_progress',target:'saved',revision:1,id:'other'},
      ];
      const referenceRoot = join(fixture.root,'python-claims');
      await cp(root,referenceRoot,{recursive:true,preserveTimestamps:true});
      const expected = JSON.parse((await promisify(execFile)('python3',
        ['-c',python,referenceRoot,JSON.stringify(claimCases)])).stdout);
      for (const [index,item] of claimCases.entries()) {
        let actual;
        try {
          actual = {value:plain(await guarded.transition(item.id ?? 'job',item.target,
            BigInt(item.revision),fromJSON(item.outcome ?? null)))};
        } catch (error) { actual = {error:error.message}; }
        const {jobs,...reference} = expected[index];
        assert.deepEqual(actual,reference);
      }
      assert.equal(plain(await service.transition('other','needs_info',1n)).revision,2);
    });
    await t.test('ready preflight rejects empty profile and changed managed resume, same ready remains no-op', async () => {
      const isolated = await setup(fixture,'preflight');
      const transitions = new JobTransitionsService(isolated.repository,() => fixed);
      const profile = await read(isolated.root,'profile.json');
      await write(isolated.root,'profile.json',{...profile,profile:{}});
      await unchanged(isolated.root, () => transitions.transition('job','ready',1n), /job is not ready/);
      await write(isolated.root,'profile.json',profile);
      await transitions.transition('job','ready',1n);
      await write(isolated.root,'profile.json',{...profile,profile:{}});
      const before = await snapshot(isolated.root);
      assert.equal(plain(await transitions.transition('job','ready',2n)).revision,2);
      assert.deepEqual(await snapshot(isolated.root),before);
      await write(isolated.root,'profile.json',profile);
      const resumes = await read(isolated.root,'resumes.json');
      resumes.resumes.resume.digest = '0'.repeat(64);
      await write(isolated.root,'resumes.json',resumes);
      await unchanged(isolated.root, () => transitions.transition('other','ready',1n), /job is not ready/);
    });
    await t.test('concurrent exact revision writers commit once and retain session/history bytes', async () => {
      const isolated = await setup(fixture,'concurrent');
      const before = await snapshot(isolated.root);
      const results = await Promise.allSettled(Array.from({length:4}, () => new JobTransitionsService(
        new NativeJobsRepository(isolated.root,isolated.provider),() => fixed).transition('job','needs_info',1n)));
      assert.equal(results.filter(result => result.status === 'fulfilled').length,1);
      for (const result of results.filter(result => result.status === 'rejected')) assert.match(result.reason.message,/revision conflict/);
      const after = await snapshot(isolated.root);
      delete before['jobs.json']; delete after['jobs.json'];
      assert.deepEqual(after,before);
    });
    await t.test('revisions above JavaScript safe integer range remain exact', async () => {
      const isolated = await setup(fixture,'large-revision');
      const path = join(isolated.root,'jobs.json');
      const document = await read(isolated.root,'jobs.json');
      document.jobs.job.revision = 'EXACT_REVISION';
      await writeFile(path,JSON.stringify(document).replace('\"EXACT_REVISION\"','900719925474099312345'));
      const transitions = new JobTransitionsService(isolated.repository,() => fixed);
      await unchanged(isolated.root,() => transitions.transition('job','needs_info',900719925474099312344n),/revision conflict/);
      await transitions.transition('job','needs_info',900719925474099312345n);
      assert.match(await readFile(path,'utf8'),/900719925474099312346/);
      const before = await snapshot(isolated.root);
      await transitions.transition('job','needs_info',900719925474099312346n);
      assert.deepEqual(await snapshot(isolated.root),before);
    });
    await t.test('atomic replacement faults leave old bytes and release lock', async () => {
      const isolated = await setup(fixture,'faults');
      for (const stage of ['write','sync','replace']) {
        const failing = new NativeJobsRepository(isolated.root,isolated.provider,async (path,value,options) => {
          const io = createNativePointAtomicWriteIO(options.pathProfile);
          if (stage === 'replace') io.replace = async () => { throw Error('transition fault'); };
          else {
            const original = io.createTemporary;
            io.createTemporary = async (...args) => {
              const handle = await original(...args);
              handle[stage] = async () => { throw Error('transition fault'); };
              return handle;
            };
          }
          await atomicWritePointJson(path,value,options,io);
        });
        await unchanged(isolated.root,() => new JobTransitionsService(failing).transition('job','needs_info',1n),/transition fault/);
        assert.equal((await readdir(isolated.root)).some(name => name.endsWith('.tmp')),false);
      }
      assert.equal(plain(await new JobTransitionsService(isolated.repository).transition('job','needs_info',1n)).revision,2);
    });
  } finally { await fixture.cleanup(); }
});
