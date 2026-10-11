import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHostBrowserFixture } from '../evals/workflows/host-browser-fixture.mjs';

async function setup(t, scenario = 'controls-handoff') {
  const parent = await mkdtemp(join(tmpdir(), 'host-recovery-'));
  const fixture = await createHostBrowserFixture({ outputDirectory: join(parent, 'trial'), scenario });
  t.after(async () => { await fixture.close(); await rm(parent, { recursive: true, force: true }); });
  const post = async (route, payload, authenticated = true) => {
    const response = await fetch(fixture.url + route, { method: 'POST', headers: {
      'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${fixture.manifest.token}` } : {}),
    }, body: JSON.stringify(payload) });
    return { status: response.status, value: await response.json() };
  };
  return { fixture, post, parent };
}

test('owned broker injection rejects malformed or unauthenticated requests without mutations', async t => {
  const { fixture, post } = await setup(t);
  const before = await fixture.inspect();
  assert.equal((await post('inject', { kind: 'broker-restart', signal: 'SIGKILL' }, false)).status, 403);
  for (const payload of [null, {}, { kind: 'broker-restart', signal: 'SIGINT' }, { kind: 'broker-restart', signal: 'SIGKILL', pid: process.pid }]) {
    assert.equal((await post('inject', payload)).status, 400);
  }
  assert.deepEqual(await fixture.inspect(), before);
});

for (const signal of ['SIGKILL', 'SIGTERM']) test(`real ${signal} replacement preserves durable Store and drafts, exposes recovery wait and cleans replacement`, async t => {
  const { fixture, post, parent } = await setup(t, 'broker-restart');
  // Synthetic observer traffic tests fixture behavior; it is not browser evidence.
  for (const [field, value] of Object.entries(expectedValues)) await post('events', { kind: 'input', field, value });
  const context = (await post('command', { command: 'context', kind: 'canonical' })).value;
  const input = join(parent, 'acquire.json');
  await writeFile(input, JSON.stringify({ ...context.guidance.actions.find(action => action.kind === 'acquire').input, operationId: 'recovery-acquire' }));
  const installed = fixture.manifest.installed;
  await promisify(execFile)(installed.node, [installed.launcher, 'workflow', 'attempt', 'event', '--root', installed.root,
    '--native-lock', installed.nativeLock, '--host-user-event', '--input', input], { cwd: installed.plugin, env: { PATH: '', HOME: join(installed.plugin, '../home') } });
  const liveContext = (await post('command', { command: 'host-browser-context', kind: 'canonical' })).value;
  const { kind, ...reportInput } = liveContext.guidance.actions.find(action => action.kind === 'progress').input;
  const staleReport = { ...reportInput, operationId: 'lost-owner-report', evidenceKind: 'agent_attested', outcome: 'progress' };
  const response = await post('inject', { kind: 'broker-restart', signal });
  assert.equal(response.status, 200);
  const receipt = response.value;
  assert.equal(receipt.status, 'completed');
  assert.notEqual(receipt.oldPid, receipt.newPid);
  assert.throws(() => process.kill(receipt.oldPid, 0), { code: 'ESRCH' });
  assert.deepEqual(receipt.beforePage, receipt.afterPage);
  assert.deepEqual(receipt.beforeCanonical, receipt.afterCanonical);
  assert.equal(receipt.beforeDurableDigest, receipt.afterDurableDigest);
  assert.equal(receipt.startupContext.brokerAvailable, false);
  assert.ok(!receipt.startupContext.guidance.actions.some(action => action.kind === 'acquire'));
  assert.equal(receipt.afterCanonical.claimActive, true);
  await post('command', { command: 'host-browser-context', kind: 'canonical' });
  assert.equal((await post('checkpoint', { kind: 'recovery-observation', lossSequence: receipt.sequence,
    evidence: { source: 'native_host_browser', url: fixture.url, title: 'Fictional host browser acceptance', values: receipt.afterPage.values } })).status, 200);
  const rejected = await post('command', { command: 'host-browser-report', kind: 'stale-rejection', payload: staleReport });
  assert.equal(rejected.value.ok, false);
  assert.equal(rejected.value.error, 'request_rejected');
  const graded = await fixture.grade();
  assert.equal(graded.recoveryOutcome, 'blocked_safely');
  assert.equal(graded.passed, true, JSON.stringify(graded));
  assert.ok(Object.values(graded.recoveryChecks).every(Boolean), JSON.stringify(graded.recoveryChecks));
  await fixture.close();
  assert.throws(() => process.kill(receipt.newPid, 0), { code: 'ESRCH' });
  assert.equal(JSON.parse(await readFile(join(parent, 'trial/shutdown.json'), 'utf8')).brokerPid, receipt.newPid);
  assert.equal(JSON.parse(await readFile(join(parent, 'trial/observer.json'), 'utf8')).receipts.find(value => value.kind === 'broker-restart').status, 'completed');
});

test('browser loss requires fresh context and matching native observation before accepting reports', async t => {
  const { fixture, post } = await setup(t);
  const loss = await post('checkpoint', { kind: 'tab-closed' });
  assert.equal(loss.status, 200);
  const report = { command: 'host-browser-report', kind: 'replay', payload: {} };
  assert.equal((await post('command', report)).value.error, 'recovery_observation_required');
  const observation = { kind: 'recovery-observation', lossSequence: loss.value.sequence,
    evidence: { source: 'native_host_browser', url: fixture.url, title: 'Fictional host browser acceptance', values: (await fixture.inspect()).page.values } };
  assert.equal((await post('checkpoint', observation)).value.error, 'fresh_context_required');
  await post('events', { kind: 'page-load' });
  await post('command', { command: 'host-browser-context', kind: 'canonical' });
  assert.equal((await post('checkpoint', { ...observation, evidence: { ...observation.evidence, values: {} } })).status, 400);
  assert.equal((await post('checkpoint', observation)).status, 200);
  // Passing recovery gate still requires a valid production report.
  assert.notEqual((await post('command', report)).value.error, 'recovery_observation_required');
  const second = await post('checkpoint', { kind: 'browser-tool-reconnect' });
  assert.equal(second.status, 200);
  assert.equal((await post('checkpoint', observation)).status, 400);
  assert.equal((await post('command', report)).value.error, 'recovery_observation_required');
  assert.equal((await fixture.inspect()).page.submitAttempts, 0);
});

test('reload resets observed values while preserving cumulative events and unrelated notes', async t => {
  const { fixture, post } = await setup(t);
  await post('events', { kind: 'page-load' });
  const initial = (await fixture.inspect()).page;
  await post('events', { kind: 'input', field: 'name', value: 'Fictional Candidate' });
  await post('events', { kind: 'change', field: 'remote', value: true });
  await post('events', { kind: 'page-load' });
  const page = (await fixture.inspect()).page;
  assert.deepEqual(page.values, initial.values);
  assert.equal(page.inputCounts.name, 1);
  assert.equal(page.changeCounts.remote, 1);
  assert.equal(page.events.length, 4);
  assert.equal(page.submitAttempts, 0);
});

test('failed replacement keeps failure evidence and cleans attempted replacement child', async t => {
  const { fixture, post, parent } = await setup(t);
  await writeFile(fixture.manifest.installed.launcher, "throw Error('fixture replacement unavailable');\n");
  const response = await post('inject', { kind: 'broker-restart', signal: 'SIGTERM' });
  assert.equal(response.status, 500);
  assert.equal(response.value.status, 'failed');
  assert.match(response.value.error, /fixture replacement unavailable/);
  assert.equal(response.value.beforeDurableDigest, response.value.afterDurableDigest);
  await fixture.close();
  const persisted = JSON.parse(await readFile(join(parent, 'trial/observer.json'), 'utf8'));
  assert.equal(persisted.receipts.at(-1).status, 'failed');
  const shutdown = JSON.parse(await readFile(join(parent, 'trial/shutdown.json'), 'utf8'));
  assert.throws(() => process.kill(shutdown.brokerPid, 0), { code: 'ESRCH' });
});

import { gradeHostBrowserRecovery, reportNeedsObservation } from '../evals/workflows/host-browser-recovery.mjs';
import { initialValues, expectedValues } from '../evals/workflows/host-browser-page.mjs';
test('recovery grader rejects invented observation, failed restart and reports before observation', () => {
  const canonical = { job: { status: 'needs_info' }, otherJob: {}, claimActive: false, immutableDigest: 'same' };
  const page = { values: { ...initialValues, ...expectedValues }, events: Object.keys(expectedValues).map(field => ({ field })), submitAttempts: 0, rejectedEvents: 0 };
  const loss = { kind: 'browser-tool-reconnect', sequence: 1, page, canonical };
  const context = { command: 'host-browser-context', result: { hostBrowser: {} } };
  const observation = { kind: 'recovery-observation', sequence: 3, lossSequence: 1, evidenceKind: 'agent_attested', page, canonical,
    evidence: { source: 'native_host_browser', values: page.values, title: 'Fictional host browser acceptance', url: 'http://127.0.0.1:1234/' } };
  const report = { kind: 'report', command: 'host-browser-report', result: { receipt: {}, evidenceKind: 'agent_attested' } };
  const grade = receipts => gradeHostBrowserRecovery({ canonical }, { canonical, page, receipts }, 'browser-tool-reconnect');
  assert.equal(grade([loss, context, observation, report]).passed, true);
  assert.equal(grade([loss, context, { ...observation, evidence: { ...observation.evidence, values: {} } }, report]).passed, false);
  assert.equal(grade([loss, report, context, observation]).passed, false);
  assert.equal(grade([loss, context, observation, { ...loss, sequence: 4 }, report]).passed, false);
  assert.equal(gradeHostBrowserRecovery({ canonical }, { canonical, page, receipts: [
    { ...loss, kind: 'broker-restart', status: 'failed', oldPid: 1, newPid: 2 }, context, observation, report,
  ] }, 'broker-restart').passed, false);
});

test('recovery report replay bypass requires an exact successful prior payload', () => {
  const payload = { operationId: 'accepted', outcome: 'progress' };
  const original = { command: 'host-browser-report', payload, result: { receipt: {}, evidenceKind: 'agent_attested' } };
  const loss = { kind: 'tab-closed', sequence: 2 };
  const replay = { command: 'host-browser-report', kind: 'replay', payload };
  assert.equal(reportNeedsObservation(replay, [original, loss], {}), false);
  assert.equal(reportNeedsObservation({ ...replay, payload: { ...payload, operationId: 'new' } }, [original, loss], {}), true);
  assert.equal(reportNeedsObservation(replay, [{ ...original, result: { ok: false } }, loss], {}), true);
});

test('tab recovery observes reset draft before any reconstruction and allows later updated observation', () => {
  const canonical = { job: { status: 'needs_info' }, otherJob: {}, claimActive: false, immutableDigest: 'same' };
  const writes = Object.keys(expectedValues).map(field => ({ kind: 'input', field }));
  const page = { values: { ...initialValues, ...expectedValues }, events: writes, submitAttempts: 0, rejectedEvents: 0 };
  const loss = { kind: 'tab-closed', sequence: 1, page, canonical };
  const reset = { ...page, values: { ...initialValues }, events: [...writes, { kind: 'page-load' }] };
  const rebuilt = { ...page, events: [...reset.events, ...writes] };
  const context = { command: 'host-browser-context', result: { hostBrowser: {} } };
  const observed = page => ({ kind: 'recovery-observation', lossSequence: 1, evidenceKind: 'agent_attested', page, canonical,
    evidence: { source: 'native_host_browser', values: page.values, title: 'Fictional host browser acceptance', url: 'http://127.0.0.1:1234/' } });
  const report = { kind: 'report', command: 'host-browser-report', result: { receipt: {}, evidenceKind: 'agent_attested' } };
  const grade = receipts => gradeHostBrowserRecovery({ canonical }, { canonical, page: rebuilt, receipts }, 'tab-closed');
  assert.equal(grade([loss, context, observed(rebuilt), report]).passed, false);
  assert.equal(grade([loss, context, observed(reset), observed(rebuilt), report]).passed, true);
  // A write followed by another load must not hide premature reconstruction.
  assert.equal(grade([loss, context, observed({ ...reset, events: [...reset.events, writes[0], { kind: 'page-load' }] }), report]).passed, false);
});

import { ownedBrokerLifecycle } from '../evals/workflows/host-browser-recovery.mjs';
import { installedFixture } from './workspace_installed_workflows_support.mjs';
import { prepareInstalledCampaign } from '../evals/workflows/scenarios.mjs';
test('owned lifecycle close is terminal across the stop-old/start-replacement gap', async () => {
  const state = await installedFixture();
  const lifecycle = ownedBrokerLifecycle(state);
  try {
    await prepareInstalledCampaign(state);
    const old = await lifecycle.start();
    await lifecycle.stop(old, 'SIGKILL');
    // Deterministic injection barrier: old child exited, replacement not registered.
    await lifecycle.close();
    await assert.rejects(lifecycle.start(), /closed/);
    assert.throws(() => process.kill(old.child.pid, 0), { code: 'ESRCH' });
  } finally { await lifecycle.close(); await state.cleanup(); }
});

test('owned lifecycle close drains a replacement startup handshake before shutdown', async () => {
  const state = await installedFixture();
  let releaseHandshake, enteredHandshake;
  const release = new Promise(resolve => { releaseHandshake = resolve; });
  const entered = new Promise(resolve => { enteredHandshake = resolve; });
  let calls = 0, finishedHandshake = false;
  const lifecycle = ownedBrokerLifecycle({ ...state, call: async (...args) => {
    if (++calls === 2) { enteredHandshake(); await release; }
    const result = await state.call(...args);
    if (calls === 2) finishedHandshake = true;
    return result;
  } });
  try {
    await prepareInstalledCampaign(state);
    await lifecycle.stop(await lifecycle.start(), 'SIGKILL');
    const replacement = lifecycle.start();
    await entered;
    const closed = lifecycle.close();
    assert.equal(finishedHandshake, false);
    // Barrier remains held: close must not kill the real child while handshake is unfinished.
    assert.doesNotThrow(() => process.kill(lifecycle.current.child.pid, 0));
    releaseHandshake();
    const broker = await replacement;
    await closed;
    assert.equal(finishedHandshake, true);
    assert.throws(() => process.kill(broker.child.pid, 0), { code: 'ESRCH' });
    await assert.rejects(lifecycle.start(), /closed/);
  } finally { releaseHandshake(); await lifecycle.close(); await state.cleanup(); }
});
