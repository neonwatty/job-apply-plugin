import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHostBrowserFixture } from '../evals/workflows/host-browser-fixture.mjs';
import { digest } from '../evals/workflows/host-browser-grade.mjs';
import { expectedValues } from '../evals/workflows/host-browser-page.mjs';
import * as leaf from '../evals/workflows/host-browser-drift.mjs';

test('drift injection rejects caller-selected source, revisions and content', () => {
  assert.equal(typeof leaf.validateDriftInjection, 'function');
  leaf.validateDriftInjection({ kind: 'source-input-drift' });
  for (const input of [null, {}, [], { kind: 'other' }, { kind: 'source-input-drift', resumeId: 'other' },
    { kind: 'source-input-drift', expectedRevision: '1' }, { kind: 'source-input-drift', facts: {} }]) {
    assert.throws(() => leaf.validateDriftInjection(input), /invalid_injection/);
  }
});

test('supported source drift preserves original inputs and permits observed safe handoff', { timeout: 60000 }, async t => {
  const parent = await mkdtemp(join(tmpdir(), 'host-drift-'));
  const fixture = await createHostBrowserFixture({ outputDirectory: join(parent, 'trial'), scenario: 'source-input-drift' });
  t.after(async () => { await fixture.close(); await rm(parent, { recursive: true, force: true }); });
  const post = async (route, payload, auth = true) => {
    const response = await fetch(fixture.url + route, { method: 'POST', headers: { 'content-type': 'application/json',
      ...(auth ? { authorization: `Bearer ${fixture.manifest.token}` } : {}) }, body: JSON.stringify(payload) });
    return { status: response.status, value: await response.json() };
  };
  const initial = await fixture.inspect();
  assert.equal((await post('inject', { kind: 'source-input-drift' }, false)).status, 403);
  assert.equal((await post('inject', { kind: 'source-input-drift', resumeId: 'other' })).status, 400);
  assert.deepEqual(await fixture.inspect(), initial);
  // Synthetic observer traffic verifies protocol behavior, not native browser interaction.
  for (const [field, value] of Object.entries(expectedValues)) await post('events', { kind: 'input', field, value });
  const context = (await post('command', { command: 'context', kind: 'canonical' })).value;
  const input = join(parent, 'acquire.json');
  await writeFile(input, JSON.stringify({ ...context.guidance.actions.find(action => action.kind === 'acquire').input, operationId: 'drift-acquire' }));
  const installed = fixture.manifest.installed;
  await promisify(execFile)(installed.node, [installed.launcher, 'workflow', 'attempt', 'event', '--root', installed.root,
    '--native-lock', installed.nativeLock, '--host-user-event', '--input', input], { cwd: installed.plugin, env: { PATH: '', HOME: join(installed.plugin, '../home') } });
  const beforeContext = (await post('command', { command: 'host-browser-context', kind: 'canonical' })).value;
  const { kind, ...progress } = beforeContext.guidance.actions.find(action => action.kind === 'progress').input;
  const stale = { ...progress, operationId: 'old-input-report', evidenceKind: 'agent_attested', outcome: 'progress' };
  const injected = await post('inject', { kind: 'source-input-drift' });
  assert.equal(injected.status, 200, JSON.stringify(injected));
  const mutation = injected.value;
  assert.equal(mutation.result.state, 'draft');
  assert.deepEqual(mutation.afterFacts.sets.source.versions.slice(0, -1), mutation.beforeFacts.sets.source.versions);
  assert.equal(mutation.beforeFacts.sets.source.versions.at(-1).state, 'confirmed');
  assert.deepEqual(mutation.beforePage, mutation.afterPage);
  const changed = Object.keys(mutation.beforeDurableDigests).filter(name => mutation.beforeDurableDigests[name] !== mutation.afterDurableDigests[name]);
  assert.deepEqual(changed, ['resume-facts.json']);
  assert.equal((await post('command', { command: 'host-browser-report', kind: 'stale-rejection', payload: stale })).value.error, 'drift_observation_required');
  const observation = { kind: 'drift-observation', driftSequence: mutation.sequence, evidence: {
    source: 'native_host_browser', url: fixture.url, title: 'Fictional host browser acceptance', values: mutation.afterPage.values } };
  assert.equal((await post('checkpoint', observation)).status, 400);
  const current = (await post('command', { command: 'host-browser-context', kind: 'canonical' })).value;
  assert.equal(current.guidance.selection.inputsCurrent, false);
  assert.ok(!current.guidance.actions.some(action => action.kind === 'progress'));
  assert.equal((await post('checkpoint', { ...observation, evidence: { ...observation.evidence, values: {} } })).status, 400);
  assert.equal((await post('checkpoint', observation)).status, 200);
  const rejected = await post('command', { command: 'host-browser-report', kind: 'stale-rejection', payload: stale });
  assert.equal(rejected.value.error, 'request_rejected');
  const { kind: exitKind, status, ...handoff } = current.guidance.actions.find(action => action.kind === 'handoff').input;
  const result = await post('command', { command: 'host-browser-report', kind: 'report', payload: {
    ...handoff, operationId: 'drift-safe-exit', evidenceKind: 'agent_attested', outcome: 'needs_info' } });
  assert.ok(result.value.receipt, JSON.stringify(result));
  const after = await fixture.inspect();
  const graded = leaf.gradeHostBrowserDrift(initial, after, 'source-input-drift');
  assert.equal(graded.passed, true, JSON.stringify(graded));
  const renewed = structuredClone(after);
  const renewal = renewed.receipts.find(r => r.kind === 'source-input-drift');
  const coordinator = structuredClone(renewal.beforeCanonical.coordinator);
  const later = value => new Date(Date.parse(value) + 60_000).toISOString().replace('.000Z', 'Z');
  coordinator.claim.heartbeatAt = later(coordinator.claim.heartbeatAt);
  coordinator.claim.expiresAt = later(coordinator.claim.expiresAt);
  renewal.afterCanonical.coordinator = coordinator;
  renewal.afterCoordinatorBytes = Buffer.from(JSON.stringify(coordinator)).toString('base64');
  renewal.afterDurableDigests['coordinator.json'] = digest(renewal.afterCoordinatorBytes);
  assert.equal(leaf.gradeHostBrowserDrift(initial, renewed, 'source-input-drift').passed, true, 'paired forward heartbeat');
  for (const field of ['tokenHash', 'jobId', 'expiresAt']) {
    const invalid = structuredClone(renewed), receipt = invalid.receipts.find(r => r.kind === 'source-input-drift');
    const corrupted = JSON.parse(Buffer.from(receipt.afterCoordinatorBytes, 'base64').toString());
    corrupted.claim[field] = field === 'expiresAt' ? later(corrupted.claim[field]) : 'changed';
    receipt.afterCanonical.coordinator = corrupted;
    receipt.afterCoordinatorBytes = Buffer.from(JSON.stringify(corrupted)).toString('base64');
    receipt.afterDurableDigests['coordinator.json'] = digest(receipt.afterCoordinatorBytes);
    assert.equal(leaf.gradeHostBrowserDrift(initial, invalid, 'source-input-drift').passed, false, field);
  }
  for (const [label, tamper] of [
    ['mutation result revision', value => { value.receipts.find(r => r.kind === 'source-input-drift').result.revision = 999; }],
    ['declared source revision', value => { value.receipts.find(r => r.kind === 'source-input-drift').mutation.expectedFactRevision = '999'; }],
    ['historical facts', value => { value.receipts.find(r => r.kind === 'source-input-drift').afterFacts.sets.source.versions[0].facts.name = 'Corrupted'; }],
    ['unrelated file', value => { value.receipts.find(r => r.kind === 'source-input-drift').afterDurableDigests['profile.json'] = 'changed'; }],
    ['malformed report', value => { value.receipts.find(r => r.result?.error === 'request_rejected').payload = {}; }],
    ['missing observation', value => { value.receipts = value.receipts.filter(r => r.kind !== 'drift-observation'); }],
    ['restored facts', value => { value.canonical.sourceFacts = mutation.beforeFacts; }],
    ['repeated writes', value => { value.page.events.push({ kind: 'input', field: 'name', value: 'Fictional Candidate' }); }],
  ]) {
    const changed = structuredClone(after); tamper(changed);
    assert.equal(leaf.gradeHostBrowserDrift(initial, changed, 'source-input-drift').passed, false, label);
  }
});
