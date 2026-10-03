import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildClaimSession, validateClaimHandoff } from '../runtime/contracts/workspace/claim-session.js';
import { makeLiveFormManifest, makeLiveReadinessObservation } from '../runtime/contracts/workspace/claim-session-readiness.js';
import { canonicalJson } from '../runtime/contracts/workspace/canonical-json.js';
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
function livePacket(platformFamily='greenhouse') {
  const controls = [
    {id:'authorization.sponsorship',role:'combobox',required:true},
    {id:'contact.email',role:'textbox',required:true},
    {id:'contact.first_name',role:'textbox',required:true},
    {id:'contact.last_name',role:'textbox',required:true},
    {id:'demographic.consent',role:'checkbox',required:true},
    {id:'demographic.gender',role:'combobox',required:true},
    {id:'demographic.race',role:'combobox',required:true},
    {id:'demographic.veteran',role:'combobox',required:true},
    {id:'location.state',role:'combobox',required:true},
    {id:'profile.website',role:'textbox',required:false},
    {id:'resume.file',role:'file',required:true},
    {id:'work_authorization',role:'combobox',required:true},
  ];
  const observationRevision=7;
  const requiredControlIds=controls.filter(control=>control.required).map(control=>control.id);
  const fingerprint=createHash('sha256').update(canonicalJson(fromJSON({platformFamily,controls}))).digest('hex');
  const observedForm={schemaVersion:1,platformFamily,observationRevision,complete:true,controls};
  return {attemptRevision:3,evidenceKind:'agent_attested_current_attempt',observedForm,expectedObservationRevision:observationRevision,
    formManifest:{schemaVersion:1,platformFamily,observationRevision,requiredControlIds,controlSetFingerprint:`sha256:${fingerprint}`,complete:true},
    observation:{schemaVersion:1,platformFamily,observationRevision,adapterState:'accessible',uploadCapability:'available',
      controls:controls.filter(control=>control.required).map(control=>({controlId:control.id,
        kind:{textbox:'text',combobox:'selection',checkbox:'toggle',file:'upload'}[control.role],
        state:control.role==='file'?'accepted':'complete',observationRevision})),
      validationErrorControlIds:[],finalControlState:'available'}};
}
test('live-form builders serialize observed custom controls without applicant values',()=>{
  const packet=livePacket();
  assert.deepEqual(plain(makeLiveFormManifest(fromJSON(packet.observedForm),fromJSON(7),fromJSON('greenhouse'))),packet.formManifest);
  const states=Object.fromEntries(packet.observation.controls.map(control=>[control.controlId,control.state]));
  const observed=makeLiveReadinessObservation(fromJSON(packet.observedForm),states,fromJSON(7),{
    adapterState:'accessible',uploadCapability:'available',validationErrorControlIds:[],finalControlState:'available'});
  assert.deepEqual(plain(observed),packet.observation);
  assert.doesNotMatch(JSON.stringify(plain(observed)),/PRIVATE|https:|filename|filepath/i);
});
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
test('Needs Attention keeps a closed field checklist without applicant values',()=>{
  const item=base();
  item.incoming={status:'active',pendingFields:[],blockers:[{type:'browser_handoff',code:'unsupported-control'}],
    handoffChecklist:['resume_upload','passport_country','country_of_residence','age_over_18']};
  item.target='needs_info';
  const result=native(item);
  assert.deepEqual(result.session?.handoffChecklist,item.incoming.handoffChecklist);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|https:|filename|filepath/iu);
  item.incoming.handoffChecklist=['required_question','required_question'];
  assert.deepEqual(native(item).session?.handoffChecklist,item.incoming.handoffChecklist);
  for (const checklist of [Array(33).fill('required_question'),['PRIVATE_RESUME'],[{code:'resume_upload',value:'PRIVATE'}]]) {
    item.incoming.handoffChecklist=checklist;
    assert.match(native(item).error,/handoff checklist/iu);
  }
  item.incoming={status:'review',readinessInput:readyPacket(),handoffChecklist:['resume_upload']};
  item.target='awaiting_review';
  assert.match(native(item).error,/awaiting_review requires complete/iu);
});
test('display-style ATS names accept the same platform and reject a different one',()=>{
  const item=base();
  item.context.ats='Ashby';
  item.incoming={status:'review',readinessInput:livePacket('ashby')};
  item.target='awaiting_review';
  assert.equal(native(item).session?.readiness.status,'ready');
  item.context.ats='Greenhouse';
  assert.match(native(item).error,/readiness evidence is invalid/);
  item.incoming.readinessInput=readyPacket();
  assert.equal(native(item).session?.readiness.status,'ready');
});
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
  readiness('display-style ATS',item=>item.context.ats='Greenhouse');
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
  function live(name, change=()=>{}) { add(`live ${name}`,item=>{
    item.incoming={status:'review',readinessInput:livePacket()};item.target='awaiting_review';change(item,item.incoming.readinessInput);
  }); }
  live('custom greenhouse form reaches review');
  live('display-style Ashby ATS',item=>{
    item.context.ats='Ashby';
    item.incoming.readinessInput=livePacket('ashby');
  });
  live('spaced LinkedIn ATS',item=>{
    item.context.ats='LinkedIn Easy Apply';
    item.incoming.readinessInput=livePacket('linkedin-easy-apply');
  });
  for (const platform of ['ashby','lever','linkedin-easy-apply','rippling','workday']) live(`${platform} custom form`,(item)=>{
    item.context.ats=platform;
    item.incoming.readinessInput=livePacket(platform);
  });
  live('one required control missing',(item,packet)=>packet.observation.controls=packet.observation.controls.filter(control=>control.controlId!=='location.state'));
  live('optional control may lack state',(item,packet)=>assert.ok(!packet.observation.controls.some(control=>control.controlId==='profile.website')));
  live('extra required control is enforced',(item,packet)=>{
    packet.observedForm.controls.splice(10,0,{id:'question.extra',role:'textbox',required:true});
    packet.formManifest.requiredControlIds.splice(9,0,'question.extra');
    packet.formManifest.controlSetFingerprint=`sha256:${createHash('sha256').update(canonicalJson(fromJSON({platformFamily:'greenhouse',controls:packet.observedForm.controls}))).digest('hex')}`;
  });
  live('manifest omission',(item,packet)=>packet.formManifest.requiredControlIds.pop());
  live('inventory incomplete',(item,packet)=>packet.observedForm.complete=false);
  live('inventory unsorted',(item,packet)=>packet.observedForm.controls.reverse());
  live('inventory duplicate',(item,packet)=>packet.observedForm.controls.splice(1,0,clone(packet.observedForm.controls[0])));
  live('inventory value rejected',(item,packet)=>packet.observedForm.controls[0].value='PRIVATE');
  live('replay rejected',(item,packet)=>packet.evidenceKind='repository_replay');
  live('wrong ATS',item=>item.context.ats='lever');
  live('stale inventory',(item,packet)=>packet.observedForm.observationRevision=6);
  live('upload rejected',(item,packet)=>packet.observation.controls.find(control=>control.kind==='upload').state='rejected');
  live('validation error',(item,packet)=>packet.observation.validationErrorControlIds=['profile.website']);
  live('final action activated',(item,packet)=>packet.observation.finalControlState='activated');
  live('fixture and inventory mixed',(item,packet)=>packet.fixture=clone(fixture));
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
