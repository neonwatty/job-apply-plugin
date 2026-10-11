import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, extractAndStartRun, prepareJob, plain, read } from './workspace_combined_workflows_support.mjs';
import { ApplicationAuthorityService } from '../runtime/workspace-core/application-authority.js';
import { fromJSON } from '../runtime/contracts/workspace/values.js';

export async function processState(native, fixture, name) {
  const state = await setup(native, name);
  const jobs = await read(state.root, 'jobs.json');
  jobs.jobs.job.url = `${fixture.origin}/job`;
  jobs.jobs.job.normalizedUrl = `${fixture.origin}/job`;
  await writeFile(join(state.root, 'jobs.json'), JSON.stringify(jobs), { mode: 0o600 });
  await extractAndStartRun(state);
  await prepareJob(state);
  const authority = new ApplicationAuthorityService(state.repository, () => state.clock.now);
  state.authorization = plain(await authority.set(fromJSON({ mode: 'autofill_to_review',
    runId: state.run.runId, jobIds: ['job'], sensitiveAnswerRefs: [], durationMinutes: 60 }), 0n));
  return state;
}

export async function processHost(t, native, fixture, state, barrier = null) {
  const child = fork(fileURLToPath(new URL('./workspace_browser_process_child.mjs', import.meta.url)), [],
    { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: { PATH: '' } });
  const model = new Map(), privateCalls = new Map();
  const driver = fixture.driver();
  const pageCalls = [];
  let next = 0, errors = '';
  let arrive;
  const reached = new Promise(resolve => { arrive = resolve; });
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    const error = new Error(`host exited ${code}/${signal}: ${errors}`);
    readyReject(error);
    for (const pending of [...model.values(), ...privateCalls.values()]) pending.reject(error);
    model.clear(); privateCalls.clear();
    resolve({ code, signal });
  }));
  child.stderr.on('data', data => { errors += data; });
  child.on('error', readyReject);
  const send = message => { if (child.connected) child.send(message); };
  child.on('message', async message => {
    if (message.channel === 'initialized') { readyResolve(); return; }
    if (message.channel === 'approval' || message.channel === 'private-error') {
      const pending = privateCalls.get(message.id);
      if (!pending) { readyReject(new Error(message.error ?? 'unexpected private response')); return; }
      privateCalls.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve();
      return;
    }
    if (message.channel !== 'page') return;
    try {
      assert.ok(['observe', 'compareAndFill', 'readback'].includes(message.method));
      pageCalls.push(message.method);
      if (message.method === 'compareAndFill' && barrier === 'before-mutation') { arrive(); return; }
      const result = await driver[message.method](...message.args);
      if (message.method === 'compareAndFill' && barrier === 'after-mutation') { arrive(); return; }
      send({ channel: 'page-result', id: message.id, result });
    } catch {
      send({ channel: 'page-result', id: message.id, error: 'fixture_page_unavailable' });
    }
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line), pending = model.get(message.id);
    if (!pending) return;
    model.delete(message.id);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    return exited;
  };
  t.after(stop);
  send({ channel: 'initialize', root: state.root, artifact: native.receipt.artifact,
    origin: fixture.origin, now: state.clock.now });
  await ready;
  return {
    pid: child.pid, pageCalls, reached, stop,
    call(command, input) {
      const id = ++next;
      return new Promise((resolve, reject) => {
        model.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ id, proposal: { command, input } }) + '\n');
      });
    },
    approve(event) {
      const id = ++next;
      return new Promise((resolve, reject) => {
        privateCalls.set(id, { resolve, reject });
        send({ channel: 'approve', id, event });
      });
    },
  };
}
