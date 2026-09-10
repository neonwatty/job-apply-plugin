import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { fromJSON, parse, serialize } from '../runtime/contracts/workspace/values.js';
const loaded = await import('../runtime/workspace-core/job-upsert.js').catch(() => ({}));
const plain = value => JSON.parse(serialize(value));
const now = '2026-09-10T15:00:00Z';

function fixture() {
  let document = fromJSON({schemaVersion:1, metadata:{updatedAt:'before'}, jobs:{}}), saves = 0;
  const repository = {async upsertTransaction(operation) {
    return operation({document, requireUnclaimed() {throw new Error('unexpected claim guard');},
      async requireResume() {throw new Error('unexpected resume validation');},
      async save(value) {document = value; saves++;}});
  }};
  return {repository, snapshot:() => plain(document), saves:() => saves};
}

test('upsert binds canonical input, plans without mutation and saves only changed jobs', async () => {
  assert.equal(typeof loaded.JobUpsertService, 'function');
  const store = fixture(), service = new loaded.JobUpsertService(store.repository, () => now);
  const payload = fromJSON({jobs:[{url:' HTTPS://EXAMPLE.COM:443/job#top ',role:' Engineer ',priority:0}]});
  const preview = plain(await service.preview(payload, 'agent'));
  const id = 'job-' + createHash('sha256').update('url\0https://example.com/job').digest('hex').slice(0,24);
  assert.deepEqual(preview.decisions,[{index:0,action:'create',id}]);
  assert.equal(preview.committed,false); assert.equal(store.saves(),0);
  assert.deepEqual(store.snapshot().jobs,{});
  const trimmed = fromJSON({jobs:[{priority:0,role:'Engineer',url:'HTTPS://EXAMPLE.COM:443/job#top'}]});
  assert.equal(plain(await service.preview(trimmed,'agent')).token,preview.token);
  const committed = plain(await service.commit(trimmed,'agent',preview.token));
  assert.equal(committed.committed,true); assert.equal(store.saves(),1);
  assert.equal(store.snapshot().jobs[id].role,'Engineer');
  assert.equal(store.snapshot().jobs[id].provenance['/priority'].origin,'agent');
  await assert.rejects(service.commit(payload,'agent',preview.token),/store or input drifted/);
  const noop = plain(await service.preview(payload,'agent'));
  assert.equal(plain(await service.commit(payload,'agent',noop.token)).committed,false);
  assert.equal(store.saves(),1);
});

test('upsert detects batch identity conflicts, invalid items and protected agent fields', async () => {
  assert.equal(typeof loaded.JobUpsertService, 'function');
  const store=fixture(), service=new loaded.JobUpsertService(store.repository,()=>now);
  const initial=fromJSON({jobs:[{url:'https://example.com/job',role:'Owner',source:' Board ',sourceId:' id '}]});
  await service.commit(initial,'human',plain(await service.preview(initial,'human')).token);
  const changed=fromJSON({jobs:[{url:'https://example.com/job',role:'Agent',company:'New'}]});
  const preview=plain(await service.preview(changed,'agent'));
  assert.deepEqual(preview.decisions[0].fields,['company']);
  await service.commit(changed,'agent',preview.token);
  assert.equal(Object.values(store.snapshot().jobs)[0].role,'Owner');
  const batch=fromJSON({jobs:[{url:'https://example.com/new',role:'A'},
    {url:'https://example.com/new#fragment',role:'B'},null,{url:'https://example.com/other',priority:true}]});
  const result=plain(await service.preview(batch,'human'));
  assert.deepEqual(result.summary,{create:0,update:0,noop:0,conflict:2,invalid:2});
  await assert.rejects(service.preview(parse('{"jobs":[],"extra":1}'),'human'),/only a jobs array/);
  await assert.rejects(service.preview(fromJSON({jobs:[]}), 'migration'),/human or agent/);
});
