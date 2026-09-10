import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../apps/companion/components/projection-model.ts', import.meta.url), 'utf8');
const emitted = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
  .replaceAll('../../../src/contracts/workspace/values', new URL('../runtime/contracts/workspace/values.js', import.meta.url).href);
const model = await import(`data:text/javascript;base64,${Buffer.from(emitted).toString('base64')}`);
const row = {jobId:'job/a',status:'needs_info',revision:1,priority:0,reasonCode:'needs_information',attentionAt:'2026-09-01T00:00:00Z',missingInformationCount:2,sessionRevision:null,session:null};
test('attention preserves canonical server order and lossless revisions', () => {
 const parsed=model.attentionProjection(JSON.stringify({items:[row,{...row,jobId:'b'}],snapshotSignature:'x'}).replace('"revision":1','"revision":9007199254740993'));
 assert.deepEqual(parsed.items.map(r=>r.jobId), ['job/a','b']);
 assert.equal(parsed.items[0].revision,9007199254740993n);
 assert.equal(model.filterAttention(parsed.items,'browser_action_required').length,0);
});
test('malformed attention fails without silently producing an empty queue',()=>{
 for(const items of [null,[{...row,revision:0}],[{...row,missingInformationCount:-1}],[{...row,reasonCode:'secret'}],[row,row]]) assert.throws(()=>model.attentionProjection(JSON.stringify({items,snapshotSignature:'x'})));
});
test('activity strips arbitrary values, tokens, answer identities and approval contents',()=>{
 const activity=model.activityProjection(JSON.stringify({job:{status:'needs_info',revision:1},session:{revision:2,step:'Review',pendingInformation:[{reference:'private-ref',answerKey:'private-key',resolutionEligible:false,sensitive:true,value:'private-value'}],approvals:[{reference:'private-ref',token:'private-token'}]},claim:{state:'expired',token:'private-token'},history:[{event:'opened',status:'saved',at:'2026-09-01'}],value:'private-value'}));
 assert.doesNotMatch(JSON.stringify(activity,(_,v)=>typeof v==='bigint'?String(v):v),/private-/);
 assert.equal(activity.session.pending[0].sensitive,true);
 assert.equal(activity.session.approvalCount,1);
 assert.equal(activity.session.pending[0].approved,true);
});
test('activity rejects malformed revision and eligibility',()=>{
 for(const revision of [0,true,1.5]) assert.throws(()=>model.activityProjection(JSON.stringify({job:{status:'saved',revision},session:null,claim:{state:'none'},history:[]})));
 assert.throws(()=>model.activityProjection(JSON.stringify({job:{status:'saved',revision:1},session:{revision:1,pendingInformation:[{resolutionEligible:'yes'}]},claim:{state:'none'},history:[]})));
});

test('native recovery and review guidance describes only supported authority',()=>{
 assert.match(model.recoveryGuidance.interrupted, /change this interrupted attempt to Needs information/);
 assert.equal(model.attentionGuidance.claimless_interrupted_attempt, model.recoveryGuidance.interrupted);
 assert.doesNotMatch(model.attentionGuidance.claimless_interrupted_attempt, /job-transition/);
 assert.match(model.recoveryGuidance.expired, /claim-recover/);
 assert.match(model.attentionGuidance.awaiting_human_review, /Personally review and submit on the third-party site/);
 assert.match(model.attentionGuidance.awaiting_human_review, /confirm Applied in Job details/);
});

test('attention and activity allow a null unbound attempt revision but reject malformed bindings',()=>{
 const attention = attemptRevision => model.attentionProjection(JSON.stringify({items:[{...row,session:{attemptRevision}}],snapshotSignature:'x'})).items[0].session;
 const activity = attemptRevision => model.activityProjection(JSON.stringify({job:{status:'needs_info',revision:1},session:{revision:2,attemptRevision},claim:{state:'none'},history:[]})).session;
 for (const project of [attention,activity]) {
   assert.equal(Object.hasOwn(project(null),'attemptRevision'),false);
   assert.equal(Object.hasOwn(project(undefined),'attemptRevision'),false);
   assert.equal(project(3).attemptRevision,3n);
   for (const invalid of [0,-1,true,1.5,'3',{},[]]) assert.throws(()=>project(invalid));
 }
});
