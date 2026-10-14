import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReadinessPacket} from '../apps/companion/readiness-packet.mjs';

const field = () => ({source:'readback',observation:'masked',freshness:'current',
  attemptScope:'same',formScope:'same',controlScope:'same',repairCount:0});
function input() {
  const scope = {jobId:'job-synthetic',attemptRevision:4,resumeId:'resume-synthetic',
    resumeRevision:2,contentRevision:'content-synthetic',formInstanceId:'form-synthetic'};
  return {attemptRevision:4,platformFamily:'greenhouse',observationRevision:2,complete:true,
    inventories:[{controls:[{id:'contact.email',role:'textbox',required:true},
      {id:'resume.file',role:'file',required:true}]}],
    verifiedStates:[{id:'contact.email',state:'complete'},{id:'resume.file',state:'accepted'}],
    adapterState:'accessible',uploadCapability:'external-runtime-unavailable',
    validationErrorControlIds:[],finalControlState:'available',
    fieldVerifications:[{id:'contact.email',evidence:field()}],
    manualAttachment:{scope:{...scope},currentScope:{...scope},uploadOutcome:'chooser_unavailable',
      guardPassed:true,pausedObservationRevision:1,observation:{revision:2,state:'accepted'},
      ownerConfirmation:{scope:{...scope},confirmed:true}}};
}

test('manual acceptance cannot override masked or stale ordinary fields', () => {
  const value = input();
  assert.equal(buildReadinessPacket(value).readiness.status,'blocked');
  value.fieldVerifications[0].evidence = {...field(),source:'visual',observation:'match'};
  assert.equal(buildReadinessPacket(value).readiness.status,'ready');
  for (const [key,rejected] of [['freshness','stale'],['attemptScope','different'],
    ['formScope','unknown'],['controlScope','different']]) {
    const changed = structuredClone(value);
    changed.fieldVerifications[0].evidence[key] = rejected;
    const packet = buildReadinessPacket(changed);
    assert.equal(packet.readiness.status,'blocked');
    assert.equal(packet.readinessInput.observation.controls.find(c=>c.controlId==='contact.email').state,'unresolved');
  }
  value.manualAttachment.ownerConfirmation = null;
  assert.equal(buildReadinessPacket(value).readiness.status,'blocked');
  value.manualAttachment.ownerConfirmation = input().manualAttachment.ownerConfirmation;
  value.finalControlState = 'activated';
  assert.equal(buildReadinessPacket(value).readiness.status,'blocked');
});

test('verification entries reject ambiguity, file controls and private payloads', () => {
  for (const change of [v=>v.fieldVerifications=null,
    v=>v.fieldVerifications.push(v.fieldVerifications[0]),
    v=>v.fieldVerifications[0].id='resume.file',
    v=>v.fieldVerifications[0].id='missing.field',
    v=>v.fieldVerifications[0].evidence.value='PRIVATE',
    v=>v.fieldVerifications[0].value='PRIVATE']) {
    const value=input(); change(value);
    assert.throws(()=>buildReadinessPacket(value),error=>!error.message.includes('PRIVATE'));
  }
});

test('derived packet carries only resulting control states and legacy inputs remain valid', () => {
  const value=input();
  const packet=buildReadinessPacket(value);
  assert.doesNotMatch(JSON.stringify(packet),/fieldVerifications|repairCount|ownerConfirmation|form-synthetic/);
  delete value.fieldVerifications;
  assert.equal(buildReadinessPacket(value).readiness.status,'ready');
});
