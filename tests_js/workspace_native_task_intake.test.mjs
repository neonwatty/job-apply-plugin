import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, read, write, plain, snapshot } from './workspace_native_claims_support.mjs';
import { fixed, item, differential, unchanged } from './workspace_native_task_intake_support.mjs';
import { NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { fromJSON, text } from '../runtime/contracts/workspace/values.js';

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
  } finally {await fixture.cleanup();}
});
