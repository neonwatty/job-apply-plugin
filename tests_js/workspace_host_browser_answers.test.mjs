import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { AnswersService } from '../runtime/workspace-core/answers.js';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';
import { browserValueGrant } from '../runtime/contracts/workspace/browser-authority.js';
import { setupHost, host, acquire, proposal, binding, synthetic, unchanged } from './workspace_host_browser_support.mjs';
const plain = value => JSON.parse(serialize(value));

async function answerHost(state, sensitive = false) {
  const answers = new AnswersService(state.repository, () => state.clock.now);
  const answer = plain(await answers.put(fromJSON({ key: 'answer.fixture', question: 'Synthetic question',
    state: 'confirmed', value: 'PRIVATE FICTIONAL ANSWER', sensitivity: sensitive ? 'high' : 'none' }), sensitive));
  state.adapter = synthetic(new Map([['answer.ref', 'PRIVATE FICTIONAL ANSWER']]));
  const ports = host(state, { grants: new Map([['answer.ref', { kind: 'fill', source: 'answer',
    answerRef: answer.key, answerRevision: String(answer.revision) }]]), controls: new Map([['contact.name', 'answer.ref']]) });
  return { ports, answers, answer };
}

test('canonical confirmed answers require exact grant revisions for new writes and replay', async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const state = await setupHost(fixture, 'host-answer'), { ports, answers, answer } = await answerHost(state);
  t.after(() => ports.host.close());
  const task = await acquire(ports), request = await proposal(ports, state, task, { valueRef: 'answer.ref' });
  assert.equal((await ports.model.execute(request)).status, 'verified');
  assert.equal(state.adapter.calls.writes, 1);
  await answers.update(answer.key, fromJSON({ value: 'CHANGED PRIVATE ANSWER' }), BigInt(answer.revision));
  await unchanged(state, () => ports.model.execute(request), /authority_denied/);
  await unchanged(state, () => ports.model.reconcile(binding(state, task), request.operationId), /authority_denied/);
  assert.equal(state.adapter.calls.writes, 1);
});

test('sensitive answers require canonical current-use approval and its exact answer revision', async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const state = await setupHost(fixture, 'host-sensitive'), { ports, answers, answer } = await answerHost(state, true);
  t.after(() => ports.host.close());
  const task = await acquire(ports);
  const denied = await proposal(ports, state, task, { operationId: 'sensitive-denied', valueRef: 'answer.ref' });
  await unchanged(state, () => ports.model.execute(denied), /authority_denied/);
  assert.equal(state.adapter.calls.writes, 0);
  state.authorization = plain(await state.authority.set(fromJSON({ mode: 'autofill_to_review',
    runId: state.run.runId, jobIds: ['job'], sensitiveAnswerRefs: [answer.key], durationMinutes: 60 }),
  BigInt(state.authorization.revision)));
  const request = await proposal(ports, state, task, { operationId: 'sensitive-approved', valueRef: 'answer.ref' });
  assert.equal((await ports.model.execute(request)).status, 'verified');
  await answers.update(answer.key, fromJSON({ value: 'CHANGED PRIVATE SENSITIVE' }), BigInt(answer.revision), true);
  await unchanged(state, () => ports.model.execute(request), /authority_denied/);
  assert.equal(state.adapter.calls.writes, 1);
  await state.authority.revoke(BigInt(state.authorization.revision));
  await unchanged(state, () => ports.model.reconcile(binding(state, task), request.operationId), /authority_denied/);
});

test('trusted grant parser rejects wrong source kind and native source checks reject stale revisions', async t => {
  assert.throws(() => browserValueGrant({ kind: 'upload', source: 'profile', field: 'name', profileRevision: '1' }));
  assert.throws(() => browserValueGrant({ kind: 'fill', source: 'profile', field: 'preferences', profileRevision: '1' }));
  assert.throws(() => browserValueGrant({ kind: 'fill', source: 'answer', answerRef: 'answer.fixture', answerRevision: '1', sensitive: false }));
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  for (const source of ['profile', 'resume', 'answer']) {
    const state = await setupHost(fixture, `host-stale-${source}`);
    let grant = state.grants.get(source === 'profile' ? 'profile.name' : 'resume.source');
    if (source === 'answer') {
      const answers = new AnswersService(state.repository, () => state.clock.now);
      await answers.put(fromJSON({ key: 'answer.fixture', question: 'Synthetic question', state: 'confirmed', value: 'private' }));
      grant = { kind: 'fill', source: 'answer', answerRef: 'answer.fixture', answerRevision: '999' };
    } else grant = { ...grant, [source === 'profile' ? 'profileRevision' : 'resumeRevision']: '999' };
    const controlId = source === 'resume' ? 'resume.file' : 'contact.name';
    const ports = host(state, { grants: new Map([['stale', grant]]), controls: new Map([[controlId, 'stale']]) });
    t.after(() => ports.host.close());
    const task = await acquire(ports), request = await proposal(ports, state, task,
      { valueRef: 'stale', kind: grant.kind, controlId });
    await unchanged(state, () => ports.model.execute(request), /authority_denied/);
    assert.equal(state.adapter.calls.writes, 0);
  }
});
