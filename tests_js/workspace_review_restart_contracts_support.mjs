export const job = {id:'job-1',revision:4,status:'awaiting_review',ats:'greenhouse'};
export const reviewed = {applicationId:'job-1',event:'reviewed',status:'awaiting_review'};
export const legacy = {schemaVersion:1,applicationId:'job-1',status:'review',step:'final_review',pendingFields:[],blockers:[]};
export const modern = {...legacy, attemptRevision:3, readiness:{
  status:'ready',evidenceKind:'agent_attested_current_attempt',attemptRevision:3,
  observationRevision:1,controlSetFingerprint:`sha256:${'a'.repeat(64)}`,requiredControlCount:1,
  assertions:Object.fromEntries(['observation-current','adapter-accessible','required-controls-complete',
    'required-uploads-accepted','validation-clear','final-control-available','final-action-untouched'].map(key=>[key,'passed'])),
  blockerCodes:[],fallbackCode:null,
},browserHandoff:{state:'ready_for_owner',reasonCode:'final-review-required',revision:1}};
export function cases() {
  const rows = [];
  const add = (name, session, history=[reviewed], record=job) => rows.push({name,job:record,session,history});
  add('current review', modern);
  add('legacy review', legacy);
  add('missing file', null);
  add('legacy omitted optional lists', {schemaVersion:1,applicationId:'job-1',status:'review',step:'final_review'});
  for (const key of ['attemptRevision','readiness','browserHandoff']) {
    add(`legacy explicit null ${key}`, {...legacy,[key]:null});
    const partial = structuredClone(modern); delete partial[key]; add(`partial ${key}`,partial);
  }
  for (const [key,value] of [['status','active'],['step','fill'],['pendingFields',null],['blockers',null],
    ['schemaVersion',2],['schemaVersion',true],['unexpected',true],['applicationId','../job']]) {
    add(`legacy invalid ${key}`, {...legacy,[key]:value});
  }
  add('modern step need not be final_review', {...modern,step:'fill'});
  add('stale attempt', {...modern,attemptRevision:2,readiness:{...modern.readiness,attemptRevision:2}});
  add('future attempt', {...modern,attemptRevision:4,readiness:{...modern.readiness,attemptRevision:4}});
  add('boolean attempt', {...modern,attemptRevision:true});
  add('repository replay', {...modern,readiness:{...modern.readiness,evidenceKind:'repository_replay'}});
  add('unbound readiness', {...modern,readiness:{...modern.readiness,attemptRevision:2}});
  add('missing assertions', {...modern,readiness:{...modern.readiness,assertions:{}}});
  add('contradictory readiness', {...modern,readiness:{...modern.readiness,blockerCodes:['validation-error-present']}});
  add('failed readiness', {...modern,readiness:{...modern.readiness,status:'blocked',
    blockerCodes:['validation-error-present'],assertions:{...modern.readiness.assertions,'validation-clear':'failed'}}});
  add('changed handoff revision', {...modern,browserHandoff:{...modern.browserHandoff,revision:2}});
  add('completed handoff', {...modern,browserHandoff:{state:'complete',reasonCode:'none',revision:1}});
  add('handoff extra field', {...modern,browserHandoff:{...modern.browserHandoff,extra:1}});
  add('blocker', {...modern,blockers:[{type:'information',code:'answer-required'}]});
  add('modern pending', {...modern,pendingFields:[{reference:`pending_${'1'.repeat(32)}`} ]});
  add('legacy pending', {...legacy,pendingFields:[{question:'Name?',state:'missing'}]});
  add('legacy duplicate pending', {...legacy,pendingFields:[{question:'Name?'},{question:'Name?'}]});
  add('legacy invalid pending property', {...legacy,pendingFields:[{question:'Name?',fieldClass:'name'}]});
  add('legacy mixed pending', {...legacy,pendingFields:[{question:'Name?'},{reference:`pending_${'1'.repeat(32)}`} ]});
  add('legacy wrong pending type', {...legacy,pendingFields:[{question:'Name?'},null]});
  add('legacy job metadata invalid', {...legacy,company:4,pendingFields:[{question:'Name?'}]});
  add('legacy canonical ATS replaces old ATS', {...legacy,ats:4,pendingFields:[{}]});
  add('missing history', modern, []);
  add('other job does not supply evidence', modern, [{...reviewed,applicationId:'job-2'}]);
  add('later own event invalidates review', modern, [reviewed,{...reviewed,event:'progressed'}]);
  add('later other job does not invalidate review', modern, [reviewed,{...reviewed,applicationId:'job-2',event:'progressed'}]);
  add('last reviewed status mismatch', modern, [{...reviewed,status:'in_progress'}]);
  for (const event of ['job-restarted','legacy-review-rebuild']) {
    add(`legacy one time ${event}`, legacy, [{...reviewed,event},reviewed]);
    add(`modern may restart again ${event}`, modern, [{...reviewed,event},reviewed]);
    add(`other job previous ${event}`, legacy, [{...reviewed,applicationId:'job-2',event},reviewed]);
  }
  return rows;
}
