import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, readFile, rm, writeFile, access, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { ResumeFactsService } from '../runtime/workspace-core/resume-facts.js';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';
import { setup, snapshot, read, write } from './workspace_durable_claims_support.mjs';
import { sameChatRecovery } from '../apps/companion/same-chat-recovery.mjs';
import { packageNativeLock } from '../scripts/smoke/package_native_lock.mjs';

const source = new URL('../', import.meta.url).pathname;
test('installed owner route explicitly activates private clone and scopes durable handoff', {timeout:90000}, async t => {
  const fixture=await nativeFixture();t.after(()=>fixture.cleanup());
  const state=await setup(fixture,'owner-source');
  const facts=new ResumeFactsService(state.repository),plain=v=>JSON.parse(serialize(v));
  const draft=plain(await facts.createDraft('resume',fromJSON({name:'Fictional Owner'}),1n,null));
  const confirmed=plain(await facts.confirm('resume',BigInt(draft.revision),draft.contentRevision));
  const jobs=await read(state.root,'jobs.json');
  jobs.metadata.applicationRuns.runs['run-fixture'].selection.factRevision=confirmed.revision;
  await write(state.root,'jobs.json',jobs);
  await state.claims.select('job',1n,true);
  const directory=await realpath(fixture.root);
  const root=join(directory,'owner-store'),plugin=join(directory,'installed');
  await cp(state.root,root,{recursive:true});
  assert.equal(root,await realpath(root),'installed test uses canonical Store root');
  await rm(join(root,'.native-jobs-fixture'));
  // Reproduce the pre-native Store layout: this journal is native-only.
  await rm(join(root,'resume-operation.json'));
  await mkdir(plugin);
  for(const path of ['runtime','native','apps/companion','package.json']) {
    await cp(join(source,path),join(plugin,path),{recursive:true,filter:p=>!p.includes('node_modules')&&!p.includes('/.next')&&!p.includes('/dist')});
  }
  const recovery = await import(new URL(`file://${join(plugin,'apps/companion/ats-recovery.mjs')}`));
  assert.equal(recovery.atsRecovery({ats:'workday', draft:'present', observation:'current',
    session:'unknown', failure:'generic_save', refreshApproved:false},
    {save:0, afterSignIn:0, refresh:0}).next, 'inspect_session_separate_tab');
  assert.equal(recovery.questionBatch([{required:true,state:'missing'}],true).next,
    'guarded_needs_info_then_ask_batch');
  assert.equal(recovery.applicationProgress({entered:true,verified:true,pageAdvanced:true,
    persistenceConfirmed:false}).persistence, 'unknown');
  await packageNativeLock(plugin);
  const command=join(plugin,'apps/companion/command.mjs'),file=join(fixture.root,'owner-input.json');
  const env={PATH:'',HOME:fixture.root};
  const call=async (operation,extra=[],surface='owner-workflow',selected=root)=> {
    try {const r=await promisify(execFile)(process.execPath,[command,surface,operation,'--root',selected,...extra],{env,timeout:5000});return JSON.parse(r.stdout);}
    catch(e){assert.equal(e.code,2,e.stderr);return JSON.parse(e.stdout);}
  };
  const before=await snapshot(root);
  assert.equal((await call('recovery-context',['--job-id','job'])).ok,false);
  assert.deepEqual(await snapshot(root),before);
  assert.equal((await call('serve',['--job-id','job'])).ok,false);
  assert.equal((await call('context',['--job-id','job'])).ok,false);
  assert.deepEqual(await snapshot(root),before);
  await assert.rejects(access(join(root,'.native-store-clone')));
  assert.equal((await call('serve',['--job-id','job','--host-user-event'],'owner-workflow',state.root)).ok,false);
  const child=spawn(process.execPath,[command,'owner-workflow','serve','--root',root,'--job-id','job','--host-user-event'],{env,stdio:['ignore','pipe','pipe']});
  let stderr='',stdout='';child.stderr.on('data',b=>stderr+=b);child.stdout.on('data',b=>stdout+=b);
  const done=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await done;});
  let context;
  for(let n=0;n<150;n++){context=await call('host-browser-context',['--job-id','job']);if(context.ok)break;if(child.exitCode!==null)break;await delay(25);}
  assert.equal(context?.ok,true,JSON.stringify({context,stderr,stdout}));
  assert.equal(context.ownerWorkflow,1);
  assert.equal(context.result.ownerScope.jobId,'job');
  assert.equal(JSON.parse(await readFile(join(root,'.native-store-clone'),'utf8')).mode,'canonical-store-clone');
  assert.deepEqual(await readFile(join(root+'.python-rollback','jobs.json')),await readFile(join(state.root,'jobs.json')));
  const send=async (event,attested=false,operation='event')=>{await writeFile(file,JSON.stringify(event),{mode:0o600});return call(operation,['--input',file,...attested?['--host-user-event']:[]]);};
  const acquire={...context.result.guidance.actions.find(a=>a.kind==='acquire').input,operationId:'owner-acquire'};
  assert.equal((await send({...acquire,jobId:'other'},true)).ok,false);
  assert.equal((await send(acquire)).ok,false);
  assert.equal((await send(acquire,true)).ok,true);
  const owned=await call('host-browser-context',['--job-id','job']);
  const initialize={...owned.result.hostBrowser.recovery.input,operationId:'owner-fresh-draft',mode:'fresh_draft',
    evidence:{ats:'workday',draft:'present',observation:'current',session:'authenticated',failure:'none',refreshApproved:false}};
  assert.equal((await send(initialize,false,'recovery')).ok,false);
  const registered=await send(initialize,true,'recovery');
  assert.equal(registered.ok,true,JSON.stringify(registered));
  const retry={...initialize,operationId:'owner-save-retry',mode:'decide',
    draftId:registered.result.state.draftId,recoveryRevision:registered.result.state.revision,
    evidence:{...initialize.evidence,failure:'generic_save'}};
  const reserved=await send(retry,false,'recovery');
  assert.equal(reserved.result.actionReserved,true);
  const reservationReplay=await send(retry,false,'recovery');
  assert.equal(reservationReplay.result.replayed,true);
  assert.equal(reservationReplay.result.actionReserved,false);
  const activeSnapshot=await snapshot(root);
  assert.equal((await call('recovery-context',['--job-id','job'])).ok,false);
  assert.deepEqual(await snapshot(root),activeSnapshot);
  context=await call('host-browser-context',['--job-id','job']);
  assert.equal((await call('context',['--job-id','other'])).ok,false);
  const base=context.result.hostBrowser.reports.find(a=>a.input.outcome==='progress').input;
  const progress={...base,operationId:'owner-progress',session:{...base.session,step:'questions',handoffChecklist:['resume_upload']}};
  assert.equal((await send(progress,false,'host-browser-report')).ok,true);
  context=await call('host-browser-context',['--job-id','job']);
  const handoff=context.result.hostBrowser.reports.find(a=>a.input.outcome==='needs_info').input;
  const terminal={...handoff,operationId:'owner-handoff'};
  const result=await send(terminal,false,'host-browser-report');
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.result.receipt.outcome,'needs_info');
  assert.deepEqual(await Promise.race([done,delay(5000).then(()=>({timeout:true}))]),{code:0,signal:null});
  assert.equal(stderr,'');
  const after=await snapshot(root);
  assert.equal(JSON.parse(after['coordinator.json']).claim,null);
  assert.equal(JSON.parse(after['jobs.json']).jobs.job.status,'needs_info');
  assert.equal(after['resumes.json'],before['resumes.json']);
  assert.equal(after['profile.json'],before['profile.json']);
  assert.equal(after['resume-facts.json'],before['resume-facts.json']);
  assert.deepEqual(JSON.parse(after['jobs.json']).jobs.other,JSON.parse(before['jobs.json']).jobs.other);
  await assert.rejects(access(join(root,'.job-apply-attempt.pid')));
  assert.equal((await call('context',['--job-id','job'])).ok,false);
  const paused=await call('recovery-context',['--job-id','job']);
  assert.equal(paused.ok,true);
  assert.equal(paused.result.readOnly,true);
  assert.deepEqual(paused.result.recovery,reserved.result.state);
  assert.equal(paused.result.guidance.selection.status,'needs_info');
  assert.deepEqual(paused.result.broker,{connected:false,ownsClaim:false});
  assert.deepEqual(paused.result.guidance.actions,[]);
  assert.deepEqual(paused.result.hostBrowser.reports,[]);
  assert.equal(paused.result.guidance.selection.inputsCurrent,false);
  assert.equal(sameChatRecovery(paused.result,{chatScope:'same',draft:'present',observation:'current',formScope:'same'}).next,'resolve_workflow_blocker');
  assert.deepEqual(await snapshot(root),after);
  for(const args of [[],['--job-id','missing'],['--job-id','job','--host-user-event']]) {
    assert.equal((await call('recovery-context',args)).ok,false);
    assert.deepEqual(await snapshot(root),after);
  }
  const journal=await readFile(join(root,'coordinator-journal.json'));
  await writeFile(join(root,'coordinator-journal.json'),JSON.stringify({schemaVersion:1,operation:{kind:'unfinished'}}));
  const unfinished=await snapshot(root);
  assert.equal((await call('recovery-context',['--job-id','job'])).ok,false);
  assert.deepEqual(await snapshot(root),unfinished,'inspection must not repair pending journals');
  await writeFile(join(root,'coordinator-journal.json'),journal);
  const replay=await call('receipt',['--input',file]);
  assert.equal(replay.ok,true);assert.equal(replay.result.replayed,true);
  assert.deepEqual(replay.result.receipt,result.result.receipt);
  assert.deepEqual(await snapshot(root),after);
  await writeFile(file,JSON.stringify({...terminal,jobRevision:'999'}));
  assert.equal((await call('receipt',['--input',file])).ok,false);
  assert.deepEqual(await snapshot(root),after);
});
