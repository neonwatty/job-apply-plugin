import assert from 'node:assert/strict';
import test from 'node:test';
import { stat, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, plain, read, readyPacket } from './workspace_native_claims_support.mjs';
import { installAttempt, nativeCli, killAttempt, eventually, rawAttempt } from './native_attempt_support.mjs';
import { attemptSocketPath } from '../runtime/cli/attempt-protocol.js';
import { requestAttempt, runAttemptBroker } from '../runtime/cli/attempt-broker.js';
import { fromJSON } from '../runtime/contracts/workspace/values.js';
const start=['start','--id','job','--owner','owner','--expected-revision','2'];
const rejected={ok:false,error:{code:'request_rejected'}};

test('installed detached broker supports independent clients and review restart without Python', {timeout:60000},async()=>{
  const fixture=await nativeFixture(); let root;
  try {
    const executable=await installAttempt(fixture),state=await setup(fixture,'store'); root=state.root;
    await state.claims.select('job',1n,true);
    const call=args=>nativeCli(executable,root,args);
    const acquired=await call(start); assert.equal(acquired.exitCode,0);assert.equal(acquired.value.event,'acquired');
    assert.equal(acquired.stdout.trim().split('\n').length,1); assert.equal(acquired.stderr,'');
    assert.doesNotMatch(acquired.stdout,/token|claim|PRIVATE-/);
    const socket=attemptSocketPath(root,process.getuid());
    assert.equal((await stat(socket)).mode&0o777,0o600);assert.equal((await stat(dirname(socket))).mode&0o777,0o700);
    const pid=await readFile(join(root,'.job-apply-attempt.pid'),'utf8');assert.match(pid,/^\d+\n$/);
    assert.equal((await call(['heartbeat'])).value.event,'heartbeat');
    for(const bytes of [Buffer.from('{}\n{}'),Buffer.from('[]\n'),Buffer.from('{'),Buffer.from([0xff,10]),Buffer.alloc(1024*1024+1,32)]) {
      assert.deepEqual(await rawAttempt(root,bytes),rejected);
      assert.equal((await call(['heartbeat'])).value.event,'heartbeat');
    }
    assert.deepEqual(plain(await requestAttempt(root,fromJSON({command:'progress',id:'other',session:{}}))),rejected);
    const input=join(fixture.root,'input.json');
    await writeFile(input,JSON.stringify({status:'active',pendingFields:[{question:'PRIVATE QUESTION',state:'missing'}]}));
    assert.equal((await call(['progress','--input',input])).value.event,'progress_saved');
    await writeFile(input,JSON.stringify({status:'review',pendingFields:[],readinessInput:readyPacket(3)}));
    assert.equal((await call(['handoff','--status','awaiting_review','--input',input])).value.event,'handed_off');
    await eventually(async()=>!(await stat(socket).catch(()=>null)));
    assert.equal((await read(root,'jobs.json')).jobs.job.status,'awaiting_review');
    const restart=['restart-review','--id','job','--owner','second','--expected-revision','4'];
    assert.deepEqual((await call(restart)).value,rejected);
    await eventually(async()=>!(await stat(socket).catch(()=>null)));
    assert.equal((await call([...restart,'--owner-confirmed-not-submitted'])).value.attempt.job.revision,5);
    assert.equal((await call(['heartbeat'])).value.event,'heartbeat');
    await writeFile(input,'{"status":"active"}');
    assert.equal((await call(['handoff','--status','needs_info','--input',input])).value.status,'needs_info');
    assert.equal(plain(await state.claims.status()).claim,null);
  } finally {if(root) await killAttempt(root);await fixture.cleanup();}
});
test('concurrent launchers have one winner and process loss retains the exact claim through stale socket cleanup',{timeout:60000},async()=>{
  const fixture=await nativeFixture();let root;
  try {
    const executable=await installAttempt(fixture),state=await setup(fixture,'race');root=state.root;
    await state.claims.select('job',1n,true);
    const results=await Promise.all([nativeCli(executable,root,start),nativeCli(executable,root,start)]);
    assert.equal(results.filter(result=>result.value.ok).length,1);
    const before=await read(root,'coordinator.json');await killAttempt(root);
    await new Promise(resolve=>setTimeout(resolve,100));
    const failed=await nativeCli(executable,root,start);assert.equal(failed.exitCode,2);
    assert.deepEqual(await read(root,'coordinator.json'),before);
    assert.doesNotMatch(failed.stdout,/job|token|claim|PRIVATE/);
  } finally {if(root)await killAttempt(root);await fixture.cleanup();}
});
test('unacquired broker idles out and scheduled heartbeat failure shuts it down without releasing claim',{timeout:60000},async()=>{
  const fixture=await nativeFixture();let root;
  try {
    const state=await setup(fixture,'idle');root=state.root;
    await runAttemptBroker(root,state.claims,state.provider,{idleMilliseconds:30});
    assert.equal(await stat(attemptSocketPath(root,process.getuid())).catch(()=>null),null);
    await state.claims.select('job',1n,true);
    const running=runAttemptBroker(root,state.claims,state.provider,{heartbeatMilliseconds:30});
    await eventually(async()=>!!(await stat(attemptSocketPath(root,process.getuid())).catch(()=>null)));
    assert.equal(plain(await requestAttempt(root,fromJSON({command:'start',id:'job',owner:'owner',expectedRevision:2}))).ok,true);
    const before=await read(root,'coordinator.json'); state.clock.now='2026-09-10T12:10:00Z';
    await running;assert.deepEqual(await read(root,'coordinator.json'),before);
  } finally {if(root)await killAttempt(root);await fixture.cleanup();}
});

test('newline transport accepts clients without EOF and rejects malformed live frames', {timeout:30000},async()=>{
  const {createConnection}=await import('node:net');
  const fixture=await nativeFixture();let running;
  try {
    const state=await setup(fixture,'frames');
    const socketPath=attemptSocketPath(state.root,process.getuid());
    running=runAttemptBroker(state.root,state.claims,state.provider,{idleMilliseconds:5000});
    await eventually(async()=>!!(await stat(socketPath).catch(()=>null)));
    // A rejected acquisition exercises framing without needing a valid Store mutation.
    const result=await new Promise((resolve,reject)=>{
      const socket=createConnection(socketPath);let output='';
      socket.on('connect',()=>socket.write('{"command":"heartbeat"}\n'));
      socket.on('data',bytes=>{output+=bytes;});
      socket.on('end',()=>{socket.destroy();resolve(output);});
      socket.on('error',reject);
      socket.setTimeout(1500,()=>{socket.destroy();reject(Error('newline client received no response'));});
    });
    assert.deepEqual(JSON.parse(result),rejected);
    await running;
  } finally {if(running){process.emit('SIGTERM');await running;}await fixture.cleanup();}
});

test('optional Store PID accepts stale positive PID and rejects unsafe metadata',async()=>{
  const {chmod,unlink,symlink,link,mkdir}=await import('node:fs/promises');
  const fixture=await nativeFixture();
  try {
    const state=await setup(fixture,'pid');const path=join(state.root,'.job-apply-attempt.pid');
    await writeFile(path,'999999999\n',{mode:0o600});
    assert.equal(plain(await state.claims.status()).claim,null);
    for(const value of ['0\n','-1\n','1','1\n\n','1\nextra','١\n','9'.repeat(100)+'\n']) {
      await writeFile(path,value);await assert.rejects(state.claims.status());
    }
    await writeFile(path,'123\n');await chmod(path,0o644);await assert.rejects(state.claims.status());
    await chmod(path,0o600);const target=join(fixture.root,'target');await writeFile(target,'123\n',{mode:0o600});
    await unlink(path);await symlink(target,path);await assert.rejects(state.claims.status());
    await unlink(path);await link(target,path);await assert.rejects(state.claims.status());
    await unlink(path);await mkdir(path);await assert.rejects(state.claims.status());
  } finally {await fixture.cleanup();}
});

test('killing the launcher process group leaves its detached broker usable',{timeout:30000},async()=>{
  const {spawn}=await import('node:child_process');
  const fixture=await nativeFixture();let root,launcher;
  try {
    const state=await setup(fixture,'group');root=state.root;await state.claims.select('job',1n,true);
    const executable=await installAttempt(fixture);
    launcher=spawn('/bin/sh',['-c','"$@"; /bin/sleep 30','attempt-launcher',process.execPath,executable,'--root',root,...start],{detached:true,env:{...process.env,PATH:''},stdio:['ignore','pipe','pipe']});
    const closed=new Promise(resolve=>launcher.once('close',resolve));
    const output=await new Promise((resolve,reject)=>{
      let output='';launcher.stdout.on('data',bytes=>{output+=bytes;if(output.includes('\n'))resolve(output);});
      launcher.once('error',reject);launcher.once('exit',()=>reject(Error('launcher exited before acquisition')));
    });
    assert.equal(JSON.parse(output).event,'acquired');
    process.kill(-launcher.pid,'SIGKILL');await closed;launcher=null;
    assert.equal((await nativeCli(executable,root,['heartbeat'])).value.event,'heartbeat');
  } finally {if(launcher)process.kill(-launcher.pid,'SIGKILL');if(root)await killAttempt(root);await fixture.cleanup();}
});

test('failed PID bootstrap releases endpoint ownership and preserves foreign metadata',async()=>{
  const {mkdir,rmdir}=await import('node:fs/promises');
  const fixture=await nativeFixture();
  try {
    const state=await setup(fixture,'bad-pid'),path=join(state.root,'.job-apply-attempt.pid');
    await mkdir(path);
    await assert.rejects(runAttemptBroker(state.root,state.claims,state.provider,{idleMilliseconds:20}));
    assert.equal((await stat(path)).isDirectory(),true);await rmdir(path);
    await runAttemptBroker(state.root,state.claims,state.provider,{idleMilliseconds:20});
  } finally {await fixture.cleanup();}
});
