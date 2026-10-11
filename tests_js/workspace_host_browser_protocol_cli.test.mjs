import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, snapshot, event } from './workspace_durable_claims_support.mjs';
const root = new URL('../', import.meta.url).pathname;

test('isolated installed command shares context/report broker and rejects scope, bounds and approval flags', {timeout:30000},async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const installed = join(fixture.root,'installed');
  await mkdir(join(installed,'apps'),{recursive:true});
  await cp(join(root,'runtime'),join(installed,'runtime'),{recursive:true});
  await cp(join(root,'apps','companion'),join(installed,'apps','companion'),{
    recursive:true,filter:path => !path.includes('node_modules') && !path.includes('/dist')});
  const state = await setup(fixture,'host-cli'); await state.claims.select('job',1n,true);
  const common = ['--root',state.root,'--native-lock',fixture.receipt.artifact];
  const command = join(installed,'apps','companion','command.mjs');
  const call = async (operation, extra = [], scoped = true) => {
    try {
      const result = await promisify(execFile)(process.execPath,[command,'workflow','attempt',operation,...scoped ? common : [],...extra],{env:{PATH:''},timeout:5000,cwd:fixture.root});
      assert.equal(result.stderr,''); return JSON.parse(result.stdout);
    } catch (error) { assert.equal(error.code,2); assert.equal(error.stderr,''); return JSON.parse(error.stdout); }
  };
  const child = spawn(process.execPath,[command,'workflow','attempt','serve',...common],{env:{PATH:''},stdio:['ignore','pipe','pipe']});
  const done = new Promise(resolve => child.once('exit',(code,signal) => resolve({code,signal})));
  t.after(async () => { if(child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; });
  let ready;
  for(let n=0;n<100;n++) { ready = await call('host-browser-context'); if(ready.ok) break; await delay(25); }
  assert.equal(ready?.ok,true); assert.equal(ready.result.hostBrowser.nextStep,'resolve_workflow');
  const file = join(fixture.root,'input.json');
  await writeFile(file,JSON.stringify(event('acquire')));
  assert.equal((await call('event',['--input',file,'--host-user-event'])).ok,true);
  const ctx = (await call('host-browser-context',['--job-id','job'])).result;
  assert.equal(ctx.hostBrowser.nextStep,'observe_and_act');
  const {kind,...input} = ctx.guidance.actions.find(action => action.kind === 'progress').input;
  const report = {...input,operationId:'installed-report',evidenceKind:'agent_attested',outcome:'progress'};
  await writeFile(file,JSON.stringify(report));
  const before = await snapshot(state.root);
  assert.equal((await call('host-browser-report',['--input',file,'--host-user-event'])).ok,false);
  assert.equal((await call('host-browser-report',['--input',file],false)).ok,false);
  assert.equal((await call('host-browser-report',['--input','input.json'])).ok,false);
  assert.deepEqual(await snapshot(state.root),before);
  const result = await call('host-browser-report',['--input',file]);
  assert.equal(result.ok,true); assert.equal(result.result.evidenceKind,'agent_attested');
  const saved = await snapshot(state.root);
  assert.equal((await call('host-browser-report',['--input',file])).result.replayed,true);
  assert.deepEqual(await snapshot(state.root),saved);
  await writeFile(file,' '.repeat(131073));
  assert.equal((await call('host-browser-report',['--input',file])).ok,false);
  assert.deepEqual(await snapshot(state.root),saved);
  await writeFile(join(state.root,'.native-jobs-fixture'),'invalid\n');
  assert.equal((await call('host-browser-context')).ok,false);
});
