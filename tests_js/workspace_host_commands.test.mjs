import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installedHost } from './workspace_host_support.mjs';
import { start, ask, reply, snapshot, read } from './workspace_durable_preparation_support.mjs';
import { event } from './workspace_durable_claims_support.mjs';
import { nativeAttemptPidName } from '../runtime/store/native-store-layout.js';

test('installed workflow route rejects invalid scope before default Store activation', { timeout: 60000 }, async t => {
  const host = await installedHost(t), { workflow, common, state, fixture } = host;
  const before = await snapshot(state.root);
  const alias = join(fixture.root, 'store-alias');
  await symlink(state.root, alias);
  const scopes = [[], ['--root', state.root], ['--native-lock', fixture.receipt.artifact],
    ['--root', 'relative-store', '--native-lock', fixture.receipt.artifact],
    ['--root', alias, '--native-lock', fixture.receipt.artifact],
    [...common, '--root', state.root]];
  for (const phase of ['prepare', 'attempt']) {
    for (const scope of scopes) assert.equal((await workflow(phase, 'context', undefined, [], scope)).ok, false);
    assert.equal((await workflow(phase, 'context', undefined, ['--host-user-event'])).ok, false);
    assert.equal((await workflow(phase, 'init')).ok, false);
  }
  assert.deepEqual(await host.invoke(['workflow', 'unknown']), { ok: false, error: 'invalid_invocation' });
  assert.equal((await workflow('prepare', 'route', 'PRIVATE invalid json')).ok, false);
  assert.equal((await workflow('prepare', 'route', ' '.repeat(131073))).ok, false);
  assert.deepEqual(await snapshot(state.root), before);
  assert.deepEqual(await readdir(host.home), []);
  await writeFile(join(state.root, '.native-jobs-fixture'), 'unrecognized\n', { mode: 0o600 });
  for (const phase of ['prepare', 'attempt']) assert.equal((await workflow(phase, 'context')).ok, false);
  assert.deepEqual(await readdir(host.home), []);
});

test('installed host resumes the same pending question and consumes a scoped reply once', { timeout: 60000 }, async t => {
  const { workflow, state, home, invoke, common } = await installedHost(t);
  assert.deepEqual((await workflow('prepare', 'context')).result, { task: null, context: null });
  const started = await workflow('prepare', 'route', start());
  const context = await workflow('prepare', 'context');
  assert.equal(context.result.context.allowedActions[0].id, 'application.confirm_selection');
  const question = ask(started.result.receipt.task);
  const waiting = await workflow('prepare', 'action', question);
  const task = waiting.result.receipt.task, proposal = reply(task).proposal;
  const saved = await snapshot(state.root);
  const resumed = await workflow('prepare', 'context');
  assert.deepEqual(resumed.result.task.pending, task.pending);
  assert.deepEqual(resumed.result.context.allowedActions, []);
  assert.equal((await workflow('prepare', 'action', question)).result.replayed, true);
  assert.deepEqual(await snapshot(state.root), saved);
  assert.equal((await workflow('prepare', 'reply', proposal)).error, 'user_event_required');
  const stale = { ...proposal, expectedRevision: '999' };
  assert.equal((await workflow('prepare', 'reply', stale, ['--host-user-event'])).ok, false);
  assert.deepEqual(await snapshot(state.root), saved);
  const ready = await workflow('prepare', 'reply', proposal, ['--host-user-event']);
  assert.equal(ready.result.receipt.outcome, 'job_ready');
  const committed = await snapshot(state.root);
  assert.equal((await workflow('prepare', 'reply', proposal, ['--host-user-event'])).result.replayed, true);
  assert.deepEqual(await snapshot(state.root), committed);
  assert.equal((await read(state.root, 'jobs.json')).jobs.job.status, 'ready');
  const canonical = await invoke(['task', ...common, 'snapshot']);
  assert.equal(canonical.ok, true);
  assert.equal(canonical.snapshot.jobs.find(job => job.id === 'job').status, 'ready');
  assert.equal(String(canonical.snapshot.jobs.find(job => job.id === 'job').revision), ready.result.receipt.task.subject.jobRevision);
  assert.deepEqual((await workflow('prepare', 'context')).result, { task: null, context: null });
  assert.deepEqual(await readdir(home), []);
});

test('installed attempt command owns broker signals, rejects unattested events and preserves canonical cancellation', { timeout: 60000 }, async t => {
  const { workflow, state, serve, invoke, common } = await installedHost(t);
  await state.claims.select('job', 1n, true);
  const broker = await serve();
  assert.equal((await readFile(join(state.root, nativeAttemptPidName), 'utf8')).trim(), String(broker.child.pid));
  const acquire = event('acquire'), before = await snapshot(state.root);
  assert.deepEqual(await workflow('attempt', 'event', acquire), { ok: false, error: 'request_rejected' });
  assert.deepEqual(await snapshot(state.root), before);
  const acquired = await workflow('attempt', 'event', acquire, ['--host-user-event']);
  assert.equal(acquired.result.receipt.outcome, 'claim_acquired');
  assert.equal((await workflow('attempt', 'context')).result.brokerAvailable, true);
  assert.equal((await workflow('attempt', 'event', acquire, ['--host-user-event'])).result.replayed, true);
  const task = acquired.result.receipt.task;
  const progressed = await workflow('attempt', 'event', event('progress', task));
  assert.equal(progressed.result.receipt.outcome, 'progress_saved');
  const cancel = event('cancel', progressed.result.receipt.task);
  const cancelled = await workflow('attempt', 'event', cancel, ['--host-user-event']);
  assert.equal(cancelled.result.receipt.outcome, 'cancelled');
  const saved = await snapshot(state.root);
  assert.equal((await workflow('attempt', 'event', cancel, ['--host-user-event'])).result.replayed, true);
  assert.deepEqual(await snapshot(state.root), saved);
  assert.equal((await read(state.root, 'jobs.json')).jobs.job.status, 'needs_info');
  assert.equal((await read(state.root, 'coordinator.json')).claim, null);
  assert.deepEqual((await workflow('attempt', 'context')).result, { task: null, brokerAvailable: false });
  const canonical = await invoke(['task', ...common, 'snapshot']);
  assert.equal(canonical.snapshot.jobs.find(job => job.id === 'job').status, 'needs_info');
  assert.equal(String(canonical.snapshot.jobs.find(job => job.id === 'job').revision), cancelled.result.receipt.task.subject.jobRevision);
  assert.equal(canonical.snapshot.attention.items.find(item => item.jobId === 'job').reasonCode, 'needs_information');
  broker.child.kill('SIGTERM');
  assert.deepEqual(await broker.done, { code: 0, signal: null, stdout: '{"ok":true,"result":null}\n', stderr: '' });
  await assert.rejects(readFile(join(state.root, nativeAttemptPidName)), { code: 'ENOENT' });
  assert.equal((await workflow('attempt', 'context')).ok, false);
});

test('installed exact selection needs one context and mutation and survives a fresh command retry', {timeout:60000},async t=>{
  const {workflow,state,home}=await installedHost(t);
  const before=await snapshot(state.root);
  const context=await workflow('prepare','context',undefined,['--job-id','job']);
  assert.equal(context.ok,true);
  assert.deepEqual(context.result.selection.allowedActions,['select']);
  const {jobId,jobRevision,inputRevision}=context.result.selection;
  const input={operationId:'explicit-choice',jobId,jobRevision,inputRevision};
  assert.equal((await workflow('prepare','select',input,['--host-user-event'])).ok,false);
  assert.equal((await workflow('prepare','select',{...input,state:'finished'})).ok,false);
  assert.equal((await workflow('prepare','select',input,['--job-id','job'])).ok,false);
  assert.deepEqual(await snapshot(state.root),before);
  const result=await workflow('prepare','select',input);
  assert.equal(result.result.receipt.outcome,'job_ready');
  assert.equal(result.result.receipt.task.pending,null);
  assert.equal(result.result.receipt.task.revision,'1');
  const saved=await snapshot(state.root);
  assert.equal((await workflow('prepare','select',input)).result.replayed,true);
  assert.deepEqual(await snapshot(state.root),saved);
  const readyContext=(await workflow('prepare','context',undefined,['--job-id','job'])).result.selection;
  assert.equal(readyContext.ready,true);
  assert.deepEqual(readyContext.allowedActions,[]);
  const repeated={operationId:'second-confirmation',jobId,jobRevision:readyContext.jobRevision,inputRevision:readyContext.inputRevision};
  assert.equal((await workflow('prepare','select',repeated)).error,'action_unavailable');
  assert.deepEqual(await snapshot(state.root),saved);
  assert.deepEqual(await readdir(home),[]);
});
