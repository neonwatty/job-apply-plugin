import { gradeHostBrowser } from './host-browser-grade.mjs';

const scenarios = new Set(['controls-handoff', 'uncertain-resume', 'stale-report']);
const statuses = new Set(['completed', 'failed', 'unstarted']);
const kinds = new Set(['canonical_context', 'browser_observation', 'browser_action', 'report', 'recovery']);
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 2048;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const closed = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

function checkTimeline(timeline, receipts, previousReceipts) {
  if (!Array.isArray(timeline) || timeline.length === 0 || timeline.length > 1000 || !Array.isArray(receipts)) return false;
  if (!Array.isArray(previousReceipts) || previousReceipts.length > receipts.length
    || previousReceipts.some((receipt, index) => JSON.stringify(receipt) !== JSON.stringify(receipts[index]))) return false;
  let context = false;
  let observation = false;
  let report = false;
  let lastReceipt = previousReceipts.length - 1;
  const traces = new Set();
  for (const event of timeline) {
    if (!closed(event, ['kind', 'traceRef', 'receiptIndex']) || !kinds.has(event.kind) || !text(event.traceRef) || traces.has(event.traceRef)) return false;
    traces.add(event.traceRef);
    if (event.kind === 'canonical_context' || event.kind === 'report') {
      if (!Number.isSafeInteger(event.receiptIndex) || event.receiptIndex <= lastReceipt) return false;
      const receipt = receipts[event.receiptIndex];
      if (!object(receipt)) return false;
      lastReceipt = event.receiptIndex;
      if (event.kind === 'canonical_context') {
        if (receipt.command !== 'host-browser-context' || !object(receipt.result?.hostBrowser) || receipt.result?.ok === false) return false;
        context = true;
      } else {
        if (!context || !observation || receipt.kind !== 'report' || receipt.result?.ok === false || receipt.result?.evidenceKind !== 'agent_attested' || !object(receipt.result?.receipt)) return false;
        report = true;
        // A persisted report may advance the canonical revision.
        context = false;
      }
    } else {
      if (event.receiptIndex !== null) return false;
      if (event.kind === 'recovery') { context = false; observation = false; }
      if (event.kind === 'browser_observation') observation = true;
      if (event.kind === 'browser_action') {
        if (!context || !observation) return false;
      }
    }
  }
  return report;
}

function pageTotals(page) {
  if (!object(page) || !Array.isArray(page.events) || page.events.length > 10000
    || ![page.submitAttempts, page.rejectedEvents].every(value => Number.isSafeInteger(value) && value >= 0)) return null;
  const counts = { input: 0, change: 0, redundantInput: 0, submitAttempts: page.submitAttempts, rejectedEvents: page.rejectedEvents };
  const fields = new Set();
  for (const event of page.events) {
    if (!object(event) || !['input', 'change', 'submit', 'page-load'].includes(event.kind)) return null;
    if (event.kind === 'submit' || event.kind === 'page-load') continue;
    if (!['name', 'level', 'remote', 'detail', 'notes'].includes(event.field)) return null;
    counts[event.kind]++;
    if (event.kind === 'input') {
      if (fields.has(event.field)) counts.redundantInput++;
      fields.add(event.field);
    }
  }
  return counts;
}

function pageCounts(before, after) {
  const start = pageTotals(before);
  const end = pageTotals(after);
  if (!start || !end || before.events.length > after.events.length
    || before.events.some((event, index) => JSON.stringify(event) !== JSON.stringify(after.events[index]))) return null;
  const delta = Object.fromEntries(Object.keys(end).map(key => [key, end[key] - start[key]]));
  return Object.values(delta).every(value => value >= 0) ? delta : null;
}

/** Validate an evidence index, not the authenticity of referenced host artifacts. */
export function gradeFreshSessionEvidence(input) {
  const result = { schemaVersion: 1, evidenceKind: 'fresh_session_evidence_index', passed: false,
    actualHostAcceptance: 'requires_external_trace_review', independentModelConversations: false,
    humanUxMetrics: null, counts: { completed: 0, failed: 0, unstarted: 0 }, trials: [], errors: [] };
  let serialized;
  try { serialized = JSON.stringify(input); } catch { result.errors.push('non_json_input'); return result; }
  if (!serialized || Buffer.byteLength(serialized) > 2_000_000
    || !closed(input, ['candidateRevision', 'trials']) || !sha(input.candidateRevision)
    || !Array.isArray(input.trials) || input.trials.length === 0 || input.trials.length > 100) {
    result.errors.push('invalid_or_unbounded_input');
    return result;
  }
  const unique = new Map();
  const distinct = (kind, value) => {
    if (!text(value)) return false;
    if (!unique.has(kind)) unique.set(kind, new Set());
    const values = unique.get(kind);
    if (values.has(value)) return false;
    values.add(value);
    return true;
  };
  for (const trial of input.trials) {
    const entry = { trialId: text(trial?.trialId) ? trial.trialId : null, passed: false, fixtureGrade: null, pageCounts: null, errors: [] };
    result.trials.push(entry);
    if (statuses.has(trial?.status)) result.counts[trial.status]++;
    if (!closed(trial, ['trialId', 'scenario', 'status', 'candidateRevision', 'session', 'hostBrowser', 'fixture', 'timeline'])
      || !statuses.has(trial.status) || !scenarios.has(trial.scenario)) {
      entry.errors.push('invalid_trial');
      continue;
    }
    if (!distinct('trial', trial.trialId) || trial.candidateRevision !== input.candidateRevision) entry.errors.push('trial_identity_or_candidate');
    if (trial.status === 'unstarted') {
      if (trial.session !== null || trial.hostBrowser !== null || trial.fixture !== null || !Array.isArray(trial.timeline) || trial.timeline.length !== 0) entry.errors.push('unstarted_has_evidence');
      entry.errors.push('unstarted');
      continue;
    }
    const session = trial.session;
    if (!closed(session, ['sessionId', 'launchTraceRef', 'contextIsolation', 'parentSessionId'])
      || session.contextIsolation !== 'no_history' || !text(session.parentSessionId)
      || session.parentSessionId === session.sessionId || !distinct('session', session.sessionId)
      || !distinct('launch', session.launchTraceRef)) entry.errors.push('session_evidence');
    const host = trial.hostBrowser;
    if (!closed(host, ['toolName', 'traceRef', 'sessionId']) || !text(host.toolName)
      || host.sessionId !== session?.sessionId || !distinct('host_trace', host.traceRef)) entry.errors.push('host_evidence');
    const fixture = trial.fixture;
    if (!closed(fixture, ['manifestRef', 'gradeRef', 'before', 'after'])
      || !distinct('manifest', fixture.manifestRef) || !distinct('grade', fixture.gradeRef)) {
      entry.errors.push('fixture_evidence');
    } else {
      entry.pageCounts = pageCounts(fixture.before?.page, fixture.after?.page);
      try { entry.fixtureGrade = gradeHostBrowser(fixture.before, fixture.after, trial.scenario); }
      catch { entry.errors.push('malformed_fixture_snapshots'); }
      if (!entry.pageCounts || entry.fixtureGrade?.passed !== true) entry.errors.push('fixture_failed');
      if (!checkTimeline(trial.timeline, fixture.after?.receipts, fixture.before?.receipts)) entry.errors.push('timeline_evidence');
    }
    if (trial.status !== 'completed') entry.errors.push('failed');
    entry.passed = entry.errors.length === 0;
  }
  result.passed = result.trials.every(trial => trial.passed);
  return result;
}
