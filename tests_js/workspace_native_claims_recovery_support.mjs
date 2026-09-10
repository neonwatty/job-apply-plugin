import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { child } from './exclusive_file_lock_support.mjs';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { initializeJobsFixture, NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { atomicWritePointJson } from '../runtime/store/point-persistence.js';
import { JobsService } from '../runtime/workspace-core/jobs.js';
import { ResumeService } from '../runtime/workspace-core/resumes.js';
import { ClaimsService } from '../runtime/workspace-core/claims.js';
import { fromJSON, serialize, text } from '../runtime/contracts/workspace/values.js';
export const fixed = '2026-09-10T12:00:00Z';
export const options = {pathProfile:'3.12',intMaxStrDigits:4300};
export const names = ['jobs.json','sessions/job.json','applications.jsonl','coordinator.json','coordinator-journal.json'];
const plain = value => JSON.parse(serialize(value));
const moduleUrl = path => new URL(`../runtime/${path}.js`,import.meta.url).href;
const imports = `
import {relative,join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {NativeJobsRepository} from ${JSON.stringify(moduleUrl('store/native-jobs'))};
import {loadPosixFlockProvider} from ${JSON.stringify(moduleUrl('store/posix-flock'))};
import {atomicWritePointJson} from ${JSON.stringify(moduleUrl('store/point-persistence'))};
import {ClaimsService} from ${JSON.stringify(moduleUrl('workspace-core/claims'))};
import {get,serialize,fromJSON,text} from ${JSON.stringify(moduleUrl('contracts/workspace/values'))};
const [root,addon,boundary,token] = process.argv.slice(1);
`;
export const incoming = {status:'active',blockers:[{type:'information',code:'owner-input-required'}]};
const writerScript = imports + `
let intended;
async function checkpoint(stage) {
  if(stage !== boundary) return;
  console.log(JSON.stringify({intended}));
  console.log('durable-boundary');
  await new Promise(() => {setInterval(()=>{},1000);});
}
const repository = new NativeJobsRepository(root,loadPosixFlockProvider(addon),async(path,document,options)=>{
  const name=relative(root,path);
  if(name==='coordinator-journal.json' && get(document,'operation')!==null) intended=JSON.parse(serialize(get(document,'operation')));
  await atomicWritePointJson(path,document,options);
  await checkpoint(name==='coordinator-journal.json' ? get(document,'operation')===null ? 'clear':'journal':name);
},checkpoint);
await new ClaimsService(repository,()=>${JSON.stringify(fixed)}).handoff('job',text(token),'needs_info',fromJSON(${JSON.stringify(incoming)}),2n);
throw Error('Writer unexpectedly passed its kill boundary');
`;
const recoveryScript = imports + `
await new NativeJobsRepository(root,loadPosixFlockProvider(addon)).transaction(async()=>{});
const bytes={};
for(const name of ${JSON.stringify(names)}) bytes[name]=await readFile(join(root,name),'utf8');
console.log(JSON.stringify(bytes));
`;
export async function seed(fixture,name) {
  const root=join(await realpath(fixture.root),name),provider=loadPosixFlockProvider(fixture.receipt.artifact);
  await initializeJobsFixture(root);
  const repository=new NativeJobsRepository(root,provider);
  await new JobsService(repository,()=>fixed).create(fromJSON({id:'job',url:'https://example.invalid/job',role:'Engineer',company:'Fixture'}));
  const jobs=JSON.parse(await readFile(join(root,'jobs.json'),'utf8'));
  jobs.jobs.job.status='ready';
  await atomicWritePointJson(join(root,'jobs.json'),fromJSON(jobs),options);
  const profile=JSON.parse(await readFile(join(root,'profile.json'),'utf8'));
  profile.profile.name='Synthetic Owner';
  await atomicWritePointJson(join(root,'profile.json'),fromJSON(profile),options);
  await new ResumeService(repository,()=>fixed).import(fromJSON({id:'resume',label:'Fixture',default:true}),'fixture.txt',Buffer.from('Synthetic resume'));
  const service=new ClaimsService(repository,()=>fixed);
  const {token}=plain(await service.acquire('job',text('Fixture worker'),1n));
  await service.progress('job',text(token),fromJSON(incoming));
  return {root,provider,token,repository};
}
export async function killAt(root,addon,boundary,token) {
  const writer=child(writerScript,[root,addon,boundary,token]);
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
