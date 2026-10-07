import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup,read,snapshot,event } from './workspace_durable_claims_support.mjs';
const cli=new URL('../runtime/cli/experimental-claim-workflow.js',import.meta.url).pathname;

test('separate CLI processes share a private durable broker and replay after broker replacement', {timeout:30000},async()=>{
  const fixture=await nativeFixture();
  const children=[];
  try {
    const state=await setup(fixture,'broker');await state.claims.select('job',1n,true);
    const common=['--root',state.root,'--native-lock',fixture.receipt.artifact];
    const execute=async(command,payload,attested=false)=>{
      const args=[cli,command,...common];
      if(payload) {const path=join(fixture.root,'event.json');await writeFile(path,JSON.stringify(payload));args.push('--input',path);}
      if(attested) args.push('--host-user-event');
      const response=await promisify(execFile)(process.execPath,args,{env:{PATH:''},timeout:5000});
      assert.equal(response.stderr,'');return JSON.parse(response.stdout);
    };
    const serve=async()=>{
      const child=spawn(process.execPath,[cli,'serve',...common],{stdio:['ignore','pipe','pipe'],env:{PATH:''}});
      children.push(child);
      child.done=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
      let ready;
      for(let i=0;i<100;i++) {
        try {ready=await execute('context');if(ready.ok) break;} catch {}
        await delay(25);
      }
      assert.equal(ready?.ok,true);return child;
    };
    let broker=await serve();
    const request=event('acquire');
    const before=await snapshot(state.root);
    assert.equal((await execute('event',request)).ok,false);
    assert.deepEqual(await snapshot(state.root),before);
    const result=await execute('event',request,true);assert.equal(result.ok,true);
    const task=result.result.receipt.task;
    assert.equal((await execute('context')).result.brokerAvailable,true);
    const duplicate=await execute('event',request,true);assert.equal(duplicate.result.replayed,true);
    broker.kill('SIGKILL');assert.equal((await broker.done).signal,'SIGKILL');
    broker=await serve();
    assert.equal((await execute('context')).result.brokerAvailable,false);
    assert.equal((await execute('event',request,true)).result.replayed,true);
    assert.equal((await execute('event',event('progress',task))).ok,false);
    // Advance only the fictional stored lease to demonstrate an explicit recovery event.
    const coordinator=await read(state.root,'coordinator.json');coordinator.claim.expiresAt='2020-01-01T00:00:00Z';
    await writeFile(join(state.root,'coordinator.json'),JSON.stringify(coordinator),{mode:0o600});
    const recovered=await execute('event',event('recover',task),true);assert.equal(recovered.ok,true);
    const cancel=event('cancel',recovered.result.receipt.task);
    const cancelled=await execute('event',cancel,true);assert.equal(cancelled.result.receipt.outcome,'cancelled');
    assert.equal((await read(state.root,'coordinator.json')).claim,null);
    assert.equal((await execute('event',cancel,true)).result.replayed,true);
    assert.doesNotMatch(JSON.stringify([result,duplicate,recovered,cancelled]),/token|claim_[A-Za-z0-9_-]{43}|PRIVATE/);
    broker.kill('SIGTERM');assert.equal((await broker.done).code,0);
  } finally {
    for(const child of children) {if(child.exitCode===null&&child.signalCode===null) child.kill('SIGKILL');await child.done;}
    await fixture.cleanup();
  }
});
