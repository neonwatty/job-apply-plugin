import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { AnswersService } from '../runtime/workspace-core/answers.js';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';
import { setupHost, host, acquire, proposal, binding, event, read, unchanged, synthetic } from './workspace_host_browser_support.mjs';

for (const source of ['profile', 'answer']) test(`recovered readback cannot rebind an original ${source} grant`, async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const state = await setupHost(fixture, `rebind-${source}`);
  const answers = new AnswersService(state.repository, () => state.clock.now);
  let grants = state.grants, valueRef = 'profile.name';
  if (source === 'answer') {
    await answers.put(fromJSON({ key: 'answer.fixture', question: 'Synthetic question', state: 'confirmed', value: 'ORIGINAL' }));
    valueRef = 'answer.ref';
    grants = new Map([[valueRef, { source: 'answer', kind: 'fill', answerRef: 'answer.fixture', answerRevision: '1' }]]);
    state.adapter = synthetic(new Map([[valueRef, 'ORIGINAL']]));
  }
  const controls = new Map([['contact.name', valueRef]]);
  let fail = true;
  const adapter = { evidenceKind: 'synthetic_adapter', observe: () => state.adapter.observe(), mutate: request => state.adapter.mutate(request),
    readback: request => { if (fail) { fail = false; throw Error('lost readback'); } return state.adapter.readback(request); } };
  let ports = host(state, { adapter, grants, controls }); t.after(() => ports.host.close());
  const original = await acquire(ports), request = await proposal(ports, state, original, { valueRef });
  assert.equal((await ports.model.execute(request)).status, 'uncertain');
  const stored = (await read(state.root, 'jobs.json')).metadata.durableBrowserOperations.operations[request.operationId];
  await ports.host.close();
  if (source === 'profile') {
    const profile = await read(state.root, 'profile.json');
    profile.profile.name = 'CHANGED'; profile.metadata.revision = (profile.metadata.revision ?? 1) + 1;
    await writeFile(join(state.root, 'profile.json'), JSON.stringify(profile), { mode: 0o600 });
    grants = new Map([[valueRef, { ...grants.get(valueRef), profileRevision: String(profile.metadata.revision) }]]);
  } else {
    await answers.update('answer.fixture', fromJSON({ value: 'CHANGED' }), 1n);
    grants = new Map([[valueRef, { ...grants.get(valueRef), answerRevision: '2' }]]);
  }
  state.clock.now = '2026-10-10T12:06:00Z';
  const authorization = await state.authority.set(fromJSON({ mode: 'autofill_to_review', runId: state.run.runId,
    jobIds: ['job'], sensitiveAnswerRefs: [], durationMinutes: 60 }), BigInt(state.authorization.revision));
  state.authorization = JSON.parse(serialize(authorization));
  ports = host(state, { adapter, grants, controls });
  const recover = event('recover', original, { operationId: 'rebind-recovery' });
  ports.host.approvals.approve((await ports.host.review(recover)).binding, 300000);
  const current = (await ports.model.event(recover)).receipt.task;
  assert.equal((await state.adapter.readback(stored.request)).effect, 'matches');
  await unchanged(state, () => ports.model.reconcile(binding(state, current), request.operationId), /authority_denied/);
  const next = await proposal(ports, state, current, { operationId: 'still-blocked', valueRef });
  await unchanged(state, () => ports.model.execute(next), /reconciliation_required/);
  assert.equal(state.adapter.calls.writes, 1);
});
