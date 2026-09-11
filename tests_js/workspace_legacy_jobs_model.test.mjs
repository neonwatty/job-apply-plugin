import assert from 'node:assert/strict';
import test from 'node:test';
import {fromJSON, serialize} from '../runtime/contracts/workspace/values.js';
const loaded = await import('../runtime/workspace-core/legacy-jobs.js').catch(() => ({}));
const plain = value => JSON.parse(serialize(value));
const fixed = '2026-09-11T12:00:00Z';
const locator = {sourceKind:'timestamped-search-report',relativePath:'search-one.md',
  entryId:'legacy-entry-'+'a'.repeat(24),sourceSha256:'b'.repeat(64)};
const item = {itemId:'one',state:'valid',source:locator,job:{url:'https://example.com/job',role:'Engineer'}};
function fixture() {
  let current=null, discovery={root:'~/.jobs',manifest:[],items:[item]}, saves=0, snapshots=0;
  const repository={async legacyTransaction(operation) {return operation({
    async snapshot() {snapshots++; return {document:fromJSON(current ?? {schemaVersion:1,jobs:{},metadata:{
      createdAt:'1970-01-01T00:00:00Z',updatedAt:'1970-01-01T00:00:00Z'}}),snapshot:fromJSON(current ?? {state:'missing'})};},
    async save(document) {saves++; current=plain(document);}
  });}};
  return {repository, discover:async()=>fromJSON(discovery), discovery:value=>{discovery=value;},
    current:()=>current, saves:()=>saves, snapshots:()=>snapshots};
}

test('legacy import previews without initializing and binds missing state and selection',async()=>{
  assert.equal(typeof loaded.LegacyJobsService,'function');
  const state=fixture(), service=new loaded.LegacyJobsService(state.repository,state.discover,()=>fixed);
  const discovered=plain(await service.preview([]));
  assert.equal(discovered.token,undefined); assert.equal(state.snapshots(),0);
  const preview=plain(await service.preview(['one']));
  assert.equal(state.saves(),0); assert.equal(preview.decisions[0].action,'create');
  assert.equal(preview.decisions[0].itemId,'one');
  await service.commit(['one'],preview.token);
  const record=Object.values(state.current().jobs)[0];
  assert.equal(record.provenance['/role'].origin,'migration');
  assert.deepEqual(record.legacySources,[locator]);
  assert.equal(state.current().metadata.createdAt,fixed);
  await assert.rejects(service.commit(['one'],preview.token),/drifted/);
  const noop=plain(await service.preview(['one']));
  assert.equal(plain(await service.commit(['one'],noop.token)).committed,false);
  assert.equal(state.saves(),1);
  await assert.rejects(service.preview(['one','one']),/duplicate item ids/);
  await assert.rejects(service.preview(['missing']),/unknown item id/);
  await assert.rejects(service.commit(['missing'],'bad'),/drifted/);
});

test('migration locator permits URL refresh and locator-only update preserves provenance',async()=>{
  assert.equal(typeof loaded.LegacyJobsService,'function');
  const state=fixture(), service=new loaded.LegacyJobsService(state.repository,state.discover,()=>fixed);
  await service.commit(['one'],plain(await service.preview(['one'])).token);
  state.discovery({root:'~/.jobs',manifest:[],items:[{...item,source:{...locator,sourceSha256:'c'.repeat(64)},
    job:{...item.job,url:'https://example.com/moved'}}]});
  const refreshed=plain(await service.preview(['one']));
  assert.deepEqual(refreshed.decisions[0].fields,['legacySources','url']);
  await service.commit(['one'],refreshed.token);
  const record=Object.values(state.current().jobs)[0];
  assert.equal(record.url,'https://example.com/moved'); assert.equal(record.revision,2);
  state.discovery({root:'~/.jobs',manifest:[],items:[{...item,source:{...locator,sourceSha256:'d'.repeat(64)},
    job:{...item.job,url:'https://example.com/moved'}}]});
  const locatorOnly=plain(await service.preview(['one']));
  assert.deepEqual(locatorOnly.decisions[0].fields,['legacySources']);
  await service.commit(['one'],locatorOnly.token);
  assert.equal(Object.values(state.current().jobs)[0].revision,3);
});
