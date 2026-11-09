import assert from 'node:assert/strict';
import test from 'node:test';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';
import { ReplayTransitionService } from '../runtime/workspace-core/replay-transition.js';

const plain = value => JSON.parse(serialize(value));
const answers = fromJSON({ schemaVersion: 1, metadata: { revision: 1, updatedAt: '2026-09-10T00:00:00Z' }, answers: {}, redirects: {} });
function repository() {
  const events = [], sessions = new Map();
  return { events, sessions, replayTransitionTransaction: operation => operation({
    history: async () => events,
    appendHistory: async event => { events.push(event); },
    loadSession: async id => sessions.get(id) ?? null,
    saveSession: async (id, session) => { sessions.set(id, session); },
    answers: async () => answers,
  }) };
}

test('replay transitions preserve ordering, repair history-only writes, and remain value-free', async () => {
  const state = repository(), replay = new ReplayTransitionService(state, () => '2026-09-10T00:00:00Z', () => 'event-id');
  for (const [index, ats] of ['ashby', 'greenhouse', 'lever', 'linkedin-easy-apply'].entries()) {
    const id = `job-${index}`;
    assert.deepEqual(plain(await replay.record(id, 'started', ats)), { applicationId: id, transition: 'started', changed: true });
    assert.deepEqual(plain(await replay.record(id, 'reviewed', ats)), { applicationId: id, transition: 'reviewed', changed: true });
    assert.deepEqual(plain(await replay.record(id, 'started', ats)), { applicationId: id, transition: 'started', changed: false });
    assert.equal(plain(state.sessions.get(id)).status, 'review');
  }
  state.events.push(fromJSON({ schemaVersion: 1, eventId: 'interrupted', applicationId: 'repair', event: 'started', ats: 'ashby', status: 'active', answerKeys: [], at: '2026-09-10T00:00:00Z' }));
  assert.deepEqual(plain(await replay.record('repair', 'started', 'ashby')), { applicationId: 'repair', transition: 'started', changed: false });
  assert.equal(plain(state.sessions.get('repair')).status, 'active');
  assert.deepEqual(Object.keys(plain(state.sessions.get('repair'))).sort(), [
    'answerKeys', 'applicationId', 'approvals', 'ats', 'attemptRevision', 'blockers', 'browserHandoff', 'createdAt',
    'pendingFields', 'readiness', 'schemaVersion', 'status', 'step', 'updatedAt',
  ]);
  await assert.rejects(replay.record('missing', 'reviewed', 'ashby'), /has not started/);
  await assert.rejects(replay.record('job-0', 'started', 'lever'), /ATS does not match/);
  state.events.push(fromJSON({ schemaVersion: 1, eventId: 'terminal', applicationId: 'terminal', event: 'completed', ats: 'ashby', status: 'done', answerKeys: [], at: '2026-09-10T00:00:00Z' }));
  await assert.rejects(replay.record('terminal', 'started', 'ashby'), /is terminal/);
});
