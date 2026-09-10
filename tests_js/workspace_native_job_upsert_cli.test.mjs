import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, snapshot, cli } from './workspace_native_claims_support.mjs';

test('Python-free upsert CLI previews without writes and commits only the reviewed batch', {timeout:60000}, async () => {
  const fixture = await nativeFixture();
  try {
    const {root} = await setup(fixture,'upsert-cli');
    const payload={jobs:[{url:'https://example.invalid/upsert-cli',role:'Native upsert role',source:'Search'}, {url:''}]};
    const before=await snapshot(root);
    const preview=await cli(fixture,root,'job-upsert-preview',['--origin','agent'],payload);
    assert.equal(preview.committed,false);
    assert.deepEqual(preview.summary,{create:1,update:0,noop:0,conflict:0,invalid:1});
    assert.deepEqual(await snapshot(root),before);
    for(const args of [[],['--origin','migration'],['--origin','agent','--token','extra'],['--origin','agent','--unknown','x']]) {
      await assert.rejects(()=>cli(fixture,root,'job-upsert-preview',args,payload));
    }
    await assert.rejects(()=>cli(fixture,root,'job-upsert-commit',['--origin','agent'],payload),/token/);
    await assert.rejects(()=>cli(fixture,root,'job-upsert-commit',['--origin','agent','--token','forged'],payload),/drifted/);
    assert.deepEqual(await snapshot(root),before);
    const committed=await cli(fixture,root,'job-upsert-commit',['--origin','agent','--token',preview.token],payload);
    assert.equal(committed.committed,true);
    assert.deepEqual(committed.decisions,preview.decisions);
    const saved=await cli(fixture,root,'job-get',['--id',preview.decisions[0].id]);
    assert.equal(saved.role,'Native upsert role');
    assert.equal(saved.status,'saved');
    assert.equal(saved.provenance['/role'].origin,'agent');
    await assert.rejects(()=>cli(fixture,root,'job-upsert-commit',['--origin','agent','--token',preview.token],payload),/drifted/);
    const again=await cli(fixture,root,'job-upsert-preview',['--origin','agent'],payload);
    assert.equal(again.summary.noop,1);
    const settled=await snapshot(root);
    assert.equal((await cli(fixture,root,'job-upsert-commit',['--origin','agent','--token',again.token],payload)).committed,false);
    assert.deepEqual(await snapshot(root),settled);
    for(const name of Object.keys(before).filter(name=>name!=='jobs.json')) assert.equal(settled[name],before[name],name);
  } finally {await fixture.cleanup();}
});

test('bulk upsert stdin accepts the same reviewed batch as file input', {timeout:60000}, async () => {
  const {spawn} = await import('node:child_process');
  const fixture = await nativeFixture();
  try {
    const {root} = await setup(fixture,'upsert-stdin');
    const payload = {jobs:Array.from({length:10},(_,index)=>({url:`https://example.invalid/bulk-${index}`,description:'a'.repeat(8192)}))};
    const stdin = (command,token) => new Promise((resolve,reject) => {
      const child = spawn(process.execPath,['runtime/cli/native-jobs.js','--root',root,'--native-lock',fixture.receipt.artifact,
        command,'--origin','agent','--input','-',...(token?['--token',token]:[])],{cwd:new URL('../',import.meta.url),env:{PATH:''}});
      let stdout='',stderr='';
      child.stdout.on('data',bytes=>{stdout+=bytes;});
      child.stderr.on('data',bytes=>{stderr+=bytes;});
      child.on('error',reject);
      child.on('close',code=>{
        if(code!==0) return reject(Error(stderr));
        try {resolve(JSON.parse(stdout));} catch(error){reject(error);}
      });
      child.stdin.on('error',()=>{});
      child.stdin.end(JSON.stringify(payload));
    });
    const file = await cli(fixture,root,'job-upsert-preview',['--origin','agent'],payload);
    assert.equal(file.summary.create,10);
    const before = await snapshot(root);
    assert.deepEqual(await stdin('job-upsert-preview'),file);
    assert.deepEqual(await snapshot(root),before);
    const committed=await stdin('job-upsert-commit',file.token);
    assert.equal(committed.committed,true);
    assert.deepEqual(committed.decisions,file.decisions);
  } finally {await fixture.cleanup();}
});
