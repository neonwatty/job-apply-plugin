import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, start, ask, reply, snapshot, read } from './workspace_durable_preparation_support.mjs';
const execute=promisify(execFile);
const script=new URL('../runtime/cli/experimental-workflow.js',import.meta.url).pathname;

test('experimental CLI resumes durable state across processes and requires explicit synthetic scope and user attestation', {timeout:60000},async()=>{
  const fixture=await nativeFixture();
  try {
    const state=await setup(fixture,'cli'), home=join(fixture.root,'unused-home');await mkdir(home);
    let serial=0;
    async function cli(command,payload,extra=[],scoped=true) {
      const args=[command,...scoped?['--root',state.root,'--native-lock',fixture.receipt.artifact]:[],...extra];
      if(payload!==undefined) {
        const input=join(fixture.root,`input-${++serial}.json`);
        await writeFile(input,typeof payload==='string'?payload:JSON.stringify(payload));args.push('--input',input);
      }
      let result;
      try {result={...await execute(process.execPath,[script,...args],{env:{PATH:'',HOME:home},timeout:15000}),code:0};}
      catch(error){if(typeof error.code!=='number')throw error;result=error;}
      assert.equal(result.stderr,'');assert.ok([0,2].includes(result.code));
      assert.doesNotMatch(result.stdout,/PRIVATE|tokenHash|claim_|stack|unused-home/);
      return JSON.parse(result.stdout);
    }
    const before=await snapshot(state.root);
    assert.equal((await cli('context',undefined,[],false)).ok,false);
    assert.deepEqual(await readdir(home),[]);
    assert.deepEqual(await snapshot(state.root),before);
    const started=await cli('route',start());assert.equal(started.ok,true);
    const paused=await cli('action',ask(started.result.receipt.task));assert.equal(paused.ok,true);
    assert.deepEqual((await cli('context')).result.task,paused.result.receipt.task);
    const event=reply(paused.result.receipt.task), waiting=await snapshot(state.root);
    assert.equal((await cli('route',event.proposal)).error,'user_event_required');
    assert.equal((await cli('reply',event.proposal)).error,'user_event_required');
    assert.equal((await cli('route',event.proposal,['--host-user-event'])).ok,false);
    assert.equal((await cli('route',' '.repeat(131073))).ok,false);
    assert.deepEqual(await snapshot(state.root),waiting);
    const result=await cli('reply',event.proposal,['--host-user-event']);assert.equal(result.ok,true);
    assert.equal(result.result.receipt.outcome,'job_ready');
    const done=await snapshot(state.root);
    const repeated=await cli('reply',event.proposal,['--host-user-event']);assert.equal(repeated.result.replayed,true);
    assert.deepEqual(await snapshot(state.root),done);
    assert.equal((await read(state.root,'jobs.json')).jobs.job.revision,2);
    const marker=join(state.root,'.native-jobs-fixture');await writeFile(marker,'unrecognized\n',{mode:0o600});
    assert.equal((await cli('context')).ok,false);
  } finally {await fixture.cleanup();}
});
