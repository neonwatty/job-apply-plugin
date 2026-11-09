import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReadinessPacket } from '../apps/companion/readiness-packet.mjs';

function observed() {
  return {attemptRevision:46,platformFamily:'greenhouse',observationRevision:1,complete:true,
    inventories:[
      {controls:[{id:'contact.email',role:'textbox',required:true},{id:'resume.file',role:'file',required:true}]},
      {controls:[{id:'contact.email',role:'textbox',required:true},{id:'consent.demographic',role:'checkbox',required:true}]},
    ],verifiedStates:[{id:'contact.email',state:'complete'},{id:'resume.file',state:'accepted'},
      {id:'consent.demographic',state:'complete'}],adapterState:'accessible',uploadCapability:'available',
    validationErrorControlIds:[],finalControlState:'available'};
}

test('value-free captures retain an upload that disappears after acceptance', () => {
  const packet = buildReadinessPacket(observed());
  assert.equal(packet.readiness.status,'ready');
  assert.deepEqual(packet.readinessInput.observedForm.controls.map(item=>item.id),
    ['consent.demographic','contact.email','resume.file']);
  assert.equal(packet.readiness.requiredControlCount,3);
  assert.equal(packet.readinessInput.observation.controls.find(item=>item.controlId==='resume.file').state,'accepted');
  assert.doesNotMatch(JSON.stringify(packet),/PRIVATE|filename|https?:\/\//i);
});

test('unanswered optional fields are reported without blocking review', () => {
  const form = observed();
  form.inventories[1].controls.push({id:'social.x',role:'textbox',required:false},
    {id:'resume.autofill',role:'file',required:false});
  const packet = buildReadinessPacket(form);
  assert.equal(packet.readiness.status,'ready');
  assert.deepEqual(packet.readiness.optionalUnansweredControlIds,['social.x']);
  form.verifiedStates.push({id:'social.x',state:'complete'});
  assert.deepEqual(buildReadinessPacket(form).readiness.optionalUnansweredControlIds,[]);
});

test('missing and failed controls cannot produce ready evidence', () => {
  const missing = observed();
  missing.verifiedStates.pop();
  assert.equal(buildReadinessPacket(missing).readiness.status,'blocked');
  const failed = observed();
  failed.verifiedStates.find(item=>item.id==='resume.file').state='rejected';
  assert.equal(buildReadinessPacket(failed).readiness.status,'blocked');
  const submitted = observed();
  submitted.finalControlState='activated';
  assert.equal(buildReadinessPacket(submitted).readiness.status,'blocked');
});

test('browser inventory conflicts and private values fail closed', () => {
  const conflict = observed();
  conflict.inventories[1].controls[0].required=false;
  assert.throws(()=>buildReadinessPacket(conflict),/invalid value-free/);
  const privateValue = observed();
  privateValue.inventories[0].controls[0].value='PRIVATE-EMAIL';
  assert.throws(()=>buildReadinessPacket(privateValue),/invalid value-free/);
  const directory = mkdtempSync(join(tmpdir(),'readiness-packet-'));
  try {
    const path=join(directory,'input.json');
    writeFileSync(path,JSON.stringify(privateValue),{mode:0o600});
    const run=spawnSync(process.execPath,['apps/companion/readiness-packet.mjs','--input',path],{encoding:'utf8'});
    assert.equal(run.status,2);
    assert.doesNotMatch(run.stdout+run.stderr,/PRIVATE-EMAIL/);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});
