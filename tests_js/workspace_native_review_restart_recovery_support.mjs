import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { child } from './exclusive_file_lock_support.mjs';
import { setup, plain, readyPacket } from './workspace_native_claims_support.mjs';
import { fromJSON, text } from '../runtime/contracts/workspace/values.js';

export const fixed = '2026-09-10T12:00:00Z';
export const names = ['jobs.json','sessions/job.json','applications.jsonl','coordinator.json','coordinator-journal.json'];
const moduleUrl = path => new URL(`../runtime/${path}.js`,import.meta.url).href;
const imports = `
import {relative,join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {NativeJobsRepository} from ${JSON.stringify(moduleUrl('store/native-jobs'))};
import {loadPosixFlockProvider} from ${JSON.stringify(moduleUrl('store/posix-flock'))};
import {atomicWritePointJson} from ${JSON.stringify(moduleUrl('store/point-persistence'))};
import {ClaimsService} from ${JSON.stringify(moduleUrl('workspace-core/claims'))};
import {get,serialize,text} from ${JSON.stringify(moduleUrl('contracts/workspace/values'))};
const [root,addon,boundary] = process.argv.slice(1);
`;
const writerScript = imports + `
let intended;
async function checkpoint(stage) {
  if(stage !== boundary) return;
  console.log(JSON.stringify({intended}));
  console.log('durable-boundary');
  await new Promise(resolve => {
    globalThis.pausedRestartResolve=resolve;
    process.stdin.resume();
  });
}
const repository = new NativeJobsRepository(root,loadPosixFlockProvider(addon),async(path,document,options)=>{
  const name=relative(root,path);
  if(name.startsWith('sessions/')) throw Error('Restart must not rewrite prior session');
  if(name==='coordinator-journal.json' && get(document,'operation')!==null) intended=JSON.parse(serialize(get(document,'operation')));
  await atomicWritePointJson(path,document,options);
  await checkpoint(name==='coordinator-journal.json' ? get(document,'operation')===null ? 'clear':'journal':name);
},checkpoint);
await new ClaimsService(repository,()=>${JSON.stringify(fixed)}).restart('job',text('Restart owner'),4n,true);
throw Error('Writer unexpectedly passed its kill boundary');
`;
const recoveryScript = imports + `
await new NativeJobsRepository(root,loadPosixFlockProvider(addon)).transaction(async()=>{});
const bytes={};
for(const name of ${JSON.stringify(names)}) bytes[name]=await readFile(join(root,name),'utf8');
console.log(JSON.stringify(bytes));
`;
export async function seed(fixture,name,legacy=false) {
  const state=await setup(fixture,name), {root,claims}=state;
  await claims.select('job',1n,true);
  const acquired=plain(await claims.acquire('job',text('Prior owner'),2n));
  await claims.handoff('job',text(acquired.token),'awaiting_review',fromJSON({status:'review',readinessInput:readyPacket(3)}),3n);
  const path=join(root,'sessions/job.json');
  const session=JSON.parse(await readFile(path,'utf8'));
  if(legacy) {
    for(const field of ['attemptRevision','readiness','browserHandoff']) delete session[field];
    session.step='final_review';
  }
  // Deliberate noncanonical formatting detects read/normalize/rewrite of prior evidence.
  const sessionBytes=`\n${JSON.stringify(session,null,3)}\n\n`;
  await writeFile(path,sessionBytes,{mode:0o600});
  return {...state,token:acquired.token,sessionBytes};
}
export async function killAt(root,addon,boundary) {
  const writer=child(writerScript,[root,addon,boundary]);
  try {
    await writer.line('durable-boundary');
    const intended=JSON.parse(writer.lines.find(line=>line.startsWith('{'))).intended;
    assert.equal(writer.process.kill('SIGKILL'),true);
    assert.deepEqual(await writer.exited,{code:null,signal:'SIGKILL'});
    return intended;
  } finally {await writer.stop();}
}
export async function recover(root,addon) {
  const process=child(recoveryScript,[root,addon]);
  try {
    await process.success();
    return JSON.parse(process.lines.find(line=>line.startsWith('{')));
  } finally {await process.stop();}
}
export async function bytes(root) {
  return Object.fromEntries(await Promise.all(names.map(async name=>[name,await readFile(join(root,name),'utf8')])));
}
