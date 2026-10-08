import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareContinuationFixture, observeContinuation, introduceStaleFacts, alternateResumeId } from '../evals/preparation/continuation-fixture.mjs';

const root=await realpath(fileURLToPath(new URL('../',import.meta.url)));
test('continuation fixtures create real unresolved choice and stale fact scope without a job edit',async t=>{
  for(const scenario of ['unresolved-resume','stale-facts'])await t.test(scenario,async()=>{
    const workspace=await realpath(await mkdtemp(join(tmpdir(),'job-apply-continuation-fixture-')));
    try{
      const fixture=await prepareContinuationFixture(root,workspace,scenario);
      const before=await observeContinuation(root,fixture);
      assert.equal(before.job.status,'saved');assert.equal(before.claim,null);assert.deepEqual(before.sessions,[]);
      if(scenario==='unresolved-resume'){
        assert.equal(before.activeRun,null);assert.equal(before.preflightReady,false);
        assert.equal(before.factSummaries.length,2);
        assert.ok(before.factSummaries.some(x=>x.resumeId===alternateResumeId&&x.state==='confirmed'));
      }else{
        assert.equal(before.preflightReady,true);
        await introduceStaleFacts(root,fixture);
        const after=await observeContinuation(root,fixture);
        assert.equal(after.preflightReady,false);
        assert.deepEqual(after.job,before.job);assert.deepEqual(after.activeRun,before.activeRun);
        assert.equal(after.factSummaries[0].state,'draft');
        assert.equal(after.factSummaries[0].revision,before.factSummaries[0].revision+1);
        assert.deepEqual(Object.keys(before.hashes).filter(k=>before.hashes[k]!==after.hashes[k]),['resume-facts.json']);
      }
    }finally{await rm(workspace,{recursive:true,force:true});}
  });
});

// Exercise the actual pinned baseline inventory; current-source imports cannot prove compatibility.
test('continuation observations and interventions support the pinned staging package', async () => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'job-apply-continuation-baseline-')));
  const command = promisify(execFile);
  try {
    const pluginRoot = join(temporary, 'package');
    await mkdir(pluginRoot);
    const archive = join(temporary, 'source.tar');
    await command('git', ['archive', '--format=tar', `--output=${archive}`,
      'f95b4947453ad6c6abc9cc0e81c3e443706d4714'], { cwd: root });
    await command('tar', ['-xf', archive, '-C', pluginRoot]);
    for (const scenario of ['unresolved-resume', 'stale-facts']) {
      const workspace = join(temporary, scenario);
      await mkdir(workspace);
      const fixture = await prepareContinuationFixture(pluginRoot, workspace, scenario);
      const before = await observeContinuation(pluginRoot, fixture);
      assert.equal(before.preflightReady, scenario === 'stale-facts');
      if (scenario === 'stale-facts') {
        await introduceStaleFacts(pluginRoot, fixture);
        const after = await observeContinuation(pluginRoot, fixture);
        assert.equal(after.preflightReady, false);
        assert.deepEqual(after.job, before.job);
        assert.deepEqual(after.activeRun, before.activeRun);
      } else {
        assert.equal(before.activeRun, null);
        assert.equal(before.factSummaries.length, 2);
      }
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
