import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { initializeJobsFixture, NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { atomicWritePointJson } from '../runtime/store/point-persistence.js';
import { AnswersService } from '../runtime/workspace-core/answers.js';
import { AnswerMergeService } from '../runtime/workspace-core/answer-merges.js';
import { JobsService } from '../runtime/workspace-core/jobs.js';
import { jobsHttp } from '../runtime/workspace-core/jobs-http.js';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';
const at='2026-09-09T12:00:00Z';
const plain=value=>JSON.parse(serialize(value));
const records=[{key:'winner',question:'Does the applicant have permission to work in this jurisdiction?',state:'confirmed',value:'PRIVATE-WINNER'},{key:'source',question:'Is employment authorization available in the country?',state:'inferred',value:'PRIVATE-SOURCE'}];
const session={schemaVersion:1,applicationId:'job',status:'active',answerKeys:['source','winner'],pendingFields:[{answerKey:'source',state:'missing',reference:'pending_'+'a'.repeat(32)}],approvals:[],createdAt:at,updatedAt:at};
const history={schemaVersion:1,eventId:'history-event',applicationId:'job',event:'saved',answerKeys:['source'],at};
async function setup(fixture,name) {
 const root=join(await realpath(fixture.root),name);await initializeJobsFixture(root);
 const provider=loadPosixFlockProvider(fixture.receipt.artifact),repository=new NativeJobsRepository(root,provider),answers=new AnswersService(repository,()=>at);
 for(const record of records) await answers.put(fromJSON(record));
 await writeFile(join(root,'sessions/job.json'),JSON.stringify(session),{mode:0o600});
 await writeFile(join(root,'applications.jsonl'),JSON.stringify(history)+'\n',{mode:0o600});
 return {root,provider,repository,answers};
}
test('durable merge preserves Python result, session rewrites, history and redirected counts', {timeout:60000}, async()=>{
 const fixture=await nativeFixture();try {
  const {root,repository,answers}=await setup(fixture,'parity');
  const result=plain(await new AnswerMergeService(repository,()=>at).merge('winner','source',1n,1n));
  const script=`import json,sys,importlib.util\nfrom pathlib import Path\nsys.path.insert(0,'scripts')\nspec=importlib.util.spec_from_file_location('merge_reference','scripts/job-apply-store.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nm.utc_now=lambda:sys.argv[2]\ns=m.Store(Path(sys.argv[1]));s.initialize()\nfor record in json.loads(sys.argv[3]):s.put_answer(record)\ns._session_path('job').write_text(sys.argv[4]);s.history_path.write_text(sys.argv[5]+'\\n')\nresult=s.merge_answers('winner','source',1,1)\nprint(json.dumps({'result':result,'session':json.loads(s._session_path('job').read_text())}))`;
  const expected=JSON.parse(execFileSync('python3',['-c',script,join(fixture.root,'python'),at,JSON.stringify(records),JSON.stringify(session),JSON.stringify(history)],{encoding:'utf8'}));
  assert.deepEqual(result,expected.result);
  assert.deepEqual(JSON.parse(await readFile(join(root,'sessions/job.json'),'utf8')),expected.session);
  assert.equal(await readFile(join(root,'applications.jsonl'),'utf8'),JSON.stringify(history)+'\n');
  assert.deepEqual(plain(await answers.get('source')).referenceCounts,{sessions:1,history:1,total:2});
  assert.equal(plain(await answers.get('source')).redirectedFrom,'source');
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE-/);
  const before=await readFile(join(root,'answers.json'),'utf8');
  await assert.rejects(new AnswerMergeService(repository).merge('winner','source',2n,1n),/canonical active/);
  assert.equal(await readFile(join(root,'answers.json'),'utf8'),before);
 }finally{await fixture.cleanup();}
});
test('cleanup approval is explicit, revision-bound, and available through HTTP and Python-free CLI', {timeout:60000}, async()=>{
 const fixture=await nativeFixture();try {
  for(const transport of ['http','cli']) {
   const {root,repository,answers}=await setup(fixture,transport);
   const pending=plain(await answers.observe(fromJSON({question:'Work authorization country?',state:'missing'})));
   const preview=plain(await answers.cleanupPreview());const proposal=preview.proposals.find(p=>p.duplicateKey===pending.key);assert.ok(proposal);
   const {winnerKey,duplicateKey,winnerRevision,duplicateRevision}=proposal;
   const approval={previewToken:preview.previewToken,winnerKey,duplicateKey,winnerRevision,duplicateRevision};
   const jobs=new JobsService(repository),body=JSON.stringify({approval,ownerConfirmed:true});
   const denied=await jobsHttp(jobs,repository,'POST','/api/answers/cleanup-approve',JSON.stringify({approval,ownerConfirmed:false}));assert.equal(denied.status,400);
   if(transport==='http') { const result=await jobsHttp(jobs,repository,'POST','/api/answers/cleanup-approve',body);assert.equal(result.status,200,result.body);assert.equal(JSON.parse(result.body).approved,true); }
   else {const result=spawnSync(process.execPath,['runtime/cli/native-jobs.js','--root',root,'--native-lock',fixture.receipt.artifact,'answer-cleanup-approve','--owner-confirmed','--input','-'],{input:JSON.stringify(approval),encoding:'utf8',env:{PATH:''}});assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).approved,true);}
   const replay=await jobsHttp(jobs,repository,'POST','/api/answers/cleanup-approve',body);assert.equal(replay.status,409);assert.equal(JSON.parse(replay.body).error.code,'stale_conflict');
  }
 }finally{await fixture.cleanup();}
});
test('failed journal preparation leaves files untouched and corrupt sessions block all writes', {timeout:60000}, async()=>{
 const fixture=await nativeFixture();try {
  const {root,provider}=await setup(fixture,'failure');
  const before=await readFile(join(root,'answers.json'),'utf8');
  const repository=new NativeJobsRepository(root,provider,async(path,document,options)=>{if(basename(path)==='coordinator-journal.json')throw Error('injected journal failure');return atomicWritePointJson(path,document,options);});
  await assert.rejects(new AnswerMergeService(repository).merge('winner','source',1n,1n),/injected/);
  assert.equal(await readFile(join(root,'answers.json'),'utf8'),before);
  assert.equal(JSON.parse(await readFile(join(root,'coordinator-journal.json'),'utf8')).operation,null);
  await writeFile(join(root,'applications.jsonl'),'\ufeff\n');
  await assert.rejects(new AnswersService(repository).query());
  assert.equal(await readFile(join(root,'answers.json'),'utf8'),before);
  await writeFile(join(root,'applications.jsonl'),'\u0085\n');
  assert.equal(plain(await new AnswersService(repository).query()).items.length,2);
  await writeFile(join(root,'sessions/job.json'),JSON.stringify({...session,answerKeys:[7]}));
  await assert.rejects(new AnswersService(repository).query(),/answerKeys/);
  assert.equal(await readFile(join(root,'answers.json'),'utf8'),before);
 }finally{await fixture.cleanup();}
});
