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
