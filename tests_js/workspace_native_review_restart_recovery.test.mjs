import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { atomicWritePointJson } from '../runtime/store/point-persistence.js';
import { bytes, fixed, killAt, recover, seed } from './workspace_native_review_restart_recovery_support.mjs';

const events = source => source.trim().split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line));

// Catches missing replay steps, double revision/event replay, and rewriting old review evidence.
for(const legacy of [false,true]) {
  const kind=legacy?'legacy':'modern';
  test(`${kind} reviewed restart survives SIGKILL at all five durable boundaries`,{timeout:60000},async t=>{
    const fixture=await nativeFixture();
    try {
      for(const boundary of ['journal','jobs.json','history','coordinator.json','clear']) {
        await t.test(boundary,async()=>{
          const {root,provider,token,sessionBytes}=await seed(fixture,`${kind}-${boundary}`,legacy);
          const intended=await killAt(root,fixture.receipt.artifact,boundary);
          assert.equal(intended.kind,'review_restart');
          assert.equal(intended.at,fixed);
          assert.equal(intended.sourceStatus,'awaiting_review');
          assert.equal(intended.targetStatus,'in_progress');
          assert.equal(intended.expectedRevision,4);
          assert.equal(Object.hasOwn(intended,'session'),false);
          const recovered=await recover(root,fixture.receipt.artifact);
          const job=JSON.parse(recovered['jobs.json']).jobs.job;
          assert.equal(job.status,'in_progress');
          assert.equal(job.revision,5);
          assert.equal(recovered['sessions/job.json'],sessionBytes);
          const history=events(recovered['applications.jsonl']);
          assert.deepEqual(history.map(event=>event.event),['job-started','reviewed',legacy?'legacy-review-rebuild':'job-restarted']);
          assert.deepEqual(history.filter(event=>event.eventId===intended.historyEvent.eventId),[intended.historyEvent]);
          assert.deepEqual(JSON.parse(recovered['coordinator.json']),{schemaVersion:1,claim:intended.resultClaim});
          assert.equal(intended.resultClaim.jobId,'job');
          assert.equal(intended.resultClaim.ownerLabel,'Restart owner');
          assert.equal(intended.resultClaim.expiresAt,'2026-09-10T12:05:00Z');
          assert.ok(intended.resultClaim.tokenHash);
          assert.deepEqual(JSON.parse(recovered['coordinator-journal.json']),{schemaVersion:1,operation:null});
          for(const content of [...Object.values(recovered),JSON.stringify(intended)]) {
            assert.ok(!content.includes(token),'Prior bearer token must never be persisted');
            assert.doesNotMatch(content,/"token"\s*:/,'Restart bearer must never be a persisted field');
          }
          assert.doesNotMatch(recovered['applications.jsonl'],/tokenHash/);
          await new NativeJobsRepository(root,provider).transaction(async()=>{});
          assert.deepEqual(await bytes(root),recovered,'Second access must not revise or append again');
          assert.deepEqual(await recover(root,fixture.receipt.artifact),recovered,'Fresh-process replay must be byte-idempotent');
        });
      }
    } finally {await fixture.cleanup();}
  });

  // Catches recovery overwriting canonical state before detecting a conflicting audit event.
  test(`${kind} pending reviewed restart rejects event ID collision before writes`,{timeout:60000},async()=>{
    const fixture=await nativeFixture();
    try {
      const {root,provider}=await seed(fixture,`${kind}-collision`,legacy);
      const intended=await killAt(root,fixture.receipt.artifact,'journal');
      await appendFile(join(root,'applications.jsonl'),JSON.stringify({...intended.historyEvent,event:'different-event'})+'\n');
      const before=await bytes(root),writes=[];
      const repository=new NativeJobsRepository(root,provider,async(path,value,options)=>{
        writes.push(path);
        await atomicWritePointJson(path,value,options);
      });
      await assert.rejects(repository.transaction(async()=>{}),/history event id collision/);
      assert.deepEqual(writes,[]);
      assert.deepEqual(await bytes(root),before);
    } finally {await fixture.cleanup();}
  });
}
