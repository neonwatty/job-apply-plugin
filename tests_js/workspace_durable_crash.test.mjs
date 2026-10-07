import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, symlink, chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture, child } from './exclusive_file_lock_support.mjs';
import { setup, read, runtime, reply, waiting, snapshot } from './workspace_durable_preparation_support.mjs';
const moduleUrl=name=>new URL(`../runtime/${name}.js`,import.meta.url).href;
const writer=`
import {join} from 'node:path';
import {NativeJobsRepository} from ${JSON.stringify(moduleUrl('store/native-jobs'))};
import {NativeWorkflowTasks} from ${JSON.stringify(moduleUrl('store/native-workflow-tasks'))};
import {atomicWritePointJson,createNativePointAtomicWriteIO} from ${JSON.stringify(moduleUrl('store/point-persistence'))};
import {atomicWorkflowJobsWrite} from ${JSON.stringify(moduleUrl('store/workflow-atomic-write'))};
import {loadPosixFlockProvider} from ${JSON.stringify(moduleUrl('store/posix-flock'))};
import {PreparationWorkflow} from ${JSON.stringify(moduleUrl('app/preparation-workflow'))};
import {preparationProfile} from ${JSON.stringify(moduleUrl('workflows/applications/prepare'))};
const [root,artifact,boundary,eventText]=process.argv.slice(1), event=JSON.parse(eventText);
async function checkpoint(stage) {
 if(stage!==boundary)return;
 console.log('boundary'); await new Promise(()=>{setInterval(()=>{},1000);});
}
const repository=new NativeJobsRepository(root,loadPosixFlockProvider(artifact),async(path,value,options)=>{
 if(path!==join(root,'jobs.json'))return atomicWritePointJson(path,value,options);
 const io=createNativePointAtomicWriteIO(options.pathProfile);
 await atomicWorkflowJobsWrite(path,value,options,{...io,replace:async(source,destination)=>{
  await checkpoint('before_rename'); await io.replace(source,destination); await checkpoint('after_rename');
 }});
});
const workflow=new PreparationWorkflow(new NativeWorkflowTasks(repository),()=>({enabled:[preparationProfile],authorized:[preparationProfile]}));
await workflow.route(event.proposal,event.attestation);
throw Error('missing crash boundary');
`;
test('SIGKILL before and after rename preserves atomic job/event state and replays once', {timeout:60000},async()=>{
  const fixture=await nativeFixture();
  try {
    for(const boundary of ['before_rename','after_rename']) {
      const state=await setup(fixture,boundary), app=runtime(state), task=await waiting(app.workflow), event=reply(task);
      const before=await snapshot(state.root), process=child(writer,[state.root,fixture.receipt.artifact,boundary,JSON.stringify(event)]);
      try {
        await process.line('boundary');process.process.kill('SIGKILL');
        assert.deepEqual(await process.exited,{code:null,signal:'SIGKILL'});
      } finally {await process.stop();}
      const stored=await read(state.root,'jobs.json');
      assert.equal(stored.jobs.job.status,boundary==='before_rename'?'saved':'ready');
      assert.equal(Boolean(stored.metadata.agentWorkflows.receipts.reply),boundary==='after_rename');
      const fresh=runtime(state), result=await fresh.workflow.route(event.proposal,event.attestation);
      assert.equal(result.replayed,boundary==='after_rename');
      assert.equal((await read(state.root,'jobs.json')).jobs.job.revision,2);
      assert.equal((await readdir(state.root)).filter(name=>name.startsWith('.workflow-jobs.')).length,0);
      const after=await snapshot(state.root);
      assert.deepEqual(Object.keys(after).filter(key=>before[key]!==after[key]),['jobs.json']);
      await fresh.workflow.route(event.proposal,event.attestation);
      assert.deepEqual(await snapshot(state.root),after);
    }
  } finally {await fixture.cleanup();}
});
test('temporary recovery rejects symlinks and unsafe permissions without touching their targets', {timeout:30000},async()=>{
  const fixture=await nativeFixture();
  try {
    for(const kind of ['symlink','mode']) {
      const state=await setup(fixture,kind), name=join(state.root,'.workflow-jobs.abcdefgh.tmp');
      const before=await snapshot(state.root);
      if(kind==='symlink')await symlink(join(state.root,'jobs.json'),name);
      else {await writeFile(name,'partial');await chmod(name,0o644);}
      await assert.rejects(runtime(state).workflow.inspect());
      assert.deepEqual(await snapshot(state.root),before);
    }
  } finally {await fixture.cleanup();}
});
