import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, snapshot, cli } from './workspace_native_claims_support.mjs';
import { jobsHttp } from '../runtime/workspace-core/jobs-http.js';
import { fromJSON, text } from '../runtime/contracts/workspace/values.js';

test('native projection HTTP and Python-free CLI agree without rewriting canonical documents', {timeout:60000}, async () => {
  const fixture = await nativeFixture();
  try {
    const {root, repository, jobs, claims} = await setup(fixture, 'projection-adapters');
    await claims.select('job', 1n, true);
    const acquired = JSON.parse((await import('../runtime/contracts/workspace/values.js')).serialize(await claims.acquire('job', text('PRIVATE-OWNER'), 2n)));
    await claims.handoff('job', text(acquired.token), 'needs_info', fromJSON({status:'active', attemptRevision:3,
      blockers:[{type:'information',code:'owner-input-required'}]}), 3n);
    const before = await snapshot(root);
    for (const [path, command, args] of [
      ['/api/overview','owner-beta-overview',[]],
      ['/api/attention','needs-attention',[]],
      ['/api/jobs/job/activity','job-activity',['--id','job']],
      ['/api/jobs/job/preflight','job-preflight',['--id','job']],
    ]) {
      const http = await jobsHttp(jobs, repository, 'GET', path);
      assert.equal(http.status, 200, path);
      const value = JSON.parse(http.body);
      assert.deepEqual(await cli(fixture, root, command, args), value);
      assert.doesNotMatch(http.body, /PRIVATE-PROFILE|PRIVATE-RESUME|PRIVATE-OWNER|tokenHash|example\.invalid/);
      assert.ok(!http.body.includes(acquired.token));
    }
    const attention = JSON.parse((await jobsHttp(jobs,repository,'GET','/api/attention')).body);
    assert.deepEqual(attention.items.map(item=>[item.jobId,item.reasonCode]), [['job','needs_information']]);
    assert.equal((await jobsHttp(jobs,repository,'GET','/api/jobs/missing/activity')).status,404);
    assert.equal((await jobsHttp(jobs,repository,'POST','/api/overview','{}')).status,501);
    await assert.rejects(()=>cli(fixture,root,'job-activity',['--id','missing']),/does not exist/);
    await assert.rejects(()=>cli(fixture,root,'needs-attention',['--id','job']),/unsupported/);
    assert.deepEqual(await snapshot(root),before);
  } finally { await fixture.cleanup(); }
});

test('site-required opt-in conflict has a distinct value-free attention state', {timeout:60000}, async () => {
  const fixture = await nativeFixture();
  try {
    const {root, repository, jobs, claims} = await setup(fixture, 'site-consent-conflict');
    await claims.select('job', 1n, true);
    const acquired = JSON.parse((await import('../runtime/contracts/workspace/values.js')).serialize(
      await claims.acquire('job', text('PRIVATE-OWNER'), 2n)));
    await claims.handoff('job', text(acquired.token), 'needs_info', fromJSON({
      status:'active', attemptRevision:3, pendingFields:[], handoffChecklist:['consent_choice'],
      blockers:[{type:'owner_review',code:'site-required-opt-in-conflict'}],
    }), 3n);
    const response = await jobsHttp(jobs, repository, 'GET', '/api/attention');
    assert.equal(response.status, 200);
    const attention = JSON.parse(response.body);
    assert.equal(attention.items[0].reasonCode, 'site_consent_conflict');
    assert.equal(attention.items[0].missingInformationCount, 0);
    assert.deepEqual(attention.items[0].session.handoffChecklist, ['consent_choice']);
    assert.match(attention.items[0].guidance, /saved decline/);
    assert.doesNotMatch(response.body, /PRIVATE-OWNER|recurring automated text messages/);
    assert.deepEqual(await cli(fixture, root, 'needs-attention'), attention);
  } finally { await fixture.cleanup(); }
});


test('attention snooze persists with revision protection and preserves job/session state', async () => {
  const fixture=await nativeFixture();
  try {
    const {repository,jobs,claims}=await setup(fixture,'attention-snooze');
    await claims.select('job',1n,true);
    const acquired=JSON.parse((await import('../runtime/contracts/workspace/values.js')).serialize(await claims.acquire('job',text('owner'),2n)));
    await claims.handoff('job',text(acquired.token),'needs_info',fromJSON({status:'active',attemptRevision:3,blockers:[{type:'information',code:'owner-input-required'}]}),3n);
    const get=async path=>JSON.parse((await jobsHttp(jobs,repository,'GET',path)).body);
    const before=await get('/api/jobs/job/activity');
    const row=(await get('/api/attention')).items[0];
    const patch={expectedRevision:row.revision,patch:{attentionSnoozedUntil:'2099-01-01T00:00:00.000Z'}};
    assert.equal((await jobsHttp(jobs,repository,'PATCH','/api/jobs/job',JSON.stringify(patch))).status,200);
    assert.equal((await get('/api/overview')).counts.attentionJobs,0);
    assert.equal((await get('/api/attention')).items[0].attentionSnoozedUntil,patch.patch.attentionSnoozedUntil);
    const after=await get('/api/jobs/job/activity');
    assert.equal(after.job.status,'needs_info');assert.deepEqual(after.session,before.session);
    assert.equal((await jobsHttp(jobs,repository,'PATCH','/api/jobs/job',JSON.stringify(patch))).status,409);
    patch.expectedRevision=after.job.revision;patch.patch.attentionSnoozedUntil=null;
    assert.equal((await jobsHttp(jobs,repository,'PATCH','/api/jobs/job',JSON.stringify(patch))).status,200);
    assert.equal((await get('/api/overview')).counts.attentionJobs,1);
    patch.expectedRevision++;
    patch.patch.attentionSnoozedUntil='not-a-date';
    assert.notEqual((await jobsHttp(jobs,repository,'PATCH','/api/jobs/job',JSON.stringify(patch))).status,200);
  } finally {await fixture.cleanup();}
});
