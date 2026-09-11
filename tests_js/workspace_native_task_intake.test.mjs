import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, read, write, plain, snapshot, cli } from './workspace_native_claims_support.mjs';
import { fixed, item, differential, unchanged, stdin } from './workspace_native_task_intake_support.mjs';
import { NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { fromJSON, text } from '../runtime/contracts/workspace/values.js';
import { atomicWritePointJson, createNativePointAtomicWriteIO } from '../runtime/store/point-persistence.js';

const loaded = await import('../runtime/workspace-core/task-intake.js').catch(()=>({}));
test('native task intake matches Python single-job resolution and durable boundaries',{timeout:60000},async t=>{
  assert.equal(typeof loaded.TaskIntakeService,'function');
  const {TaskIntakeService} = loaded;
  const fixture = await nativeFixture();
  try {
    let serial=0;
    const isolated = async()=>{
      const state=await setup(fixture,`intake-${++serial}`);
      return {...state,service:new TaskIntakeService(state.repository,()=>fixed)};
    };
    await t.test('create, noop, refresh and human provenance protection',async()=>{
      const state=await isolated();
      await differential(state.service,state.root,join(fixture.root,'python-sequence'),[
        {payload:item('new',{role:'Agent role',source:'LinkedIn',sourceId:'42',priority:4,location:'Remote',workplaceType:'remote',employmentType:'full_time'})},
        {payload:item('new',{role:'Agent role',source:'LinkedIn',sourceId:'42',priority:4,location:'Remote',workplaceType:'remote',employmentType:'full_time'})},
        {payload:item('new',{role:'Agent refresh',company:'Agent company'})},
        {payload:item('new',{role:'Human role'}),origin:'human'},
        {payload:item('new',{role:'Ignored agent role',description:'PRIVATE DESCRIPTION'})},
        {payload:item('new',{description:'Human description'}),origin:'human'},
      ]);
      const result=plain(await state.service.intake(fromJSON(item('new'))));
      assert.equal(result.job.role,'Human role');
      assert.equal(result.action,'noop');
      assert.deepEqual(Object.keys(result.job).sort(),[
        'company','createdAt','employmentType','id','location','priority','revision','role','status','updatedAt','workplaceType',
      ].sort());
      assert.doesNotMatch(JSON.stringify(result),/PRIVATE|https:|provenance|sourceId|description|resume/);
    });
    await t.test('invalid input and identity conflicts expose only generic decision errors',async()=>{
      const state=await isolated();
      const doc=await read(state.root,'jobs.json');
      Object.assign(doc.jobs.job,{source:'LinkedIn',sourceId:'one'});
      Object.assign(doc.jobs.other,{source:'LinkedIn',sourceId:'two'});
      doc.jobs.deleted={...doc.jobs.job,id:'deleted',url:'https://example.invalid/deleted',normalizedUrl:'https://example.invalid/deleted',sourceId:'deleted',deletedAt:fixed};
      await write(state.root,'jobs.json',doc);
      await differential(state.service,state.root,join(fixture.root,'python-errors'),[
        ...[null,4,true,[],{}, {jobs:[]},item('invalid',{role:[]}),item('invalid',{status:'PRIVATE'})].map(payload=>({payload})),
        {payload:item('invalid',{priority:true})},
        {payloadJson:'{"url":"https://example.invalid/float","priority":1.0}'},
        {payload:item('new'),origin:'migration'},
        {payload:item('job',{source:'LinkedIn',sourceId:'two'})},
        {payload:item('job',{source:'Other'})},
        {payload:item('moved',{source:'LinkedIn',sourceId:'one'})},
        {payload:item('deleted')},
      ]);
      await unchanged(state.root,()=>state.service.intake(fromJSON({url:'PRIVATE INVALID URL'})),/^Error: task intake invalid$/);
      await unchanged(state.root,()=>state.service.intake(fromJSON(item('deleted'))),/^Error: task intake conflict$/);
    });
    await t.test('claimed jobs remain resolvable without modifying coordinator or session',async()=>{
      const state=await isolated();
      await state.claims.select('job',1n,true);
      await state.claims.acquire('job',text('Synthetic'),2n);
      await differential(state.service,state.root,join(fixture.root,'python-claimed'),[
        {payload:item('job',{description:'PRIVATE CLAIMED DESCRIPTION'})},
        {payload:item('job',{description:'PRIVATE CLAIMED DESCRIPTION'})},
      ]);
    });
    await t.test('concurrent duplicate intake converges on one creation without stale-token failures',async()=>{
      const state=await isolated();
      const incoming=fromJSON(item('concurrent',{role:'Concurrent role'}));
      const results=await Promise.all(Array.from({length:4},()=>new TaskIntakeService(
        new NativeJobsRepository(state.root,state.provider),()=>fixed).intake(incoming)));
      const values=results.map(plain);
      assert.equal(values.filter(value=>value.action==='create').length,1);
      assert.equal(values.filter(value=>value.action==='noop').length,3);
      assert.equal(new Set(values.map(value=>value.job.id)).size,1);
      const jobs=Object.values((await read(state.root,'jobs.json')).jobs);
      assert.equal(jobs.filter(job=>job.url==='https://example.invalid/concurrent').length,1);
      assert.equal(jobs.find(job=>job.url==='https://example.invalid/concurrent').revision,1);
    });
    await t.test('atomic write, sync and replacement failures retain old data and permit retry',async()=>{
      const state=await isolated();
      const incoming=fromJSON(item('fault'));
      for(const stage of ['write','sync','replace']) {
        const repository=new NativeJobsRepository(state.root,state.provider,async(path,value,options)=>{
          const io=createNativePointAtomicWriteIO(options.pathProfile);
          if(stage==='replace') io.replace=async()=>{throw Error('intake injected fault');};
          else {
            const original=io.createTemporary;
            io.createTemporary=async(...args)=>{
              const handle=await original(...args);
              handle[stage]=async()=>{throw Error('intake injected fault');};
              return handle;
            };
          }
          await atomicWritePointJson(path,value,options,io);
        });
        await unchanged(state.root,()=>new TaskIntakeService(repository,()=>fixed).intake(incoming),/intake injected fault/);
        assert.equal((await readdir(state.root)).some(name=>name.endsWith('.tmp')),false);
      }
      assert.equal(plain(await state.service.intake(incoming)).action,'create');
    });
  } finally {await fixture.cleanup();}
});

test('Python-free task intake CLI defaults to agent, redacts output and accepts large stdin',{timeout:60000},async()=>{
  const fixture=await nativeFixture();
  try {
    const {root}=await setup(fixture,'intake-cli');
    const payload=item('cli',{role:'CLI role',description:'PRIVATE '+ 'x'.repeat(81920)});
    const result=await stdin(fixture,root,payload);
    assert.equal(result.action,'create');
    assert.equal(result.job.role,'CLI role');
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE|https:|description|provenance/);
    const saved=await cli(fixture,root,'job-get',['--id',result.job.id]);
    assert.equal(saved.description,payload.description);
    assert.equal(saved.provenance['/role'].origin,'agent');
    const before=await snapshot(root);
    const file=await cli(fixture,root,'task-intake',[],payload);
    assert.equal(file.action,'noop');
    assert.deepEqual(file.job,result.job);
    assert.deepEqual(await snapshot(root),before);
    for(const args of [['--origin','migration'],['--unknown','x'],['--origin','agent','--origin','human']]) {
      await assert.rejects(()=>cli(fixture,root,'task-intake',args,payload));
    }
    await assert.rejects(()=>cli(fixture,root,'task-intake'),/input/);
    assert.deepEqual(await snapshot(root),before);
    assert.equal((await cli(fixture,root,'task-intake',['--origin','human'],item('cli',{role:'Human role'}))).action,'update');
    assert.equal((await cli(fixture,root,'task-intake',[],item('cli',{role:'Agent role'}))).job.role,'Human role');
  } finally {await fixture.cleanup();}
});
