import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {cp,mkdir,rm,writeFile,realpath,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {nativeFixture} from './exclusive_file_lock_support.mjs';
import {setup,read,write,snapshot} from './workspace_durable_claims_support.mjs';
import {ResumeFactsService} from '../runtime/workspace-core/resume-facts.js';
import {fromJSON,serialize} from '../runtime/contracts/workspace/values.js';
import {packageNativeLock} from '../scripts/smoke/package_native_lock.mjs';
import {buildReadinessPacket} from '../apps/companion/readiness-packet.mjs';

const source=new URL('../',import.meta.url).pathname;
/** Private fictional Store copied through the same installed native activation as owner opt-in. */
export async function ownerReviewFixture({ordinaryReview=false}={}) {
  const fixture=await nativeFixture();let child,done;
  const cleanup=async()=>{
    if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    if(done)await done;
    await fixture.cleanup();
  };
  try {
    const state=await setup(fixture,'review-source'),facts=new ResumeFactsService(state.repository);
    const plain=v=>JSON.parse(serialize(v));
    const draft=plain(await facts.createDraft('resume',fromJSON({name:'Fictional Review Applicant'}),1n,null));
    const confirmed=plain(await facts.confirm('resume',BigInt(draft.revision),draft.contentRevision));
    const jobs=await read(state.root,'jobs.json');
    jobs.metadata.applicationRuns.runs['run-fixture'].selection.factRevision=confirmed.revision;
    await write(state.root,'jobs.json',jobs);await state.claims.select('job',1n,true);
    if(ordinaryReview) {
      const acquired=plain(await state.claims.acquire('job',fromJSON('ordinary'),2n));
      await state.claims.handoff('job',fromJSON(acquired.token),'awaiting_review',
        fromJSON({...reviewSession(acquired.job.revision),attemptRevision:acquired.job.revision}),BigInt(acquired.job.revision));
    }
    const directory=await realpath(fixture.root),root=join(directory,'owner-store'),plugin=join(directory,'installed');
    await cp(state.root,root,{recursive:true});
    await rm(join(root,'.native-jobs-fixture'));await rm(join(root,'resume-operation.json'));
    await mkdir(plugin);
    for(const path of ['runtime','native','apps/companion','package.json'])await cp(join(source,path),join(plugin,path),{
      recursive:true,filter:p=>!p.includes('node_modules')&&!p.includes('/.next')&&!p.includes('/dist')});
    await packageNativeLock(plugin);
    const command=join(plugin,'apps/companion/command.mjs'),env={PATH:'',HOME:directory};
    const invoke=async args=>{
      try{const result=await promisify(execFile)(process.execPath,args,{env,timeout:15000});return JSON.parse(result.stdout);}
      catch(error){if(error.code!==2)throw error;return JSON.parse(error.stdout);}
    };
    const call=(operation,extra=[])=>invoke([command,'owner-workflow',operation,'--root',root,...extra]);
    child=spawn(process.execPath,[command,'owner-workflow','serve','--root',root,'--job-id','job','--host-user-event'],{
      env,stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
    done=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
    let context;
    for(let n=0;n<150;n++){
      context=await call('host-browser-context',['--job-id','job']);if(context.ok)break;
      if(child.exitCode!==null)break;await delay(25);
    }
    assert.equal(context?.ok,true,JSON.stringify({context,output}));
    const send=async(input,operation='host-browser-report',attested=false)=>{
      const path=join(directory,`input-${randomUUID()}.json`);
      await writeFile(path,JSON.stringify(input),{mode:0o600});
      try{return await call(operation,['--input',path,...attested?['--host-user-event']:[]]);}
      finally{await rm(path,{force:true});}
    };
    if(!ordinaryReview) {
      const acquisition={...context.result.guidance.actions.find(a=>a.kind==='acquire').input,operationId:'review-acquire'};
      assert.equal((await send(acquisition,'event',true)).ok,true);
    }
    const resume=await invoke([command,'store','--root',root,'resume-resolve','--id','resume']);
    const guard=()=>invoke([join(plugin,'apps/companion/resume-upload-guard.mjs'),'--root',root,
      '--id',resume.id,'--expected-revision',String(resume.revision),'--candidate-path',resume.path]);
    return {root,plugin,directory,resume,guard,send,call,done,cleanup,
      context:()=>call('host-browser-context',['--job-id','job']),
      snapshot:()=>snapshot(root),read:name=>read(root,name),
      resumeBytes:()=>readFile(resume.path),
      waitForExit:()=>Promise.race([done,delay(5000).then(()=>{throw Error('owner broker did not exit');})])};
  }catch(error){await cleanup();throw error;}
}

/** Deterministic fixture evidence only; the host trial supplies its own browser observations. */
export function reviewSession(attemptRevision,change=()=>{}) {
  const input={attemptRevision:Number(attemptRevision),platformFamily:'greenhouse',observationRevision:1,complete:true,
    inventories:[{controls:[{id:'contact.email',role:'textbox',required:true},{id:'resume.file',role:'file',required:true},
      {id:'portfolio.url',role:'textbox',required:false}]},{controls:[{id:'work.preference',role:'combobox',required:true}]}],
    verifiedStates:[{id:'contact.email',state:'complete'},{id:'resume.file',state:'accepted'},{id:'work.preference',state:'complete'}],
    adapterState:'accessible',uploadCapability:'available',validationErrorControlIds:[],finalControlState:'available'};
  change(input);
  return {status:'review',step:'final_review',attemptRevision:String(attemptRevision),pendingFields:[],blockers:[],handoffChecklist:[],
    browserHandoff:{state:'ready_for_owner',reasonCode:'final-review-required',revision:1},
    readinessInput:buildReadinessPacket(input).readinessInput};
}
