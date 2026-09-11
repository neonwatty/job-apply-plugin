import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskIntakeService } from '../runtime/workspace-core/task-intake.js';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';
const empty = () => fromJSON({schemaVersion:1,jobs:{},metadata:{updatedAt:'2026-09-11T00:00:00Z'}});

test('task intake reports persistence failure without returning a successful action', async () => {
  const document=empty(); let saves=0;
  const service=new TaskIntakeService({upsertTransaction:operation=>operation({document,save:async()=>{saves++;throw Error('write failed');}})});
  await assert.rejects(service.intake(fromJSON({url:'https://example.invalid/fail'})),/write failed/);
  assert.equal(saves,1);
  assert.deepEqual(JSON.parse(serialize(document)).jobs,{});
});

test('invalid input is rejected with the generic intake error before persistence', async () => {
  let saves=0;
  const service=new TaskIntakeService({upsertTransaction:operation=>operation({document:empty(),save:async()=>{saves++;}})});
  for(const input of [null,[],{url:'PRIVATE-invalid-url'},{url:'https://example.invalid/x',status:'PRIVATE-invalid-status'}]) {
    await assert.rejects(service.intake(fromJSON(input)),{message:'task intake invalid'});
  }
  assert.equal(saves,0);
  await assert.rejects(service.intake(fromJSON({url:'https://example.invalid/x'}),'migration'),/origin must be human or agent/);
});
