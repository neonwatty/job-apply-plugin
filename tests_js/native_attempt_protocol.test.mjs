import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { inspect } from 'node:util';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, plain, read } from './workspace_native_claims_support.mjs';
import { parseAttemptArgs, resolveAttemptRoot, attemptSocketPath, encodeAttemptFrame, AttemptFrameDecoder, AttemptHelp, attemptError } from '../runtime/cli/attempt-protocol.js';
import { fromJSON, get, int, serialize } from '../runtime/contracts/workspace/values.js';
import { python, oracleImport } from './native_attempt_support.mjs';

test('argument parsing matches Python commands, duplicates, abbreviations and exact revisions', async()=>{
  const commands = [
    ['start','--id','job','--owner','owner','--expected-revision','+١_٢'],
    ['restart-review','--id','job','--owner','owner','--expected-revision','9007199254740993','--owner-confirmed-not-submitted'],
    ['restart-review','--id','job','--owner','owner','--expected-revision','-2'],
    ['heartbeat'], ['progress','--input','one','--input','two'],
    ['handoff','--status','needs_info','--input','one'],
    ['start','--id=a','--owner=b','--expected-r=+2'],
  ];
  for (const args of commands) {
    const oracle=await python(args,oracleImport+`a=m.build_parser().parse_args(sys.argv[1:]); d=vars(a); d.update(expected_revision=str(d['expected_revision'])) if 'expected_revision' in d else None; print(json.dumps(d))`);
    assert.equal(oracle.exitCode,0,oracle.stderr);
    const expected=JSON.parse(oracle.stdout), actual=parseAttemptArgs(args,{},'/tmp/home');
    assert.equal(actual.kind,expected.command);
    if ('expectedRevision' in actual) assert.equal(actual.expectedRevision,BigInt(expected.expected_revision));
    if ('input' in actual) assert.equal(actual.input,expected.input);
    if ('ownerConfirmedNotSubmitted' in actual) assert.equal(actual.ownerConfirmedNotSubmitted,expected.owner_confirmed_not_submitted);
  }
  for (const args of [[],['stop'],['heartbeat','--id','x'],['handoff','--status','submitted','--input','x'],['start','--id','x','--owner','x','--expected-revision','1.2'],['--native-lock','x','heartbeat']]) {
    assert.throws(()=>parseAttemptArgs(args,{},'/tmp/home'));
    const oracle=await python(args); assert.equal(oracle.exitCode,2);
    assert.deepEqual(JSON.parse(oracle.stdout),JSON.parse(serialize(attemptError('invalid_invocation'))));
    assert.equal(oracle.stderr,'');
  }
  for (const args of [['--help'],['start','--help']]) {
    assert.throws(()=>parseAttemptArgs(args,{},'/tmp/home'),AttemptHelp);
    assert.equal((await python(args)).exitCode,0);
  }
});
test('root precedence and socket hashes match the Python filesystem scope', async()=>{
  assert.equal(resolveAttemptRoot(undefined,{},'/tmp/home'),join(realpathSync('/tmp'),'home/.job-apply'));
  assert.equal(resolveAttemptRoot(undefined,{JOB_APPLY_STORE_DIR:'~/env'},'/tmp/home'),join(realpathSync('/tmp'),'home/env'));
  assert.equal(resolveAttemptRoot('~/explicit',{JOB_APPLY_STORE_DIR:'/other'},'/tmp/home'),join(realpathSync('/tmp'),'home/explicit'));
  const root=resolveAttemptRoot('./日本語 store',{},'/tmp/home');
  const oracle=await python([root],oracleImport+`print(m.socket_path(Path(sys.argv[1])))`);
  assert.equal(attemptSocketPath(root,process.getuid()),oracle.stdout.trim());
  assert.equal(parseAttemptArgs(['--root','/one','--root','/two','heartbeat'],{},'/tmp/home').root,'/two');
});
test('newline frames retain exact numbers, reject trailing bytes, oversized and invalid UTF-8 input',()=>{
  const source=Buffer.from('{"revision":9007199254740993}\n');
  const decoder=new AttemptFrameDecoder(); assert.equal(decoder.push(source.subarray(0,8)),null);
  assert.equal(int(get(decoder.push(source.subarray(8)),'revision')),9007199254740993n);
  assert.throws(()=>decoder.push(Buffer.from('x')));
  for (const bytes of [Buffer.from('{}\n{}'),Buffer.from('[]\n'),Buffer.from('\n'),Buffer.from([0xff,10]),Buffer.alloc(1024*1024+1,32)]) assert.throws(()=>new AttemptFrameDecoder().push(bytes));
  assert.equal(encodeAttemptFrame(fromJSON({ok:true})).toString(),'{"ok":true}\n');
  assert.throws(()=>encodeAttemptFrame(fromJSON({x:'x'.repeat(1024*1024)})));
});

test('authority keeps bearer private, survives rejections, and hands off at the acquired revision',async()=>{
  const {AttemptAuthority}=await import('../runtime/cli/attempt-authority.js');
  const fixture=await nativeFixture();
  const timers={callback:null,cancelled:false,every(callback){this.callback=callback;return 1;},cancel(){this.cancelled=true;}};
  try {
    const state=await setup(fixture,'authority'); await state.claims.select('job',1n,true);
    const authority=new AttemptAuthority(state.claims,{timers});
    const result=plain(await authority.acquire(fromJSON({command:'start',id:'job',owner:'owner',expectedRevision:2})));
    assert.deepEqual(Object.keys(result.attempt).sort(),['job','resume']);
    assert.deepEqual(Object.keys(result.attempt.job).sort(),['id','revision','url']);
    assert.equal(result.attempt.job.revision,3);
    assert.doesNotMatch(JSON.stringify(result)+inspect(authority,{showHidden:true}),/token|PRIVATE-|owner/);
    assert.ok(timers.callback);
    state.clock.now='2026-09-10T12:01:00Z';await timers.callback();
    assert.equal(plain(await state.claims.status()).claim.heartbeatAt,state.clock.now);
    await assert.rejects(authority.dispatch(fromJSON({command:'progress',id:'other',session:{}})));
    assert.deepEqual(plain((await authority.dispatch(fromJSON({command:'heartbeat'}))).response),{ok:true,event:'heartbeat'});
    const done=await authority.dispatch(fromJSON({command:'handoff',status:'needs_info',session:{status:'active',pendingFields:[{question:'PRIVATE QUESTION',state:'missing'}]}}));
    assert.equal(done.complete,true); assert.equal(plain(done.response).event,'handed_off');
    assert.equal((await read(state.root,'jobs.json')).jobs.job.revision,4);
    assert.equal(plain(await state.claims.status()).claim,null);
    assert.equal(timers.cancelled,true);
    await authority.close();
  } finally {await fixture.cleanup();}
});
test('authority close and failed scheduled heartbeat retain Store claim',async()=>{
  const {AttemptAuthority}=await import('../runtime/cli/attempt-authority.js');
  const fixture=await nativeFixture();
  let tick,failed=false;
  try {
    const state=await setup(fixture,'close'); await state.claims.select('job',1n,true);
    const authority=new AttemptAuthority(state.claims,{timers:{every(callback){tick=callback;return 1;},cancel(){}},onHeartbeatFailure(){failed=true;}});
    await authority.acquire(fromJSON({command:'start',id:'job',owner:'owner',expectedRevision:2}));
    const before=await read(state.root,'coordinator.json');
    state.clock.now='2026-09-10T12:10:00Z'; await tick();
    assert.equal(failed,true);
    await assert.rejects(authority.dispatch(fromJSON({command:'heartbeat'})));
    await authority.close(); assert.deepEqual(await read(state.root,'coordinator.json'),before);
  } finally {await fixture.cleanup();}
});

test('input documents preserve large revisions and match Python invalid input envelopes',async()=>{
  const {attemptRequest}=await import('../runtime/cli/attempt-protocol.js');
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
  const root=await mkdtemp('/tmp/attempt-input-');
  try {
    const input=join(root,'input.json');
    await writeFile(input,'{"attemptRevision":9007199254740993}');
    assert.equal(int(get(get(await attemptRequest({kind:'progress',root,input}),'session'),'attemptRevision')),9007199254740993n);
    for(const bytes of [Buffer.from('[]'),Buffer.from('{'),Buffer.from('{}{}'),Buffer.from([0xff])]) {
      await writeFile(input,bytes);
      await assert.rejects(attemptRequest({kind:'progress',root,input}));
      const oracle=await python(['--root',root,'progress','--input',input]);
      assert.deepEqual(JSON.parse(oracle.stdout),{ok:false,error:{code:'attempt_unavailable'}});
    }
  } finally {await rm(root,{recursive:true,force:true});}
});
test('root resolution follows symlinks before parent traversal, as Python does',async()=>{
  const {mkdtemp,mkdir,symlink,rm}=await import('node:fs/promises');
  const root=await mkdtemp('/tmp/attempt-root-');
  try {
    await mkdir(join(root,'target/deep'),{recursive:true});
    await symlink(join(root,'target/deep'),join(root,'link'));
    const raw=root+'/link/../store';
    const oracle=await python([raw],oracleImport+`print(m.resolve_root(sys.argv[1]))`);
    assert.equal(resolveAttemptRoot(raw,{},'/tmp/home'),oracle.stdout.trim());
  } finally {await rm(root,{recursive:true,force:true});}
});

test('each duplicate scalar value is validated before a later valid value can replace it',async()=>{
  const cases=[
    ['handoff','--status','invalid','--status','needs_info','--input','session.json'],
    ['handoff','--status=invalid','--status=awaiting_review','--input=session.json'],
    ['handoff','--stat=invalid','--stat=needs_info','--input=session.json'],
    ['start','--id','job','--owner','owner','--expected-revision','bad','--expected-revision','2'],
  ];
  for(const args of cases) {
    const oracle=await python(args);
    assert.equal(oracle.exitCode,2);
    assert.deepEqual(JSON.parse(oracle.stdout),{ok:false,error:{code:'invalid_invocation'}});
    assert.throws(()=>parseAttemptArgs(args,{},'/tmp/home'),undefined,JSON.stringify(args));
  }
  const valid=['handoff','--status','awaiting_review','--status','needs_info','--input','session.json'];
  const reference=await python(valid,oracleImport+`print(json.dumps(vars(m.build_parser().parse_args(sys.argv[1:]))))`);
  assert.equal(reference.exitCode,0);
  assert.equal(parseAttemptArgs(valid,{},'/tmp/home').status,JSON.parse(reference.stdout).status);
});
