import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { atomicWritePointJson } from '../runtime/store/point-persistence.js';
import { bytes, fixed, killAt, recover, seed } from './workspace_native_claims_recovery_support.mjs';
const events = source => source.trim().split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line));

test('SIGKILL at all six claim handoff boundaries recovers exactly once on ordinary access', {timeout:60000}, async t=>{
  const fixture=await nativeFixture();
  try {
    for(const boundary of ['journal','jobs.json','sessions/job.json','history','coordinator.json','clear']) {
      await t.test(boundary,async()=>{
        const {root,provider,token}=await seed(fixture,boundary.replaceAll('/','-'));
        const intended=await killAt(root,fixture.receipt.artifact,boundary,token);
        assert.equal(intended.kind,'handoff');
        assert.equal(intended.at,fixed);
        const recovered=await recover(root,fixture.receipt.artifact);
        const job=JSON.parse(recovered['jobs.json']).jobs.job;
        assert.equal(job.status,'needs_info');
        assert.equal(job.revision,3);
        assert.deepEqual(JSON.parse(recovered['sessions/job.json']),intended.session);
        const history=events(recovered['applications.jsonl']);
        assert.equal(history.length,2);
        assert.deepEqual(history.filter(event=>event.eventId===intended.historyEvent.eventId),[intended.historyEvent]);
        assert.deepEqual(JSON.parse(recovered['coordinator.json']),{schemaVersion:1,claim:null});
        assert.deepEqual(JSON.parse(recovered['coordinator-journal.json']),{schemaVersion:1,operation:null});
        for(const content of Object.values(recovered)) assert.ok(!content.includes(token),'Bearer token must never be persisted');
        await new NativeJobsRepository(root,provider).transaction(async()=>{});
        assert.deepEqual(await bytes(root),recovered,'Replay must be byte-idempotent');
      });
    }
  } finally {await fixture.cleanup();}
});

test('pending claim recovery rejects colliding event IDs before canonical writes', {timeout:60000},async()=>{
  const fixture=await nativeFixture();
  try {
    const {root,provider,token}=await seed(fixture,'collision');
    const intended=await killAt(root,fixture.receipt.artifact,'journal',token);
    await appendFile(join(root,'applications.jsonl'),JSON.stringify({...intended.historyEvent,event:'different-event'})+'\n');
    const before=await bytes(root),writes=[];
    const repository=new NativeJobsRepository(root,provider,async(path,value,options)=>{
      writes.push(path);await atomicWritePointJson(path,value,options);
    });
    await assert.rejects(repository.transaction(async()=>{}),/history event id collision/);
    assert.deepEqual(writes,[]);
    assert.deepEqual(await bytes(root),before);
  } finally {await fixture.cleanup();}
});

test('pending claim recovery repairs a truncated append tail and appends one complete event', {timeout:60000},async()=>{
  const fixture=await nativeFixture();
  try {
    const {root,token}=await seed(fixture,'tail');
    const intended=await killAt(root,fixture.receipt.artifact,'journal',token);
    const original=await readFile(join(root,'applications.jsonl'),'utf8');
    await appendFile(join(root,'applications.jsonl'),'\n{"eventId":"partial');
    const recovered=await recover(root,fixture.receipt.artifact);
    assert.ok(recovered['applications.jsonl'].startsWith(original));
    assert.deepEqual(events(recovered['applications.jsonl']).filter(event=>event.eventId===intended.historyEvent.eventId),[intended.historyEvent]);
    const twice=await recover(root,fixture.receipt.artifact);
    assert.deepEqual(twice,recovered);
  } finally {await fixture.cleanup();}
});
