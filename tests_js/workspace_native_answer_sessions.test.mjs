import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fromJSON,parse,serialize} from '../runtime/contracts/workspace/values.js';
import {validateAnswerSession,validateAnswerHistory} from '../runtime/contracts/workspace/answer-session-validation.js';
import {rewriteSessionAnswerKey,answerReferenceCounts} from '../runtime/contracts/workspace/answer-sessions.js';
const plain=value=>JSON.parse(serialize(value));
const reference='pending_'+'a'.repeat(32);
const approval=key=>({reference,answerKey:key,currentUse:true,remember:false,eligible:true,policyMode:'strict',useAuthority:'per_use',confidenceBand:'exact',reasonCodes:['reuse_eligible'],answerRevision:3});
const pending=key=>({reference,answerKey:key,state:'confirmed',question:'Private question',sensitive:false,fieldClass:'general',scopeFingerprint:'a'.repeat(64),questionFingerprint:'b'.repeat(64),matchConfidence:'exact',matchReasonCodes:['match_exact_question'],matchAnswerRevision:3});
const base=()=>({schemaVersion:1,applicationId:'fixture-1',status:'review',answerKeys:['source','winner','source'],pendingFields:[pending('source')],approvals:[approval('source'),approval('winner')],attemptRevision:2,createdAt:'old',updatedAt:'old'});
const capture=callback=>{try{return {value:callback()};}catch(error){return {error:error.message};}};
function oracle(operation,items) {
 const run=spawnSync('python3',['-c',String.raw`
import json,sys
sys.path.insert(0,'scripts')
from job_apply_store.sessions_runtime import _validate_session_document
from job_apply_store.validation.sessions import _validate_history_event_record
from job_apply_store.io import validate_version
from job_apply_store.domains.answers.merge import AnswerMergeMixin
result=[]
for item in json.load(sys.stdin):
 try:
  if sys.argv[1]=='session': validate_version(item,'session'); _validate_session_document(item); value=item
  elif sys.argv[1]=='history': validate_version(item,'history'); _validate_history_event_record(item); value=item
  else: value=AnswerMergeMixin._rewrite_session_answer_key(item,'source','winner','new')
  result.append({'value':value})
 except Exception as error: result.append({'error':str(error)})
print(json.dumps(result))
`,operation],{cwd:new URL('..',import.meta.url),encoding:'utf8',input:JSON.stringify(items)});
 assert.equal(run.status,0,run.stderr);
 return JSON.parse(run.stdout);
}

test('session validation preserves Python legacy fields and rejects invalid evidence',()=>{
 const fixtures=[base(),{schemaVersion:1,applicationId:'legacy',status:'active'}, {...base(),schemaVersion:99}];
 for(const [key,value] of Object.entries({applicationId:'../bad',status:'ready',answerKeys:[4],pendingFields:null,attemptRevision:true,blockers:null,approvals:null,company:3,unexpected:true})) fixtures.push({...base(),[key]:value});
 for(const [key,value] of Object.entries({state:null,sensitive:1,reference:reference+'\n',fieldClass:'x\n',scopeFingerprint:'a'.repeat(64)+'\n',questionFingerprint:'no',matchConfidence:'medium',matchAnswerRevision:true,matchReasonCodes:['unknown'],unexpected:true})) fixtures.push({...base(),pendingFields:[{...pending('source'),[key]:value}]});
 fixtures.push({...base(),pendingFields:[pending('source'),pending('winner')]});
 const blocker={type:'information',code:'answer-required',reference,sensitivity:'none',fieldClass:42};
 fixtures.push({...base(),blockers:[blocker]});
 for(const [key,value] of Object.entries({type:'invalid',code:'invalid',reference:'bad',sensitivity:'invalid',extra:true})) fixtures.push({...base(),blockers:[{...blocker,[key]:value}]});
 for(const [key,value] of Object.entries({answerKey:'',currentUse:1,remember:null,eligible:1,policyMode:'loose',useAuthority:'user',confidenceBand:'medium',reasonCodes:['bad'],answerRevision:0,extra:true})) fixtures.push({...base(),approvals:[{...approval('source'),[key]:value}]});
 for(const browserHandoff of [{state:'required',reasonCode:'login-required',revision:1},{state:'complete',reasonCode:'none',revision:1},{state:'required',reasonCode:'none',revision:1},{state:'ready_for_owner',reasonCode:'final-review-required',revision:true}]) fixtures.push({...base(),browserHandoff});
 const assertions=Object.fromEntries(['observation-current','adapter-accessible','required-controls-complete','required-uploads-accepted','validation-clear','final-control-available','final-action-untouched'].map(key=>[key,'passed']));
 const readiness={status:'ready',evidenceKind:'repository_replay',attemptRevision:2,observationRevision:1,controlSetFingerprint:'sha256:'+'a'.repeat(64),requiredControlCount:1,assertions,blockerCodes:[],fallbackCode:null};
 fixtures.push({...base(),readiness});
 const blocked={...readiness,status:'blocked',assertions:{...assertions,'required-uploads-accepted':'failed'},blockerCodes:['required-upload-missing','external-upload-capability-unavailable'],fallbackCode:'owner-upload-required'};
 fixtures.push({...base(),readiness:blocked});
 fixtures.push({...base(),readiness:{...blocked,blockerCodes:['required-upload-missing','required-upload-missing']}});
 fixtures.push({...base(),readiness:{...blocked,blockerCodes:['external-upload-capability-unavailable']}});
 for(const [key,value] of Object.entries({status:'blocked',evidenceKind:'none',attemptRevision:1,observationRevision:true,controlSetFingerprint:'bad',requiredControlCount:0,assertions:{},blockerCodes:['bad'],fallbackCode:'owner-upload-required',extra:true})) fixtures.push({...base(),readiness:{...readiness,[key]:value}});
 assert.deepEqual(fixtures.map(item=>capture(()=>plain(validateAnswerSession(fromJSON(item))))),oracle('session',fixtures));
});

test('session rewrite matches Python and invalidates only source-bound decisions without mutation',()=>{
 const fixtures=[base(),{schemaVersion:1,applicationId:'legacy',status:'active'},{...base(),pendingFields:[pending('winner')]}];
 const native=fixtures.map(item=>{
  const session=fromJSON(item),before=serialize(session);
  const result=rewriteSessionAnswerKey(session,'source','winner','new');
  assert.equal(serialize(session),before);
  return {value:plain(result)};
 });
 assert.deepEqual(native,oracle('rewrite',fixtures));
 assert.deepEqual(native[0].value.approvals,[approval('winner')]);
 assert.equal(native[0].value.pendingFields[0].questionFingerprint,'b'.repeat(64));
 assert.equal(native[0].value.pendingFields[0].matchAnswerRevision,undefined);
 const lossless=parse('{"applicationId":"fixture","status":"active","schemaVersion":1,"pendingFields":[],"attemptRevision":9007199254740993}');
 assert.match(serialize(rewriteSessionAnswerKey(lossless,'source','winner','new')),/9007199254740993/);
});

test('reference counts deduplicate original keys then resolve historical redirects like Python',()=>{
 const document=fromJSON({redirects:{source:{targetKey:'winner',mergedAt:'old'},older:{targetKey:'winner',mergedAt:'old'}}});
 const counts=answerReferenceCounts(document,[fromJSON(base()),fromJSON({...base(),answerKeys:['older'],pendingFields:[],approvals:[]})],[fromJSON({answerKeys:['source','source','winner']}),fromJSON({answerKeys:['other']})]);
 assert.deepEqual([...counts],[['winner',{sessions:3n,history:2n}],['other',{sessions:0n,history:1n}]]);
});

test('history validation accepts future value-free events and rejects unknown fields and bad identity',()=>{
 const event={schemaVersion:1,eventId:'fixture-event',applicationId:'fixture',event:'future-event',at:'now',answerKeys:['source']};
 const fixtures=[event];
 for(const schemaVersion of [null,0,2,true,1.5]) fixtures.push({...event,schemaVersion});
 for(const [key,value] of Object.entries({applicationId:'bad\n',event:'event\n',eventId:'',at:'',answerKeys:null,role:2,value:'private'})) fixtures.push({...event,[key]:value});
 assert.deepEqual(fixtures.map(item=>capture(()=>plain(validateAnswerHistory(fromJSON(item))))),oracle('history',fixtures));
 for(const version of [null,0,2,true,1.5]) assert.throws(()=>validateAnswerHistory(fromJSON({...event,schemaVersion:version})));
});
