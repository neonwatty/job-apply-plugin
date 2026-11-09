import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, snapshot, cli, readyPacket, plain } from './workspace_native_claims_support.mjs';
import { jobsHttp } from '../runtime/workspace-core/jobs-http.js';
import { fromJSON, text } from '../runtime/contracts/workspace/values.js';

test('native transition HTTP and Python-free CLI preserve revision and owner confirmation boundaries', {timeout:60000}, async () => {
  const fixture = await nativeFixture();
  try {
    const {root,repository,jobs,claims} = await setup(fixture,'transition-adapters');
    const post = payload => jobsHttp(jobs,repository,'POST','/api/jobs/job/transition',JSON.stringify(payload));
    assert.equal((await post({status:'ready',expectedRevision:1})).status,200);
    assert.equal((await post({status:'saved',expectedRevision:1})).status,409);
    const acquired=plain(await claims.acquire('job',text('Owner'),2n));
    const beforeClaimed=await snapshot(root);
    assert.equal((await post({status:'closed',closedOutcome:'withdrawn',expectedRevision:3})).status,400);
    assert.deepEqual(await snapshot(root),beforeClaimed);
    await claims.handoff('job',text(acquired.token),'awaiting_review',fromJSON({status:'review',readinessInput:readyPacket(3)}),3n);
    const before=await snapshot(root);
    for(const payload of [
      {status:'applied',expectedRevision:4},
      {status:'applied',expectedRevision:4,userConfirmed:'true'},
      {status:'closed',expectedRevision:4,closedOutcome:false},
      {status:'closed',expectedRevision:true,closedOutcome:'withdrawn'},
      {status:'closed',expectedRevision:4,closedOutcome:'withdrawn',extra:true},
    ]) assert.equal((await post(payload)).status,400);
    await assert.rejects(()=>cli(fixture,root,'job-transition',['--id','job','--status','applied','--expected-revision','4']),/confirmation/);
    assert.deepEqual(await snapshot(root),before);
    const applied=await cli(fixture,root,'job-transition',['--id','job','--status','applied','--expected-revision','4','--user-confirmed']);
    assert.equal(applied.status,'applied');assert.equal(applied.revision,5);
    const closed=await post({status:'closed',expectedRevision:5,closedOutcome:'withdrawn'});
    assert.equal(closed.status,200);assert.equal(JSON.parse(closed.body).closedOutcome,'withdrawn');
    const reopened=await cli(fixture,root,'job-transition',['--id','job','--status','saved','--expected-revision','6']);
    assert.equal(reopened.closedOutcome,null);assert.equal(reopened.revision,7);
    const after=await snapshot(root);
    for(const name of Object.keys(before).filter(name=>name!=='jobs.json')) assert.equal(after[name],before[name],name);
    assert.equal((await jobsHttp(jobs,repository,'POST','/api/jobs/missing/transition','{"status":"saved","expectedRevision":1}')).status,404);
  } finally {await fixture.cleanup();}
});
