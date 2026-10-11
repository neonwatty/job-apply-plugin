import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile, readFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHostBrowserFixture } from '../evals/workflows/host-browser-fixture.mjs';

test('HTTP harness starts clean, bounds ingestion and preserves failed grading attempts', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'host-acceptance-'));
  const outputDirectory = join(parent, 'trial');
  const fixture = await createHostBrowserFixture({ outputDirectory, scenario: 'controls-handoff' });
  t.after(async () => { await fixture.close(); await rm(parent, { recursive: true, force: true }); });
  const installedSkill = join(fixture.manifest.installed.skills, 'job-apply/SKILL.md');
  assert.equal((await lstat(installedSkill)).isSymbolicLink(), false);
  assert.equal(await readFile(installedSkill, 'utf8'), await readFile(new URL('../skills/job-apply/SKILL.md', import.meta.url), 'utf8'));
  const before = await fixture.inspect();
  assert.equal(before.page.events.length, 0);
  assert.equal(before.canonical.claimActive, false);
  const page = await (await fetch(fixture.url)).text();
  assert.match(page, /Unrelated notes/);
  assert.match(page, /Required resume upload:.*Pending owner action/);
  assert.doesNotMatch(page, /mark.*pass/i);
  const post = value => fetch(fixture.url + 'events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  assert.equal((await post({ kind: 'input', field: 'unknown', value: 'x' })).status, 400);
  assert.equal((await post({ kind: 'input', field: 'name', value: 'x'.repeat(10000) })).status, 413);
  // HTTP-simulated events test the observer; these are not host-browser evidence.
  assert.equal((await post({ kind: 'input', field: 'name', value: 'Fictional Candidate' })).status, 200);
  assert.equal((await post({ kind: 'change', field: 'notes', value: 'altered' })).status, 200);
  assert.equal((await post({ kind: 'submit' })).status, 200);
  const installed = fixture.manifest.installed;
  const run = promisify(execFile);
  const command = (commands, extra = []) => run(installed.node, [installed.launcher, 'workflow', 'attempt', ...commands, '--root', installed.root, '--native-lock', installed.nativeLock, ...extra], { timeout: 15000, cwd: installed.plugin, env: { PATH: '', HOME: join(installed.plugin, '../home') } }).catch(error => { throw Error(error.stdout + error.stderr); });
  const context = JSON.parse((await command(['context'], ['--job-id', 'job'])).stdout).result;
  const acquire = { ...context.guidance.actions.find(action => action.kind === 'acquire').input, operationId: 'harness-acquire' };
  const input = join(parent, 'acquire.json');
  await writeFile(input, JSON.stringify(acquire));
  await command(['event'], ['--host-user-event', '--input', input]);
  assert.equal((await fixture.inspect()).canonical.claimActive, true);
  const grade = await fixture.grade();
  assert.equal(grade.passed, false);
  assert.equal(grade.pageChecks.notesPreserved, false);
  assert.equal(grade.pageChecks.zeroSubmitAttempts, false);
  assert.equal(grade.canonicalChecks.needsInfoReleasedClaim, false);
  await fixture.grade();
  assert.equal((await readdir(join(outputDirectory, 'grades'))).length, 2);
  await assert.rejects(createHostBrowserFixture({ outputDirectory, scenario: 'controls-handoff' }), /exist/i);
});

import { gradeHostBrowser } from '../evals/workflows/host-browser-grade.mjs';
import { expectedValues, initialValues } from '../evals/workflows/host-browser-page.mjs';
test('grader independently rejects missing writes and active canonical claim', () => {
  const canonical = { job: { status: 'needs_info' }, otherJob: { id: 'other' }, claimActive: false, immutableDigest: 'same' };
  const before = { canonical };
  const after = { canonical: { ...canonical, claimActive: true }, page: { values: { ...initialValues, ...expectedValues }, events: [], submitAttempts: 0, rejectedEvents: 0 }, receipts: [] };
  const result = gradeHostBrowser(before, after, 'controls-handoff');
  assert.equal(result.pageChecks.expectedValues, true);
  assert.equal(result.pageChecks.requiredWritesObserved, false);
  assert.equal(result.canonicalChecks.needsInfoReleasedClaim, false);
  assert.equal(result.passed, false);
});

test('scenario grader rejects replay labels without exact original canonical receipt', () => {
  const canonical = { job: { status: 'needs_info' }, otherJob: { id: 'other' }, claimActive: false, immutableDigest: 'same' };
  const page = { values: { ...initialValues, ...expectedValues }, events: Object.keys(expectedValues).map(field => ({ field })), submitAttempts: 0, rejectedEvents: 0 };
  const result = gradeHostBrowser({ canonical }, { canonical, page, receipts: [{ kind: 'replay', result: { replayed: true }, beforePage: page, afterPage: page, beforeCanonical: canonical, afterCanonical: canonical }] }, 'stale-report');
  assert.equal(result.scenarioChecks.replayInert, false);
  assert.equal(result.scenarioChecks.staleRejected, false);
});

test('stale oracle rejects malformed IDs and requires independently current stale task revision', () => {
  const canonical = { job: { status: 'needs_info' }, otherJob: {}, claimActive: false, immutableDigest: 'same', workflowTasks: { tasks: { task: { taskId: 'task', revision: '3' } } } };
  const page = { values: { ...initialValues, ...expectedValues }, events: Object.keys(expectedValues).map(field => ({ field })), submitAttempts: 0, rejectedEvents: 0 };
  const payload = { operationId: 'original', taskId: 'task', expectedRevision: '2' };
  const original = { kind: 'report', payload, result: { evidenceKind: 'agent_attested', receipt: {} } };
  const rejection = operationId => ({ kind: 'stale-rejection', payload: { ...payload, operationId }, result: { ok: false, error: 'request_rejected' }, beforeCanonical: canonical, afterCanonical: canonical });
  const grade = receipt => gradeHostBrowser({ canonical }, { canonical, page, receipts: [original, receipt] }, 'stale-report');
  assert.equal(grade(rejection('')).scenarioChecks.staleRejected, false);
  assert.equal(grade(rejection('new-id')).scenarioChecks.staleRejected, true);
  const fresh = { ...canonical, workflowTasks: { tasks: { task: { taskId: 'task', revision: '2' } } } };
  assert.equal(grade({ ...rejection('new-id'), beforeCanonical: fresh, afterCanonical: fresh }).scenarioChecks.staleRejected, false);
});

test('uncertainty oracle requires successful report after reobservation and no prior report', () => {
  const canonical = { job: { status: 'needs_info' }, otherJob: {}, claimActive: false, immutableDigest: 'same' };
  const page = { values: { ...initialValues, ...expectedValues }, events: Object.keys(expectedValues).map(field => ({ field })), submitAttempts: 0, rejectedEvents: 0 };
  const success = { kind: 'report', result: { evidenceKind: 'agent_attested', receipt: {} } };
  const steps = [{ kind: 'interruption', page }, { command: 'host-browser-context', result: { hostBrowser: {} } }, { kind: 'resume-observation', page }];
  const grade = receipts => gradeHostBrowser({ canonical }, { canonical, page, receipts }, 'uncertain-resume');
  assert.equal(grade([success, ...steps, { kind: 'report', result: { ok: false } }]).passed, false);
  assert.equal(grade([...steps, { kind: 'report', result: { ok: false } }]).scenarioChecks.rereadBeforeReport, false);
  assert.equal(grade([...steps, success]).passed, true);
});

test('uncertainty oracle rejects progress reported before reobservation', () => {
  const canonical = { job: { status: 'needs_info' }, otherJob: {}, claimActive: false, immutableDigest: 'same' };
  const page = { values: { ...initialValues, ...expectedValues }, events: Object.keys(expectedValues).map(field => ({ field })), submitAttempts: 0, rejectedEvents: 0 };
  const success = outcome => ({ kind: 'report', payload: { outcome }, result: { evidenceKind: 'agent_attested', receipt: {} } });
  const receipts = [{ kind: 'interruption', page }, success('progress'), { command: 'host-browser-context', result: { hostBrowser: {} } }, { kind: 'resume-observation', page }, success('needs_info')];
  const grade = gradeHostBrowser({ canonical }, { canonical, page, receipts }, 'uncertain-resume');
  assert.equal(grade.scenarioChecks.rereadBeforeReport, false);
  assert.equal(grade.passed, false);
});


test('fixture keeps owned broker available beyond initial idle timeout before first user context', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'host-delayed-context-'));
  const fixture = await createHostBrowserFixture({ outputDirectory: join(parent, 'trial'), scenario: 'controls-handoff' });
  t.after(async () => { await fixture.close(); await rm(parent, { recursive: true, force: true }); });
  // Real timer check: neither an owner request nor browser action occurs for >10s.
  await new Promise(resolve => setTimeout(resolve, 10500));
  const response = await fetch(fixture.url + 'command', { method: 'POST', headers: { authorization: `Bearer ${fixture.manifest.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ command: 'context', kind: 'canonical' }) });
  const context = await response.json();
  assert.equal(response.status, 200);
  assert.ok(context.guidance);
  assert.equal((await fixture.inspect()).canonical.claimActive, false);
  assert.equal((await fixture.inspect()).page.events.length, 0);
});

function heartbeatGrade(beforeCanonical, afterCanonical) {
  const canonical = { job: { status: 'needs_info' }, otherJob: {}, claimActive: false, immutableDigest: 'same' };
  const page = { values: { ...initialValues, ...expectedValues }, events: Object.keys(expectedValues).map(field => ({ field })), submitAttempts: 0, rejectedEvents: 0 };
  const payload = { operationId: 'original', taskId: 'task', expectedRevision: '2' };
  const original = { kind: 'report', payload, result: { evidenceKind: 'agent_attested', receipt: {} } };
  const snapshots = { beforeCanonical, afterCanonical, beforePage: page, afterPage: page };
  return gradeHostBrowser({ canonical }, { canonical, page, receipts: [original,
    { ...snapshots, kind: 'stale-rejection', payload: { ...payload, operationId: 'new-id' }, result: { ok: false } },
    { ...snapshots, kind: 'replay', payload, result: { replayed: true } },
  ] }, 'stale-report').scenarioChecks;
}
function heartbeatSnapshot() {
  return { job: { status: 'in_progress' }, otherJob: { id: 'other' }, claimActive: true, immutableDigest: 'same',
    workflowTasks: { tasks: { task: { taskId: 'task', revision: '3' } } },
    coordinator: { schemaVersion: 1, claim: { claimId: 'claim', jobId: 'job', ownerLabel: 'fixture', tokenHash: 'synthetic',
      acquiredAt: '2026-10-11T23:43:10Z', heartbeatAt: '2026-10-11T23:43:10Z', expiresAt: '2026-10-11T23:48:10Z' } } };
}
function renewedSnapshot() {
  const result = heartbeatSnapshot();
  Object.assign(result.coordinator.claim, { heartbeatAt: '2026-10-11T23:44:04Z', expiresAt: '2026-10-11T23:49:04Z' });
  return result;
}
test('heartbeat oracle accepts exact snapshots and paired broker lease renewal for rejection and replay', () => {
  for (const after of [heartbeatSnapshot(), renewedSnapshot()]) {
    const checks = heartbeatGrade(heartbeatSnapshot(), after);
    assert.equal(checks.staleRejected, true);
    assert.equal(checks.replayInert, true);
  }
});
test('heartbeat oracle rejects invalid renewal and any other canonical mutation', () => {
  const mutations = [
    snapshot => { snapshot.coordinator.claim.heartbeatAt = 'garbage'; },
    snapshot => { snapshot.coordinator.claim.heartbeatAt = '2026-02-30T23:44:04Z'; },
    snapshot => { snapshot.coordinator.claim.expiresAt = 'garbage'; },
    snapshot => { snapshot.coordinator.claim.expiresAt = '2026-10-11T23:49:04.000Z'; },
    snapshot => { Object.assign(snapshot.coordinator.claim, { heartbeatAt: '2026-10-11T23:42:00Z', expiresAt: '2026-10-11T23:47:00Z' }); },
    snapshot => { snapshot.coordinator.claim.expiresAt = '2026-10-11T23:49:05Z'; },
    snapshot => { snapshot.coordinator.claim.heartbeatAt = '2026-10-11T23:43:10Z'; },
    snapshot => { snapshot.coordinator.claim.expiresAt = '2026-10-11T23:48:10Z'; },
    ...['claimId', 'jobId', 'ownerLabel', 'tokenHash', 'acquiredAt'].map(key => snapshot => { snapshot.coordinator.claim[key] = 'changed'; }),
    snapshot => { snapshot.coordinator.claim = null; },
    snapshot => { snapshot.coordinator.claim.extra = true; },
    snapshot => { snapshot.coordinator.schemaVersion = 2; },
    snapshot => { snapshot.workflowTasks.tasks.task.revision = '4'; },
    snapshot => { snapshot.job.status = 'applied'; },
    snapshot => { snapshot.otherJob.id = 'changed'; },
    snapshot => { snapshot.immutableDigest = 'changed'; },
    snapshot => { snapshot.claimActive = false; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const after = renewedSnapshot();
    mutate(after);
    const checks = heartbeatGrade(heartbeatSnapshot(), after);
    assert.equal(checks.staleRejected, false, `stale mutation ${index}`);
    assert.equal(checks.replayInert, false, `replay mutation ${index}`);
  }
  const invalidLease = heartbeatSnapshot();
  invalidLease.coordinator.claim.expiresAt = '2026-10-11T23:48:11Z';
  assert.equal(heartbeatGrade(invalidLease, renewedSnapshot()).staleRejected, false);
  assert.equal(heartbeatGrade(invalidLease, renewedSnapshot()).replayInert, false);
  for (const field of ['heartbeatAt', 'expiresAt']) {
    const before = heartbeatSnapshot();
    before.coordinator.claim[field] = 'invalid';
    const checks = heartbeatGrade(before, renewedSnapshot());
    assert.equal(checks.staleRejected, false);
    assert.equal(checks.replayInert, false);
  }
});
