import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, read, write, snapshot, host, event, acquire } from './workspace_durable_claims_support.mjs';
import { installedHost } from './workspace_host_support.mjs';
import { claimEvent } from '../runtime/workflows/applications/attempt.js';
import { fromJSON, get, set, text } from '../runtime/contracts/workspace/values.js';
import { ApplicationRunsService } from '../runtime/workspace-core/application-runs.js';
const posix = { skip: !['darwin', 'linux'].includes(process.platform) };
const observed = { status: 'active', step: 'questions', answerKeys: ['answer_1'],
  pendingFields: [{ question: 'PRIVATE QUESTION', state: 'missing', answerKey: 'answer_1' },
    { question: 'PRIVATE SENSITIVE QUESTION', state: 'sensitive', sensitive: true }],
  blockers: [{ type: 'browser_handoff', code: 'login-required' }], handoffChecklist: ['resume_upload'],
  browserHandoff: { state: 'required', reasonCode: 'login-required', revision: '9007199254740993' } };
const savedEvent = (context, kind = 'cancel', operationId = 'saved-exit') => {
  const action = context.guidance.actions.find(item => item.kind === kind);
  assert.deepEqual(action.requiredFields, ['operationId']);
  assert.equal(Object.hasOwn(action.input, 'session'), false);
  assert.equal(action.input.savedSessionFingerprint, context.guidance.checkpoint.savedSessionFingerprint);
  return { ...action.input, operationId };
};
async function unchanged(state, operation, pattern) {
  const before = await snapshot(state.root);
  await assert.rejects(operation, pattern);
  assert.deepEqual(await snapshot(state.root), before);
}
function assertPreserved(before, after) {
  const normalized = JSON.parse(after); normalized.updatedAt = JSON.parse(before).updatedAt;
  assert.deepEqual(normalized, JSON.parse(before));
  assert.match(after, /9007199254740993/);
  assert.doesNotMatch(after, /PRIVATE QUESTION|PRIVATE SENSITIVE QUESTION/);
}

test('saved-session events are closed, exclusive and available only for Needs Info safe exits', () => {
  const saved = { ...event('cancel', { taskId: 'task', revision: '2', subject: { jobRevision: '3' } }),
    savedSessionFingerprint: 'a'.repeat(64) };
  delete saved.session;
  assert.equal(claimEvent(saved).savedSessionFingerprint, saved.savedSessionFingerprint);
  for (const invalid of [ { ...saved, session: {} }, { ...saved, kind: 'progress' },
    { ...saved, kind: 'handoff', status: 'awaiting_review' }, { ...saved, kind: 'recover' },
    { ...saved, savedSessionFingerprint: 'a'.repeat(64) + '\n' },
    { ...saved, savedSessionFingerprint: { fingerprint: 'a'.repeat(64) } } ]) {
    assert.throws(() => claimEvent(invalid), /invalid_event/);
  }
});

for (const kind of ['handoff', 'cancel']) {
  test(`${kind} preserves pending checkpoints after input drift and access revocation`, posix, async t => {
    const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
    const state = await setup(fixture, `saved-${kind}`), { workflow, access } = host(state);
    t.after(() => workflow.close());
    const task = await acquire(state, workflow);
    await workflow.execute(event('progress', task, { session: observed }));
    await new ApplicationRunsService(state.repository, () => state.clock.now)
      .update(state.run.runId, 1n, fromJSON({ jobIds: ['job'] }));
    access.authorized = [];
    const before = await snapshot(state.root), context = await workflow.inspect();
    assert.deepEqual(await snapshot(state.root), before);
    assert.equal(context.guidance.checkpoint.pendingFieldCount, 2);
    assert.equal(context.guidance.selection.inputsCurrent, false);
    assert.doesNotMatch(JSON.stringify(context), /PRIVATE|questionFingerprint|scopeFingerprint|tokenHash/);
    const request = savedEvent(context, kind);
    if (kind === 'cancel') await unchanged(state, () => workflow.execute(request), /user_event_required/);
    state.clock.now = '2026-09-10T12:01:00Z';
    const result = await workflow.execute(request, request);
    assert.equal(result.receipt.task.status, kind === 'cancel' ? 'cancelled' : 'finished');
    const after = await snapshot(state.root);
    assertPreserved(before['sessions/job.json'], after['sessions/job.json']);
    for (const name of ['profile.json', 'resumes.json', 'answers.json', 'resume-facts.json']) {
      assert.equal(after[name], before[name], name);
    }
    assert.equal((await read(state.root, 'coordinator.json')).claim, null);
    const jobs = await read(state.root, 'jobs.json');
    assert.equal(jobs.jobs.job.status, 'needs_info');
    assert.deepEqual(jobs.metadata.applicationRuns, JSON.parse(before['jobs.json']).metadata.applicationRuns);
    const replay = await workflow.execute(request, request);
    assert.equal(replay.replayed, true); assert.deepEqual(await snapshot(state.root), after);
  });
}

test('stale checkpoint references reject under lock without clearing newer pending work', posix, async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const state = await setup(fixture, 'saved-stale'), { workflow } = host(state); t.after(() => workflow.close());
  const task = await acquire(state, workflow);
  await workflow.execute(event('progress', task, { session: observed }));
  const request = savedEvent(await workflow.inspect());
  await unchanged(state, () => workflow.execute({ ...request, savedSessionFingerprint: '0'.repeat(64) },
    { ...request, savedSessionFingerprint: '0'.repeat(64) }), /saved session changed/);
  // An independent canonical session writer need not advance the workflow task revision.
  await state.repository.claimTransaction(async tx => {
    set(tx.sessions[0], 'step', text('owner-updated-checkpoint'));
    await tx.saveSession(tx.sessions[0]);
  });
  await unchanged(state, () => workflow.execute(request, request), /saved session changed/);
  const fresh = savedEvent(await workflow.inspect(), 'cancel', 'fresh-exit');
  const before = await snapshot(state.root); await workflow.execute(fresh, fresh);
  assertPreserved(before['sessions/job.json'], (await snapshot(state.root))['sessions/job.json']);
});

test('old-attempt checkpoint cannot be adopted by a newly acquired attempt', posix, async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const state = await setup(fixture, 'saved-old'), { workflow } = host(state); t.after(() => workflow.close());
  const first = await acquire(state, workflow);
  await workflow.execute(event('progress', first, { session: observed }));
  const old = savedEvent(await workflow.inspect()); await workflow.execute(old, old);
  await state.claims.select('job', 4n, true);
  const acquireAgain = event('acquire', null, { operationId: 'new-acquire', jobRevision: '5' });
  await workflow.execute(acquireAgain, acquireAgain);
  const context = await workflow.inspect(), descriptor = context.guidance.actions.find(item => item.kind === 'cancel');
  assert.deepEqual(descriptor.requiredFields, ['operationId', 'session']);
  assert.equal(context.guidance.checkpoint.savedSessionFingerprint, undefined);
  const forged = { ...descriptor.input, operationId: 'old-checkpoint', savedSessionFingerprint: old.savedSessionFingerprint };
  await unchanged(state, () => workflow.execute(forged, forged), /saved session changed/);
});

test('published saved handoff replays once after interrupted journal publication', posix, async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const state = await setup(fixture, 'saved-fault'); let armed = false;
  const { workflow } = host(state, { after: async (path, value) => {
    if (armed && path.endsWith('/coordinator-journal.json') && get(value, 'operation') !== null) {
      armed = false; throw Error('interrupted publication');
    }
  } });
  t.after(() => workflow.close());
  const task = await acquire(state, workflow); await workflow.execute(event('progress', task, { session: observed }));
  const request = savedEvent(await workflow.inspect()), before = await snapshot(state.root);
  armed = true; await assert.rejects(workflow.execute(request, request), /interrupted publication/);
  assert.equal((await workflow.execute(request, request)).replayed, true);
  assertPreserved(before['sessions/job.json'], (await snapshot(state.root))['sessions/job.json']);
  assert.equal((await read(state.root, 'coordinator.json')).claim, null);
  const ledger = (await read(state.root, 'jobs.json')).metadata.agentWorkflows;
  assert.equal(Object.keys(ledger.receipts).length, 3);
});

test('installed replacement broker recovers then preserves pending questions without original text', { ...posix, timeout: 60000 }, async t => {
  const { workflow, state, serve } = await installedHost(t);
  await state.claims.select('job', 1n, true); const old = await serve(), acquireRequest = event('acquire');
  const task = (await workflow('attempt', 'event', acquireRequest, ['--host-user-event'])).result.receipt.task;
  const progressed = (await workflow('attempt', 'event', event('progress', task, { session: observed }))).result.receipt.task;
  const before = await snapshot(state.root);
  old.child.kill('SIGKILL'); assert.equal((await old.done).signal, 'SIGKILL');
  const claim = await read(state.root, 'coordinator.json'); claim.claim.expiresAt = '2020-01-01T00:00:00Z';
  await write(state.root, 'coordinator.json', claim); const replacement = await serve();
  const missing = (await workflow('attempt', 'context')).result;
  assert.equal(missing.broker.ownsClaim, false);
  assert.deepEqual(missing.guidance.actions.map(action => action.kind), ['recover']);
  const recovered = await workflow('attempt', 'event', event('recover', progressed), ['--host-user-event']);
  assert.equal(recovered.ok, true);
  const request = savedEvent((await workflow('attempt', 'context')).result);
  const done = await workflow('attempt', 'event', request, ['--host-user-event']);
  assert.equal(done.result.receipt.outcome, 'cancelled');
  assertPreserved(before['sessions/job.json'], (await snapshot(state.root))['sessions/job.json']);
  assert.equal((await read(state.root, 'coordinator.json')).claim, null);
  assert.equal((await workflow('attempt', 'event', request, ['--host-user-event'])).result.replayed, true);
  replacement.child.kill('SIGTERM'); assert.equal((await replacement.done).code, 0);
});
