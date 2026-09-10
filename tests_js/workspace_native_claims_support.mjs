import { readFile, writeFile, readdir, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initializeJobsFixture, NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { ClaimsService } from '../runtime/workspace-core/claims.js';
import { JobsService } from '../runtime/workspace-core/jobs.js';
import { ResumeService } from '../runtime/workspace-core/resumes.js';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';
export const plain = value => JSON.parse(serialize(value));
export const read = async (root,name) => JSON.parse(await readFile(join(root,name),'utf8'));
export const write = (root,name,value) => writeFile(join(root,name),JSON.stringify(value),{mode:0o600});
export async function snapshot(root) {
  const paths=(await readdir(root)).filter(path=>path.endsWith('.json')||path.endsWith('.jsonl'));
  paths.push(...(await readdir(join(root,'sessions'))).map(path=>`sessions/${path}`));
  return Object.fromEntries(await Promise.all(paths.map(async path=>[path,await readFile(join(root,path),'utf8')])));
}
export async function setup(fixture,name) {
  const root=join(await realpath(fixture.root),name);
  await initializeJobsFixture(root);
  const provider=loadPosixFlockProvider(fixture.receipt.artifact), repository=new NativeJobsRepository(root,provider);
  const clock={now:'2026-09-10T12:00:00Z'}, now=()=>clock.now;
  const jobs=new JobsService(repository,now), claims=new ClaimsService(repository,now);
  for(const id of ['job','other']) await jobs.create(fromJSON({id,url:`https://example.invalid/${id}`,role:'Engineer',company:'Synthetic',ats:'greenhouse'}));
  const profile=await read(root,'profile.json'); profile.profile.name='PRIVATE-PROFILE'; await write(root,'profile.json',profile);
  await new ResumeService(repository,now).import(fromJSON({id:'resume',label:'Synthetic',default:true}),'resume.txt',Buffer.from('PRIVATE-RESUME'));
  return {root,provider,repository,jobs,claims,clock};
}
export function readyPacket(attemptRevision) {
  const fixture=JSON.parse(readFileSync(new URL('../qa/fixtures/greenhouse-form-readiness-v1/fixture.json',import.meta.url),'utf8'));
  const controls=fixture.steps.flatMap(step=>step.controls), platformFamily=fixture.platformFamily;
  const requiredControlIds=controls.filter(control=>control.required).map(control=>control.id).sort();
  const fingerprint=createHash('sha256').update(JSON.stringify({platformFamily,requiredControlIds})).digest('hex');
  const kinds={textbox:'text',combobox:'selection',radiogroup:'selection',checkbox:'toggle',file:'upload'};
  return {attemptRevision,evidenceKind:'agent_attested_current_attempt',fixture,expectedObservationRevision:7,
    formManifest:{schemaVersion:1,platformFamily,observationRevision:7,requiredControlIds,controlSetFingerprint:`sha256:${fingerprint}`,complete:true},
    observation:{schemaVersion:1,platformFamily,observationRevision:7,adapterState:'accessible',uploadCapability:'available',
      controls:controls.map(control=>({controlId:control.id,kind:kinds[control.role],state:control.role==='file'?'accepted':'complete',observationRevision:7})),
      validationErrorControlIds:[],finalControlState:'available'}};
}
export async function cli(fixture,root,command,args=[],payload) {
  if(payload!==undefined) {
    const path=join(fixture.root,`input-${command}.json`);
    await writeFile(path,JSON.stringify(payload));args=[...args,'--input',path];
  }
  const result=await promisify(execFile)(process.execPath,['runtime/cli/native-jobs.js','--root',root,'--native-lock',fixture.receipt.artifact,command,...args],
    {cwd:new URL('../',import.meta.url),env:{PATH:''},timeout:15000});
  if(result.stderr) throw Error(result.stderr);
  return JSON.parse(result.stdout);
}
