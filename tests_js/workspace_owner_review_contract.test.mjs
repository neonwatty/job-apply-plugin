import test from 'node:test';
import assert from 'node:assert/strict';
import { hostBrowserReport } from '../runtime/workflows/applications/host-browser-report.js';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, host, acquire, read, write } from './workspace_durable_claims_support.mjs';
const report={operationId:'review',taskId:'task',expectedRevision:'2',jobId:'job',jobRevision:'3',
  evidenceKind:'agent_attested',outcome:'awaiting_review',session:{status:'review'}};

test('review report is a closed fresh-session handoff, never a saved checkpoint or final action',()=>{
  const parsed=hostBrowserReport(report);
  assert.equal(parsed.kind,'handoff');assert.equal(parsed.status,'awaiting_review');
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.session)),report.session);
  const {session,...withoutSession}=report;
  for(const invalid of [{...withoutSession,savedSessionFingerprint:'a'.repeat(64)},
    {...report,savedSessionFingerprint:'a'.repeat(64)},{...report,outcome:'submitted'},
    {...report,hostUserEvent:true},{...report,evidenceKind:'trusted_browser'}]) {
    assert.throws(()=>hostBrowserReport(invalid),/invalid_event/);
  }
});

test('canonical review action requires a new session and disappears after input drift or revocation',async t=>{
  const fixture=await nativeFixture();t.after(()=>fixture.cleanup());
  const state=await setup(fixture,'review-action'),owner=host(state);t.after(()=>owner.workflow.close());
  await acquire(state,owner.workflow);
  const review=()=>owner.workflow.inspect('job').then(c=>c.guidance.actions.find(a=>a.kind==='handoff'&&a.input.status==='awaiting_review'));
  const action=await review();assert.ok(action);
  assert.deepEqual(action.requiredFields,['operationId','session']);
  assert.equal(action.requiresExplicitUserEvent,false);
  assert.equal(Object.hasOwn(action.input,'session'),false);
  assert.equal(Object.hasOwn(action.input,'savedSessionFingerprint'),false);
  owner.access.authorized=[];assert.equal(await review(),undefined);
  owner.access.authorized=['application_attempt'];
  const jobs=await read(state.root,'jobs.json');
  const run=jobs.metadata.applicationRuns.runs['run-fixture'];
  run.revision++;run.queueVersions.push({...run.queueVersions.at(-1),revision:run.revision});
  await write(state.root,'jobs.json',jobs);
  assert.equal(await review(),undefined);
});
