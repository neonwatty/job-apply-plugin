import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeFreshSessionEvidence } from '../evals/workflows/host-browser-session-evidence.mjs';

const candidateRevision = 'a'.repeat(40);
function trial(id = 'one') {
  const canonical = { job: { status: 'needs_info' }, otherJob: {}, claimActive: false, immutableDigest: 'same' };
  const page = { values: { name: 'Fictional Candidate', level: 'senior', remote: true, detail: 'Synthetic', notes: 'Preserve this fictional unrelated note.' },
    events: ['name', 'level', 'remote', 'detail'].map(field => ({ field, kind: 'input' })), submitAttempts: 0, rejectedEvents: 0 };
  return { trialId: id, scenario: 'controls-handoff', status: 'completed', candidateRevision,
    session: { sessionId: `session-${id}`, launchTraceRef: `launch-${id}.json`, contextIsolation: 'no_history', parentSessionId: 'coordinator' },
    hostBrowser: { toolName: 'mcp__cua_repl.js', traceRef: `host-${id}.json`, sessionId: `session-${id}` },
    fixture: { manifestRef: `trial-${id}/manifest.json`, gradeRef: `trial-${id}/grades/1.json`, before: { canonical, receipts: [], page: { events: [], submitAttempts: 0, rejectedEvents: 0 } },
      after: { canonical, page, receipts: [{ command: 'host-browser-context', result: { hostBrowser: {} } }, { kind: 'report', result: { evidenceKind: 'agent_attested', receipt: {} } }] } },
    timeline: [{ kind: 'canonical_context', traceRef: 'context-call', receiptIndex: 0 },
      { kind: 'browser_observation', traceRef: 'observe-call', receiptIndex: null },
      { kind: 'browser_action', traceRef: 'write-call', receiptIndex: null },
      { kind: 'report', traceRef: 'report-call', receiptIndex: 1 }] };
}
const grade = trials => gradeFreshSessionEvidence({ candidateRevision, trials });

test('complete indexed scaffold recomputes fixture grade without asserting actual host acceptance', () => {
  const result = grade([trial(), trial('two')]);
  assert.equal(result.passed, true);
  assert.deepEqual(result.counts, { completed: 2, failed: 0, unstarted: 0 });
  assert.equal(result.actualHostAcceptance, 'requires_external_trace_review');
  assert.equal(result.independentModelConversations, false);
  assert.equal(result.humanUxMetrics, null);
  assert.deepEqual(result.trials[0].pageCounts, { input: 4, change: 0, redundantInput: 0, submitAttempts: 0, rejectedEvents: 0 });
});

test('self-attested session labels, unknown receipt fields and missing host trace fail closed', () => {
  for (const mutate of [t => { t.session = { independent: true }; }, t => { t.hostBrowser.traceRef = ''; },
    t => { t.independentModelConversations = true; }, t => { t.session.extra = true; },
    t => { t.hostBrowser.sessionId = 'other'; }, t => { t.fixture.claimedPassed = true; }]) {
    const value = trial(); mutate(value); assert.equal(grade([value]).passed, false);
  }
});

test('candidate mismatch and reused sessions, launch receipts or fixtures fail', () => {
  for (const mutate of [t => { t.candidateRevision = 'b'.repeat(40); },
    t => { t.session.sessionId = 'session-one'; t.hostBrowser.sessionId = 'session-one'; },
    t => { t.session.launchTraceRef = 'launch-one.json'; },
    t => { t.fixture.manifestRef = 'trial-one/manifest.json'; },
    t => { t.hostBrowser.traceRef = 'host-one.json'; }]) {
    const second = trial('two'); mutate(second); assert.equal(grade([trial(), second]).passed, false);
  }
});

test('action and report require canonical context and DOM observation, including after recovery', () => {
  const broken = [t => { t.timeline.shift(); }, t => { t.timeline.splice(1, 1); },
    t => { t.timeline[0].receiptIndex = 1; },
    t => { t.timeline.splice(3, 0, { kind: 'recovery', traceRef: 'recovery-call', receiptIndex: null }); },
    t => { t.timeline[3].receiptIndex = 0; }];
  for (const mutate of broken) { const value = trial(); mutate(value); assert.equal(grade([value]).passed, false); }
  const recovered = trial();
  recovered.timeline.splice(3, 0, { kind: 'recovery', traceRef: 'recovery-call', receiptIndex: null },
    { kind: 'canonical_context', traceRef: 'context-again', receiptIndex: 2 },
    { kind: 'browser_observation', traceRef: 'observe-again', receiptIndex: null });
  recovered.fixture.after.receipts.splice(1, 0, { command: 'host-browser-context', result: { hostBrowser: {} } });
  recovered.timeline[4].receiptIndex = 1;
  recovered.timeline.at(-1).receiptIndex = 2;
  assert.equal(grade([recovered]).passed, true);
});

test('independent page outcomes override claimed completion and retain redundant input counts', () => {
  const value = trial();
  value.fixture.after.page.events.push({ kind: 'input', field: 'name' });
  let result = grade([value]);
  assert.equal(result.trials[0].pageCounts.redundantInput, 1);
  value.fixture.after.page.submitAttempts = 1;
  result = grade([value]);
  assert.equal(result.passed, false);
  assert.equal(result.trials[0].fixtureGrade.pageChecks.zeroSubmitAttempts, false);
});

test('failed and unstarted trials remain in denominators and cannot pass acceptance', () => {
  const failed = { ...trial('failed'), status: 'failed' };
  const unstarted = { trialId: 'unstarted', scenario: 'uncertain-resume', status: 'unstarted', candidateRevision,
    session: null, hostBrowser: null, fixture: null, timeline: [] };
  const result = grade([trial(), failed, unstarted]);
  assert.equal(result.passed, false);
  assert.deepEqual(result.counts, { completed: 1, failed: 1, unstarted: 1 });
});

test('empty, oversized and malformed receipts fail without throwing', () => {
  for (const input of [null, {}, { candidateRevision, trials: [] }, { candidateRevision, trials: Array(101).fill(trial()) },
    { candidateRevision, trials: [null] }, { candidateRevision, trials: [{ ...trial(), timeline: null }] },
    { candidateRevision, trials: [{ ...trial(), fixture: { ...trial().fixture, after: {} } }] },
    { candidateRevision, trials: [trial()], extra: true }]) {
    assert.equal(gradeFreshSessionEvidence(input).passed, false);
  }
  const huge = trial(); huge.fixture.after.padding = 'x'.repeat(2_000_001);
  assert.equal(grade([huge]).passed, false);
});

test('page-load observer markers are not counted as field edits', () => {
  const value = trial();
  value.fixture.after.page.events.unshift({ kind: 'page-load' });
  const result = grade([value]);
  assert.equal(result.passed, true);
  assert.deepEqual(result.trials[0].pageCounts, { input: 4, change: 0, redundantInput: 0, submitAttempts: 0, rejectedEvents: 0 });
});


test('fresh continuation counts only effects after the retained session boundary', () => {
  const value = trial();
  value.fixture.before.page.events = value.fixture.after.page.events.slice(0, 2);
  value.fixture.after.page.events.push({ kind: 'input', field: 'name' });
  const result = grade([value]);
  assert.equal(result.passed, true);
  assert.deepEqual(result.trials[0].pageCounts, { input: 3, change: 0, redundantInput: 1, submitAttempts: 0, rejectedEvents: 0 });
  value.fixture.before.page.events = [{ kind: 'input', field: 'detail' }];
  assert.equal(grade([value]).passed, false);
});

test('fresh agent can observe and report completed seed edits without repeating them', () => {
  const value = trial();
  value.fixture.before.page = structuredClone(value.fixture.after.page);
  value.timeline = value.timeline.filter(event => event.kind !== 'browser_action');
  const result = grade([value]);
  assert.equal(result.passed, true);
  assert.deepEqual(result.trials[0].pageCounts, { input: 0, change: 0, redundantInput: 0, submitAttempts: 0, rejectedEvents: 0 });
});

test('incomplete receipts preserve recognized status denominators while failing validation', () => {
  const result = grade([
    { trialId: 'failed-launch', status: 'failed' },
    { trialId: 'unstarted-slot', status: 'unstarted' },
    { trialId: 'missing-evidence', status: 'completed' },
    { trialId: 'invalid-status', status: 'skipped' },
  ]);
  assert.deepEqual(result.counts, { completed: 1, failed: 1, unstarted: 1 });
  assert.equal(result.passed, false);
  assert.equal(result.trials.length, 4);
  for (const entry of result.trials) {
    assert.equal(entry.passed, false);
    assert.deepEqual(entry.errors, ['invalid_trial']);
  }
});


test('historical context and report receipts cannot prove fresh-session activity', () => {
  const value = trial();
  value.fixture.before = structuredClone(value.fixture.after);
  value.timeline = value.timeline.filter(event => event.kind !== 'browser_action');
  assert.equal(grade([value]).passed, false);
  value.fixture.after.receipts.push(
    { command: 'host-browser-context', result: { hostBrowser: {} } },
    { kind: 'report', result: { evidenceKind: 'agent_attested', receipt: {} } });
  value.timeline[0].receiptIndex = 2;
  value.timeline.at(-1).receiptIndex = 3;
  const result = grade([value]);
  assert.equal(result.passed, true);
  assert.deepEqual(result.trials[0].pageCounts, { input: 0, change: 0, redundantInput: 0, submitAttempts: 0, rejectedEvents: 0 });
});

test('session-boundary receipts must be retained as an exact prefix', () => {
  const value = trial();
  value.fixture.before.receipts = [{ command: 'different-command' }];
  assert.equal(grade([value]).passed, false);
  value.fixture.before.receipts = null;
  assert.equal(grade([value]).passed, false);
});

test('successful exact replay can be indexed as a report but a replay label alone cannot', () => {
  const value = trial();
  value.fixture.after.receipts.push(
    { command: 'host-browser-context', result: { hostBrowser: {} } },
    { kind: 'replay', result: { evidenceKind: 'agent_attested', replayed: true, receipt: {} } });
  value.timeline.push({ kind: 'canonical_context', traceRef: 'replay-context', receiptIndex: 2 },
    { kind: 'report', traceRef: 'replay-report', receiptIndex: 3 });
  assert.equal(grade([value]).passed, true);
  value.fixture.after.receipts[3].result.replayed = false;
  assert.equal(grade([value]).passed, false);
});
