import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute } from '../evals/preparation/support.mjs';
import { prepareAttemptFixture, observeAttempt, introduceStaleFacts, expireFixtureClaim } from '../evals/attempt/fixture.mjs';
import { startBroker, cleanupBrokerArtifacts } from '../evals/attempt/broker.mjs';
import { pendingCheckpoint, pendingScenarioIds } from '../evals/attempt/pending.mjs';
import { checkpoint, gradeState, continuationPrerequisite, changesInputs, recoversExpired } from '../evals/attempt/scenarios.mjs';

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const posixFixture = { skip: !['darwin', 'linux'].includes(process.platform) };
async function installBase(temporary) {
  const pluginRoot = join(temporary, 'baseline');
  await mkdir(pluginRoot);
  const archive = join(temporary, 'source.tar');
  for (const [command, args] of [['git', ['archive', '--format=tar', `--output=${archive}`, 'f95b4947453ad6c6abc9cc0e81c3e443706d4714']],
    ['tar', ['-xf', archive, '-C', pluginRoot]]]) {
    const result = await execute(command, args, { cwd: root });
    assert.equal(result.code, 0, result.stderr);
  }
  return pluginRoot;
}
async function client(pluginRoot, fixture, arm) {
  let serial = 0, current;
  const call = async (args, payload) => {
    if (payload) {
      const file = join(fixture.workspace, `event-${++serial}.json`);
      await writeFile(file, JSON.stringify(payload), { mode: 0o600 });
      args.push('--input', file);
    }
    const result = await execute(process.execPath, [join(pluginRoot, 'apps/companion/command.mjs'), ...args],
      { cwd: fixture.workspace, env: { PATH: '', HOME: fixture.workspace } });
    assert.equal(result.failure, null);
    assert.equal(result.stderr, '');
    assert.ok([0, 2].includes(result.code), result.stdout);
    return JSON.parse(result.stdout);
  };
  const workflow = ['workflow', 'attempt', 'event', '--root', fixture.storeRoot, '--native-lock', fixture.nativeLock];
  return { async inspect() {
    const response = await call(['workflow', 'attempt', 'context', '--root', fixture.storeRoot, '--native-lock', fixture.nativeLock]);
    assert.equal(response.ok, true); return response.result;
  }, async send(kind, extra = {}) {
    let response;
    if (arm === 'candidate') {
      const event = { kind, operationId: `operation-${++serial}`, taskId: current?.taskId ?? null,
        expectedRevision: current?.revision ?? null, jobId: fixture.jobId, jobRevision: current?.subject.jobRevision ?? '2', ...extra };
      response = await call([...workflow, ...(['acquire', 'recover', 'cancel'].includes(kind) ? ['--host-user-event'] : [])], event);
      if (response.ok) current = response.result.receipt.task;
    } else {
      const args = ['attempt', '--root', fixture.storeRoot];
      if (kind === 'acquire') args.push('start', '--id', fixture.jobId, '--owner', 'Fictional trial', '--expected-revision', '2');
      else if (kind === 'progress') args.push('progress');
      else args.push('handoff', '--status', 'needs_info');
      response = await call(args, extra.session);
    }
    return response;
  }, get task() { return current; } };
}

test('attempt fixture runs real public clients for pinned baseline and candidate, retaining progress through cancellation', posixFixture, async t => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'attempt-eval-test-')));
  try {
    const baseline = await installBase(temporary);
    for (const arm of ['baseline', 'candidate']) await t.test(arm, async () => {
      const pluginRoot = arm === 'baseline' ? baseline : root, workspace = join(temporary, arm + '-workspace');
      await mkdir(workspace, { mode: 0o700 });
      const fixture = await prepareAttemptFixture(pluginRoot, workspace), children = [];
      try {
        children.push(await startBroker(pluginRoot, fixture, arm));
        const initial = await observeAttempt(pluginRoot, fixture), api = await client(pluginRoot, fixture, arm);
        assert.equal((await api.send('acquire')).ok, true);
        assert.equal((await api.send('progress', { session: { ...checkpoint, attemptRevision: arm === 'baseline' ? 3 : '3' } })).ok, true);
        const first = await observeAttempt(pluginRoot, fixture);
        assert.equal((await api.send('cancel', { session: { status: 'active', step: checkpoint.step, attemptRevision: arm === 'baseline' ? 3 : '3' } })).ok, true);
        const last = await observeAttempt(pluginRoot, fixture);
        assert.deepEqual(gradeState('fresh-cancel', [first, last], initial, first, arm).checks,
          Object.fromEntries(Object.keys(gradeState('fresh-cancel', [first, last], initial, first, arm).checks).map(key => [key, true])));
      } finally {
        for (const child of children) await child.stop();
        await cleanupBrokerArtifacts(pluginRoot, fixture);
      }
    });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('stale facts reject progress and retain safe handoff through both installed routes', posixFixture, async t => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'attempt-eval-stale-')));
  try {
    const baseline = await installBase(temporary);
    for (const arm of ['baseline', 'candidate']) await t.test(arm, async () => {
      const pluginRoot = arm === 'baseline' ? baseline : root, workspace = join(temporary, arm + '-workspace');
      await mkdir(workspace, { mode: 0o700 });
      const fixture = await prepareAttemptFixture(pluginRoot, workspace), broker = await startBroker(pluginRoot, fixture, arm);
      try {
        const initial = await observeAttempt(pluginRoot, fixture), api = await client(pluginRoot, fixture, arm);
        assert.equal((await api.send('acquire')).ok, true);
        assert.equal((await api.send('progress', { session: checkpoint })).ok, true);
        const first = await observeAttempt(pluginRoot, fixture);
        await introduceStaleFacts(pluginRoot, fixture);
        const before = await observeAttempt(pluginRoot, fixture);
        assert.equal((await api.send('progress', { session: checkpoint })).ok, false);
        assert.deepEqual((await observeAttempt(pluginRoot, fixture)).hashes, before.hashes);
        assert.equal((await api.send('handoff', { status: 'needs_info', session: checkpoint })).ok, true);
        const result = gradeState('stale-inputs', [first, await observeAttempt(pluginRoot, fixture)], initial, before, arm);
        assert.equal(result.statePassed, true, JSON.stringify(result));
      } finally { await broker.stop(); await cleanupBrokerArtifacts(pluginRoot, fixture); }
    });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('owned replacement cannot use a lost capability until explicit same-task expiry recovery', posixFixture, async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'attempt-eval-recovery-')));
  const children = [];
  let fixture;
  try {
    fixture = await prepareAttemptFixture(root, workspace);
    children.push(await startBroker(root, fixture, 'candidate'));
    const initial = await observeAttempt(root, fixture), api = await client(root, fixture, 'candidate');
    assert.equal((await api.send('acquire')).ok, true);
    assert.equal((await api.send('progress', { session: checkpoint })).ok, true);
    const first = await observeAttempt(root, fixture);
    await children[0].stop('SIGKILL');
    children.push(await startBroker(root, fixture, 'candidate'));
    assert.equal((await api.send('progress', { session: checkpoint })).ok, false);
    assert.equal((await api.send('recover')).ok, false);
    assert.equal(gradeState('broker-loss', [first, await observeAttempt(root, fixture)], initial, first, 'candidate').statePassed, true);
    await children[1].stop();
    await expireFixtureClaim(root, fixture);
    children.push(await startBroker(root, fixture, 'candidate'));
    const before = await observeAttempt(root, fixture);
    assert.equal((await api.send('recover')).ok, true);
    const recovered = await observeAttempt(root, fixture);
    assert.notEqual(recovered.claim.capabilityFingerprint, first.claim.capabilityFingerprint);
    assert.equal((await api.send('cancel', { session: checkpoint })).ok, true);
    const result = gradeState('expired-recovery', [first, await observeAttempt(root, fixture)], initial, before, 'candidate');
    assert.equal(result.statePassed, true, JSON.stringify(result));
  } finally {
    for (const broker of children) await broker.stop();
    if (fixture) await cleanupBrokerArtifacts(root, fixture);
    await rm(workspace, { recursive: true, force: true });
  }
});

for (const scenario of pendingScenarioIds) {
  test(`pending evaluation fixture exercises ${scenario} through the public installed route`, posixFixture, async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'attempt-eval-pending-'))), children = [];
    let fixture;
    try {
      fixture = await prepareAttemptFixture(root, workspace);
      children.push(await startBroker(root, fixture, 'candidate'));
      const initial = await observeAttempt(root, fixture), api = await client(root, fixture, 'candidate');
      assert.equal((await api.send('acquire')).ok, true);
      assert.equal((await api.send('progress', { session: pendingCheckpoint })).ok, true);
      const first = await observeAttempt(root, fixture);
      assert.equal(continuationPrerequisite(first, initial, 'candidate', scenario), true);
      if (changesInputs(scenario)) await introduceStaleFacts(root, fixture);
      if (recoversExpired(scenario)) {
        await children[0].stop('SIGKILL');
        await expireFixtureClaim(root, fixture);
        children.push(await startBroker(root, fixture, 'candidate'));
      }
      const before = await observeAttempt(root, fixture);
      if (recoversExpired(scenario)) {
        const original = api.task;
        assert.equal((await api.send('recover')).ok, true);
        assert.equal(api.task.subject.inputRevision, original.subject.inputRevision);
        const context = await api.inspect();
        assert.equal(context.guidance.selection.inputsCurrent, false);
        assert.deepEqual(context.guidance.actions.map(action => action.kind), ['handoff', 'cancel']);
      }
      const context = await api.inspect(), kind = scenario === 'pending-stale-handoff' ? 'handoff' : 'cancel';
      const action = context.guidance.actions.find(action => action.kind === kind);
      assert.deepEqual(action.requiredFields, ['operationId']);
      assert.equal(Object.hasOwn(action.input, 'session'), false);
      assert.equal((await api.send(kind, { savedSessionFingerprint: action.input.savedSessionFingerprint,
        ...(kind === 'handoff' ? { status: 'needs_info' } : {}) })).ok, true);
      const result = gradeState(scenario, [first, await observeAttempt(root, fixture)], initial, before, 'candidate');
      assert.equal(result.statePassed, true, JSON.stringify(result));
    } finally {
      for (const broker of children) await broker.stop();
      if (fixture) await cleanupBrokerArtifacts(root, fixture);
      await rm(workspace, { recursive: true, force: true });
    }
  });
}
