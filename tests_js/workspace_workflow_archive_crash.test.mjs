import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture, child } from './exclusive_file_lock_support.mjs';
import { setup, read, write, snapshot, host, event } from './workspace_durable_claims_support.mjs';
import { NativeWorkflowArchive } from '../runtime/store/native-workflow-archive.js';
import { fullLedger } from './workspace_workflow_archive_support.mjs';
const url=path=>new URL(path,import.meta.url).href;
const script=`
import {relative} from 'node:path';
import {host,event} from ${JSON.stringify(url('./workspace_durable_claims_support.mjs'))};
import {loadPosixFlockProvider} from ${JSON.stringify(url('../runtime/store/posix-flock.js'))};
import {get} from ${JSON.stringify(url('../runtime/contracts/workspace/values.js'))};
const [root,artifact,boundary]=process.argv.slice(1);
const state={root,provider:loadPosixFlockProvider(artifact),clock:{now:'2026-09-10T12:00:00Z'}};
async function checkpoint(stage) {
 if(stage===boundary){console.log('archive-boundary');await new Promise(()=>setInterval(()=>{},1000));}
}
const writer=host(state,{checkpoint,after:async(path,value)=>checkpoint(relative(root,path)==='coordinator-journal.json'
 ? get(value,'operation')===null?'clear':'journal':relative(root,path))});
const request=event('acquire');
await writer.workflow.execute(request,request);
throw Error('passed kill boundary');
`;
async function bytes(root) {
  const result=await snapshot(root);
  let files;try{files=await readdir(join(root,'workflow-archive'));}catch{files=[];}
  for(const name of files)result[`workflow-archive/${name}`]=(await readFile(join(root,'workflow-archive',name))).toString('base64');
  return result;
}

test('SIGKILL at archive data, journal, hot-root and clear boundaries recovers exact replay', {timeout:60000},async t=>{
  const fixture=await nativeFixture();t.after(()=>fixture.cleanup());
  const stages=['archive_file_written','archive_file_synced','archive_segment_published','journal','jobs.json','clear'];
  for(const stage of stages)await t.test(stage,async()=>{
    const state=await setup(fixture,stage.replaceAll('.','-'));await state.claims.select('job',1n,true);
    const jobs=await read(state.root,'jobs.json');jobs.metadata.agentWorkflows=fullLedger(new NativeWorkflowArchive(state.root));await write(state.root,'jobs.json',jobs);
    const writer=child(script,[state.root,fixture.receipt.artifact,stage]);
    try {
      await writer.line('archive-boundary');assert.equal(writer.process.kill('SIGKILL'),true);
      assert.deepEqual(await writer.exited,{code:null,signal:'SIGKILL'});
    } finally {await writer.stop();}
    const replacement=host(state);
    await replacement.repository.transaction(async()=>{});
    const request=event('acquire'),result=await replacement.workflow.execute(request,request);
    assert.equal(result.replayed,['journal','jobs.json','clear'].includes(stage));
    const archived=await new NativeWorkflowArchive(state.root).prepare((await read(state.root,'jobs.json')).metadata.agentWorkflows);
    assert.equal(archived.history.receipt('op-task-0').receipt.operationId,'op-task-0');
    const before=await bytes(state.root);
    assert.equal((await host(state).workflow.execute(request,request)).replayed,true);
    await replacement.repository.transaction(async()=>{});assert.deepEqual(await bytes(state.root),before);
    assert.equal((await host(state).workflow.inspect()).brokerAvailable,false);
    assert.equal((await read(state.root,'coordinator-journal.json')).operation,null);
  });
});
