import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const requested=process.argv[2]==='--journey-root'?process.argv[3]:null;
if(!requested||requested!==resolve(requested))throw Error('absolute journey root required');
const root=await realpath(requested),read=name=>readFile(join(root,name),'utf8').then(JSON.parse);
const portal=await read('portal-state.json'),decisionEnvelope=await read('decision.json'),result=await read('agent-result.json');
const decision=decisionEnvelope.ok===true&&decisionEnvelope.event==='authority_evaluated'?decisionEnvelope.decision:decisionEnvelope;
const profile=await readFile(join(root,'store','profile.json'),'utf8').then(JSON.parse);
const jobs=await readFile(join(root,'store','jobs.json'),'utf8').then(JSON.parse);
const authority=await readFile(join(root,'store','application-authority.json'),'utf8').then(JSON.parse);
const events=(await readFile(join(root,'store','applications.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
assert.equal(portal.syntheticOnly,true);assert.equal(new URL(portal.destinationUrl).hostname.endsWith('.invalid'),true);
assert.equal(profile.profile.applicationPreferences.preferredAutomationMode,'campaign_to_review');
assert.equal(portal.stage,'final_review');assert.equal(portal.finalActionActivated,false);
assert.deepEqual(portal.completedOperations,portal.requiredOperations);
assert.equal(decision.authorized,true);assert.equal(decision.mode,'campaign_to_review');
assert.deepEqual(decision.operations,portal.requiredOperations);assert.doesNotMatch(JSON.stringify(decision),/claimToken|tokenHash/);
assert.equal(jobs.jobs['synthetic-agent-automation-job-v1'].status,'awaiting_review');
assert.deepEqual(events.map(event=>event.event),['job-started','reviewed']);
assert.equal(events.some(event=>/applied|submit/i.test(event.event)),false);
assert.ok(authority.activeAuthorityId);assert.equal(authority.authorities[authority.activeAuthorityId].mode,'campaign_to_review');
assert.deepEqual(result,{outcome:'passed',mode:'campaign_to_review',stoppedAt:'final_review',finalActionActivated:false,
  authorityActivations:1,authorityEvaluations:1,operationsCompleted:4});
process.stdout.write(`${JSON.stringify({ok:true,fixtureId:portal.fixtureId,stoppedAt:portal.stage,
  operationsCompleted:portal.completedOperations.length,finalActionActivated:portal.finalActionActivated})}\n`);
