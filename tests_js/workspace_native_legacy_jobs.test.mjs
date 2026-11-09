import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { appendFile, readFile, unlink, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, oracle, native, report, reportRoot, snapshot } from './workspace_native_legacy_jobs_support.mjs';
async function parity(f,op,selected=[],token) {
  const expected=oracle(f,op,selected,token),actual=await native(f,op,selected,token);
  assert.deepEqual(actual,expected);
  return actual;
}
test('native legacy discovery and selection preserve Python identities, errors and preview tokens', {timeout:60000},async()=>{
  const fixture=await nativeFixture();
  try {
    const f=await setup(fixture,'discovery');
    const {value:discovery}=await parity(f,'preview');
    assert.equal(discovery.manifest.length,1);
    assert.equal(discovery.items.length,6);
    assert.deepEqual(discovery.items.slice(2).map(item=>item.reason),['unsupported_heading','duplicate_field','missing_url','ambiguous_url']);
    const [a,b]=discovery.items.map(item=>item.itemId);
    const before=await snapshot(f.root);
    const first=await parity(f,'preview',[a,b]);
    const reversed=await parity(f,'preview',[b,a]);
    assert.notEqual(first.value.token,reversed.value.token);
    for(const selected of [[a,a],['unknown'],[discovery.items[2].itemId]]) assert.ok((await parity(f,'preview',selected)).error);
    assert.equal(await snapshot(f.root),before);
    assert.ok(!JSON.stringify(discovery).includes(f.home));
  } finally {await fixture.cleanup();}
});
test('native legacy commits preserve provenance, noop reimport and stable-locator URL refresh', {timeout:60000},async()=>{
  const fixture=await nativeFixture();
  try {
    const f=await setup(fixture,'reimport');
    const {value:discovery}=await parity(f,'preview');
    const selected=[discovery.items[0].itemId];
    let preview=await parity(f,'preview',selected);
    let committed=await parity(f,'commit',selected,preview.value.token);
    assert.equal(committed.value.committed,true);
    assert.deepEqual(JSON.parse(await snapshot(f.root)),JSON.parse(await snapshot(f.pythonRoot)));
    const initial=JSON.parse(await snapshot(f.root)),id=committed.value.decisions[0].id;
    assert.equal(initial.jobs[id].legacySources.length,1);
    preview=await parity(f,'preview',selected);
    assert.equal(preview.value.decisions[0].action,'noop');
    const before=await snapshot(f.root);
    committed=await parity(f,'commit',selected,preview.value.token);
    assert.equal(committed.value.committed,false);
    assert.equal(await snapshot(f.root),before);
    const path=join(f.home,reportRoot,'search-2026-09-10.md');
    await writeFile(path,(await readFile(path,'utf8')).replace('jobs/one?utm_source=synthetic','jobs/refreshed'));
    preview=await parity(f,'preview',selected);
    committed=await parity(f,'commit',selected,preview.value.token);
    assert.equal(committed.value.decisions[0].id,id);
    const updated=JSON.parse(await snapshot(f.root));
    assert.equal(updated.jobs[id].legacySources.length,1);
    assert.equal(updated.jobs[id].url,'https://example.invalid/jobs/refreshed');
    assert.deepEqual(updated,JSON.parse(await snapshot(f.pythonRoot)));
  } finally {await fixture.cleanup();}
});
test('source, selection and Store drift reject commits without writing jobs', {timeout:60000},async t=>{
  const fixture=await nativeFixture();
  try {
    for(const drift of ['source','unselected-source','store','selection']) await t.test(drift,async()=>{
      const f=await setup(fixture,drift),{value:discovery}=await parity(f,'preview');
      const selected=[discovery.items[0].itemId],preview=await parity(f,'preview',selected);
      if(drift==='source') await appendFile(join(f.home,reportRoot,'search-2026-09-10.md'),'\nsource changed');
      if(drift==='unselected-source') await writeFile(join(f.home,reportRoot,'search-extra.md'),'# no selected entries');
      if(drift==='store') for(const root of [f.root,f.pythonRoot]) {
        const value=JSON.parse(await snapshot(root));value.metadata.updatedAt='2026-09-11T00:00:00Z';
        await writeFile(join(root,'jobs.json'),JSON.stringify(value),{mode:0o600});
      }
      const before=await snapshot(f.root);
      const result=await parity(f,'commit',drift==='selection'?[discovery.items[1].itemId]:selected,preview.value.token);
      assert.match(result.error,/drifted/);
      assert.equal(await snapshot(f.root),before);
    });
  } finally {await fixture.cleanup();}
});
test('missing jobs snapshot previews read-only then imports identically to Python', {timeout:60000},async()=>{
  const fixture=await nativeFixture();
  try {
    const f=await setup(fixture,'missing');
    await unlink(join(f.root,'jobs.json'));await unlink(join(f.pythonRoot,'jobs.json'));
    const {value:discovery}=await parity(f,'preview'),selected=[discovery.items[0].itemId];
    const preview=await parity(f,'preview',selected);
    assert.equal(await snapshot(f.root),null);
    await parity(f,'commit',selected,preview.value.token);
    assert.deepEqual(JSON.parse(await snapshot(f.root)),JSON.parse(await snapshot(f.pythonRoot)));
  } finally {await fixture.cleanup();}
});
test('legacy discovery rejects symlink reports and invalid UTF8 without mutating jobs', {timeout:60000},async t=>{
  const fixture=await nativeFixture();
  try {
    for(const kind of ['symlink','utf8']) await t.test(kind,async()=>{
      const f=await setup(fixture,kind),path=join(f.home,reportRoot,'search-unsafe.md');
      if(kind==='symlink') await symlink(join(f.home,reportRoot,'search-2026-09-10.md'),path);
      else await writeFile(path,Buffer.from([0xff]));
      const before=await snapshot(f.root),result=await parity(f,'preview');
      assert.ok(result.error);
      assert.equal(await snapshot(f.root),before);
    });
  } finally {await fixture.cleanup();}
});

test('duplicate source URLs coalesce while preserving both source locators', {timeout:60000},async()=>{
  const fixture=await nativeFixture();
  try {
    const f=await setup(fixture,'duplicate-url');
    await writeFile(join(f.home,reportRoot,'search-second.md'),report.split('### 2.')[0]);
    const {value:discovery}=await parity(f,'preview');
    const selected=[discovery.items[0].itemId,discovery.items.at(-1).itemId];
    const preview=await parity(f,'preview',selected);
    const committed=await parity(f,'commit',selected,preview.value.token);
    assert.equal(committed.value.decisions[0].id,committed.value.decisions[1].id);
    const jobs=JSON.parse(await snapshot(f.root)).jobs;
    assert.equal(Object.keys(jobs).length,1);
    assert.equal(Object.values(jobs)[0].legacySources.length,2);
    assert.deepEqual(JSON.parse(await snapshot(f.root)),JSON.parse(await snapshot(f.pythonRoot)));
  } finally {await fixture.cleanup();}
});

test('legacy CLI supports repeatable selection, token confirmation and rejects duplicates', {timeout:60000},async()=>{
  const fixture=await nativeFixture();
  try {
    const f=await setup(fixture,'cli');
    const cli=(command,args=[])=>spawnSync(process.execPath,['runtime/cli/native-jobs.js',command,
      '--root',f.root,'--native-lock',fixture.receipt.artifact,...args],{
      env:{...process.env,HOME:f.home},encoding:'utf8',timeout:10000,
    });
    let result=cli('legacy-jobs-preview');
    assert.equal(result.status,0,result.stderr);
    const discovery=JSON.parse(result.stdout),selected=discovery.items.slice(0,2).map(item=>item.itemId);
    const selection=selected.flatMap(id=>['--select',id]);
    result=cli('legacy-jobs-preview',selection);
    assert.equal(result.status,0,result.stderr);
    const preview=JSON.parse(result.stdout);
    assert.deepEqual(preview.selected,selected);
    const duplicate=cli('legacy-jobs-preview',['--select',selected[0],'--select',selected[0]]);
    assert.notEqual(duplicate.status,0);
    assert.match(duplicate.stderr,/duplicate item ids/);
    const missingToken=cli('legacy-jobs-commit',selection);
    assert.notEqual(missingToken.status,0);
    result=cli('legacy-jobs-commit',[...selection,'--confirm',preview.token]);
    assert.equal(result.status,0,result.stderr);
    assert.equal(JSON.parse(result.stdout).committed,true);
    assert.equal(Object.keys(JSON.parse(await snapshot(f.root)).jobs).length,2);
  } finally {await fixture.cleanup();}
});

test('legacy heading digits use the supported Python Unicode database rather than the Node version', async () => {
  const fixture=await nativeFixture();
  try {
    const f=await setup(fixture,'unicode-digits');
    const digits=['1','١','𝟘','𑽐','𞓰','𐵀','\ufeff1'];
    const content=digits.map((digit,index)=>`### ${digit}. Role ${index} — Fixture\n- **URL**: https://example.invalid/unicode/${index}`).join('\n');
    await writeFile(join(f.home,reportRoot,'search-2026-09-10.md'),content);
    const {value}=await parity(f,'preview');
    assert.deepEqual(value.items.map(item=>item.state),['valid','valid','valid','valid','valid','invalid','invalid']);
  } finally {await fixture.cleanup();}
});
