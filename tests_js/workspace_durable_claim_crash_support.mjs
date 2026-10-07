import assert from 'node:assert/strict';
import { child } from './exclusive_file_lock_support.mjs';
const url=path=>new URL(path,import.meta.url).href;
const script=`
import {relative} from 'node:path';
import {host,event} from ${JSON.stringify(url('./workspace_durable_claims_support.mjs'))};
import {loadPosixFlockProvider} from ${JSON.stringify(url('../runtime/store/posix-flock.js'))};
import {get} from ${JSON.stringify(url('../runtime/contracts/workspace/values.js'))};
const [root,artifact,kind,boundary]=process.argv.slice(1);
const state={root,provider:loadPosixFlockProvider(artifact),clock:{now:'2026-09-10T12:00:00Z'}};
let armed=false;
async function checkpoint(stage) {
 if(armed && stage===boundary) {console.log('durable-boundary');await new Promise(()=>{setInterval(()=>{},1000);});}
}
const options={after:async(path,value)=>checkpoint(relative(root,path)==='coordinator-journal.json'
 ? get(value,'operation')===null?'clear':'journal':relative(root,path)),checkpoint};
let workflow=host(state,options).workflow;
let request=event('acquire');
if(kind!=='acquire') {
 const task=(await workflow.execute(request,request)).receipt.task;
 request=event(kind,task);
 if(kind==='recover') {await workflow.close();state.clock.now='2026-09-10T12:05:00Z';workflow=host(state,options).workflow;}
}
console.log(JSON.stringify({request,now:state.clock.now}));
armed=true;
await workflow.execute(request,request);
throw Error('passed kill boundary');
`;
export async function killClaimAt(state,fixture,kind,boundary) {
  const writer=child(script,[state.root,fixture.receipt.artifact,kind,boundary]);
  try {
    await writer.line('durable-boundary');
    const data=JSON.parse(writer.lines.find(line=>line.startsWith('{')));
    assert.equal(writer.process.kill('SIGKILL'),true);
    assert.deepEqual(await writer.exited,{code:null,signal:'SIGKILL'});
    state.clock.now=data.now;
    return data.request;
  } finally {await writer.stop();}
}
