import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildClaimSession, validateClaimHandoff } from '../runtime/contracts/workspace/claim-session.js';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';

const plain = value => JSON.parse(serialize(value));
const fixture = JSON.parse(readFileSync(new URL('../qa/fixtures/greenhouse-form-readiness-v1/fixture.json',import.meta.url),'utf8'));
const clone = value => structuredClone(value);
function readyPacket() {
  const controls = fixture.steps.flatMap(step => step.controls);
  const requiredControlIds = controls.filter(control => control.required).map(control => control.id).sort();
  const platformFamily = fixture.platformFamily;
  const fingerprint = createHash('sha256').update(JSON.stringify({platformFamily,requiredControlIds})).digest('hex');
  const kinds = {textbox:'text',combobox:'selection',radiogroup:'selection',checkbox:'toggle',file:'upload'};
  return {attemptRevision:3,evidenceKind:'agent_attested_current_attempt',fixture:clone(fixture),expectedObservationRevision:7,
    formManifest:{schemaVersion:1,platformFamily,observationRevision:7,requiredControlIds,controlSetFingerprint:`sha256:${fingerprint}`,complete:true},
    observation:{schemaVersion:1,platformFamily,observationRevision:7,adapterState:'accessible',uploadCapability:'available',
      controls:controls.map(control => ({controlId:control.id,kind:kinds[control.role],state:control.role === 'file' ? 'accepted':'complete',observationRevision:7})),
      validationErrorControlIds:[],finalControlState:'available'}};
}
function base() {
  return {incoming:{status:'active',company:'EPHEMERAL_COMPANY',role:'EPHEMERAL_ROLE',url:'https://private.invalid',
    pendingFields:[{question:' Preferred  CITY? ',state:'missing',answerKey:'answer',scope:{ats:'greenhouse'},matchConfidence:'high',matchReasonCodes:['fabricated']}],answerKeys:['answer']},
    context:{now:'2026-09-10T10:00:00Z',attemptRevision:3,ats:'greenhouse',existing:null,
      answers:{schemaVersion:1,metadata:{},redirects:{},answers:{answer:{key:'answer',question:'Preferred city?',state:'confirmed',value:'PRIVATE_ANSWER',revision:4,scope:{ats:'greenhouse'}}}}}};
}
function native(item) {
  const incoming = fromJSON(item.incoming), context = {...item.context,attemptRevision:fromJSON(item.context.attemptRevision),ats:fromJSON(item.context.ats),
    answers:fromJSON(item.context.answers),existing:item.context.existing === null ? null:fromJSON(item.context.existing)};
  const before = [incoming,context.answers,context.existing].map(serialize);
  try {
    const session = buildClaimSession('job',incoming,context);
    if ('target' in item) validateClaimHandoff(session,incoming,item.target,context.attemptRevision);
    return {session:plain(session)};
  } catch (error) { return {error:error.message}; }
  finally { assert.deepEqual([incoming,context.answers,context.existing].map(serialize),before,'inputs must be unchanged'); }
}
function normalize(result, item) {
  const references = new Map();
  const existing = new Set((item.context.existing?.pendingFields ?? []).map(field => field.reference));
  for (const field of result.session?.pendingFields ?? []) {
    assert.match(field.reference,/^pending_[a-f0-9]{32}$/);
    if (!existing.has(field.reference)) references.set(field.reference,`new-reference-${references.size}`);
  }
  return JSON.parse(JSON.stringify(result,(_key,value) => references.get(value) ?? value));
}
function oracle(items) {
  const run = spawnSync('python3',['tools/contracts/claim-sessions/reference.py'],{input:JSON.stringify(items),encoding:'utf8',timeout:30000});
  assert.equal(run.status,0,run.stderr);
  return JSON.parse(run.stdout);
}

test('claim sessions preserve Python privacy, reference identity, approvals and readiness contracts', () => {
  const cases = [];
  function add(name, change = () => {}) { const item=base(); change(item); cases.push({name,item}); }
  add('ephemeral metadata stripped, semantic claims recomputed');
  add('unbound question',item => delete item.incoming.pendingFields[0].answerKey);
  add('question missing',item => delete item.incoming.pendingFields[0].question);
  add('question whitespace',item => item.incoming.pendingFields[0].question='\u001c \u0085');
  add('question casefold',item => item.incoming.pendingFields[0].question='Straße\u001fCITY');
  add('sensitive field',item => item.incoming.pendingFields[0].sensitive=true);
  add('sensitive answer',item => item.context.answers.answers.answer.sensitivity='personal');
  add('unknown answer',item => item.incoming.pendingFields[0].answerKey='unknown');
  add('redirect answer',item => {item.incoming.pendingFields[0].answerKey='old';item.context.answers.redirects.old={targetKey:'answer',mergedAt:'old'};});
  add('empty scope',item => item.incoming.pendingFields[0].scope={});
  add('scope from ATS',item => delete item.incoming.pendingFields[0].scope);
  add('missing ATS',item => {item.context.ats=null;delete item.incoming.pendingFields[0].scope;});
  for (const [key,value] of [['applicationId','other'],['attemptRevision',2],['status','bad'],['answerKeys',null],['pendingFields',null],['blockers',null],['approvals',[]]]) add(`invalid ${key}`,item => item.incoming[key]=value);
  for (const [key,value] of [['reference','forged'],['scope',5],['state','bad'],['fieldClass','BAD'],['sensitive',1]]) add(`invalid field ${key}`,item => item.incoming.pendingFields[0][key]=value);
  for (const code of ['login-required','consent-required','owner-input-required']) add(`agent blocker ${code}`,item => {
    item.incoming.pendingFields=[];item.incoming.blockers=[{type:code==='consent-required'?'owner_review':code==='owner-input-required'?'information':'browser_handoff',code}];
  });
  add('contradictory handoff',item => {item.incoming.blockers=[{type:'browser_handoff',code:'login-required'}];item.incoming.browserHandoff={state:'not_required',reasonCode:'none',revision:1};});
  add('nonobject pending field',item => item.incoming.pendingFields=[null]);
  add('nonobject blocker',item => item.incoming.blockers=[null]);
  add('nonobject handoff',item => item.incoming.browserHandoff=4);
  add('created timestamp retained',item => item.incoming.createdAt='old');
  const existing = native(base()).session;
  const approval = {reference:existing.pendingFields[0].reference,answerKey:'answer',currentUse:true,remember:false,policyMode:'strict',useAuthority:'per_use',eligible:true,confidenceBand:'exact',reasonCodes:['match_exact_question'],answerRevision:4};
  existing.approvals=[approval];
  for (const mode of ['same','new-attempt','changed-answer','changed-question','duplicate-fields','changed-match','deleted-answer']) add(`carry ${mode}`,item => {
    item.context.existing=clone(existing);
    if(mode==='new-attempt') item.context.attemptRevision=5;
    if(mode==='changed-answer') item.context.answers.answers.answer.revision++;
    if(mode==='deleted-answer') item.context.answers.answers.answer.deletedAt='old';
    if(mode==='changed-question') item.incoming.pendingFields[0].question='New question';
    if(mode==='changed-match') item.context.answers.answers.answer.question='New match wording';
    if(mode==='duplicate-fields') item.incoming.pendingFields.push(clone(item.incoming.pendingFields[0]));
  });
  function readiness(name, change=()=>{}) { add(`readiness ${name}`,item => {
    item.incoming={status:'review',readinessInput:readyPacket()};item.target='awaiting_review';change(item,item.incoming.readinessInput);
  }); }
  readiness('live ready');
  readiness('nonobject packet',item=>item.incoming.readinessInput=null);
  readiness('boolean observation revision',(item,packet)=>packet.observation.observationRevision=true);
  readiness('duplicate validation IDs',(item,packet)=>packet.observation.validationErrorControlIds=[packet.observation.controls[0].controlId,packet.observation.controls[0].controlId]);
  readiness('manifest omitted control',(item,packet)=>packet.formManifest.requiredControlIds.pop());
  readiness('repository replay',(item,packet)=>packet.evidenceKind='repository_replay');
  readiness('attempt mismatch',(item,packet)=>packet.attemptRevision=2);
  readiness('missing attempt',item=>{item.context.attemptRevision=null;delete item.incoming.readinessInput.attemptRevision;});
  readiness('tampered fixture',(item,packet)=>packet.fixture.description='tampered');
  readiness('wrong ATS',item=>item.context.ats='lever');
  readiness('manifest incomplete',(item,packet)=>packet.formManifest.complete=false);
  readiness('manifest fingerprint',(item,packet)=>packet.formManifest.controlSetFingerprint='sha256:'+'0'.repeat(64));
  readiness('old observation',(item,packet)=>packet.observation.observationRevision=6);
  readiness('old control',(item,packet)=>packet.observation.controls[0].observationRevision=6);
  readiness('duplicate control',(item,packet)=>packet.observation.controls.push(clone(packet.observation.controls[0])));
  readiness('unknown control',(item,packet)=>packet.observation.controls[0].controlId='unknown');
  readiness('wrong kind',(item,packet)=>packet.observation.controls[0].kind='upload');
  readiness('private control value',(item,packet)=>packet.observation.controls[0].value='PRIVATE');
  for(const state of ['missing','rejected','unresolved','inaccessible']) readiness(`upload ${state}`,(item,packet)=>packet.observation.controls.find(control=>control.kind==='upload').state=state);
  for(const state of ['activated','unavailable','inaccessible']) readiness(`final ${state}`,(item,packet)=>packet.observation.finalControlState=state);
  readiness('adapter inaccessible',(item,packet)=>packet.observation.adapterState='inaccessible');
  readiness('validation error',(item,packet)=>packet.observation.validationErrorControlIds=[packet.observation.controls[0].controlId]);
  readiness('owner upload fallback',(item,packet)=>{packet.observation.controls.find(control=>control.kind==='upload').state='missing';packet.observation.uploadCapability='external-runtime-unavailable';item.target='needs_info';item.incoming.status='active';});
  readiness('missing evidence controls',(item,packet)=>packet.observation.controls=[]);
  readiness('pending information',(item)=>item.incoming.pendingFields=base().incoming.pendingFields);
  readiness('status mismatch',item=>item.incoming.status='active');
  const readyExisting=native({...base(),incoming:{status:'review',readinessInput:readyPacket()}}).session;
  add('retained readiness does not authorize handoff',item=>{item.context.existing=readyExisting;item.incoming={status:'review'};item.target='awaiting_review';});
  add('new attempt drops readiness',item=>{item.context.existing=readyExisting;item.context.attemptRevision=5;item.incoming={status:'active'};});
  add('same attempt retains readiness',item=>{item.context.existing=readyExisting;item.incoming={status:'active'};});
  const expected=oracle(cases.map(({item})=>item));
  const failures=[];
  for(const [index,{name,item}] of cases.entries()) {
    const actual=native(item);
    try { assert.deepEqual(normalize(actual,item),normalize(expected[index],item),name); }
    catch (error) { failures.push(error.message); }
    if(actual.session) {
      const encoded=JSON.stringify(actual.session);
      for(const secret of ['EPHEMERAL_COMPANY','EPHEMERAL_ROLE','https://private.invalid','PRIVATE_ANSWER','Preferred  CITY']) assert.ok(!encoded.includes(secret),`${name}: private input persisted`);
    }
  }
  assert.deepEqual(failures,[]);
  console.log(`Validated ${cases.length} Python differential claim-session cases`);
});
