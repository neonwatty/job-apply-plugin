import { isDeepStrictEqual as equal } from 'node:util';
import { durableSnapshot, readDocument } from '../../tests_js/workspace_installed_workflows_support.mjs';
import { digest, gradeHostBrowser, canonicalPreserved } from './host-browser-grade.mjs';

export const driftScenarios = ['source-input-drift'];
const candidate = { name: 'Fictional Candidate', skills: ['Synthetic', 'Fixture source revision'] };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = message => { throw Object.assign(Error(message), { status: 400 }); };
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !value.includes('..');
const latestDrift = receipts => receipts.findLast(receipt => receipt.kind === 'source-input-drift');
const successful = receipt => receipt.command === 'host-browser-report' && receipt.result?.receipt && receipt.result?.ok !== false;
const fileDigests = snapshot => Object.fromEntries(Object.entries(snapshot).map(([name, bytes]) => [name, digest(bytes)]));
export function validateDriftInjection(input) {
  if (!exact(input, ['kind']) || input.kind !== 'source-input-drift') fail('invalid_injection');
}

/** All inputs, paths, and revisions come from the isolated fixture, never the caller. */
export async function injectSourceInputDrift(state) {
  const beforeFacts = await readDocument(state.root, 'resume-facts.json');
  const resumes = await readDocument(state.root, 'resumes.json');
  const source = resumes.resumes.source, latest = beforeFacts.sets.source.versions.at(-1);
  if (latest.state !== 'confirmed') fail('confirmed_source_required');
  const beforeSnapshot = await durableSnapshot(state.root);
  const beforeDurableDigests = fileDigests(beforeSnapshot);
  const mutation = { surface: 'store', command: 'resume-facts-draft', resumeId: 'source',
    expectedResumeRevision: String(source.revision), expectedFactRevision: String(latest.revision), candidate: structuredClone(candidate) };
  const result = await state.call('store', ['resume-facts-draft'], mutation.candidate,
    ['--resume-id', 'source', '--expected-resume-revision', mutation.expectedResumeRevision,
      '--expected-fact-revision', mutation.expectedFactRevision]);
  const afterSnapshot = await durableSnapshot(state.root);
  return { mutation, result, beforeFacts, afterFacts: await readDocument(state.root, 'resume-facts.json'),
    beforeDurableDigests, afterDurableDigests: fileDigests(afterSnapshot),
    beforeCoordinatorBytes: beforeSnapshot['coordinator.json'], afterCoordinatorBytes: afterSnapshot['coordinator.json'] };
}
function driftContext(receipt) {
  const result = receipt?.result;
  return receipt?.command === 'host-browser-context' && result?.hostBrowser
    && result.guidance?.selection?.inputsCurrent === false
    && !result.guidance.actions.some(action => action.kind === 'progress')
    && result.guidance.actions.some(action => action.kind === 'handoff' && action.input.status === 'needs_info');
}
function observed(receipt, drift, url) {
  const evidence = receipt?.evidence;
  return receipt?.kind === 'drift-observation' && receipt.driftSequence === drift?.sequence
    && receipt.evidenceKind === 'agent_attested'
    && exact(evidence, ['source', 'url', 'title', 'values']) && evidence.source === 'native_host_browser'
    && (url === undefined ? /^http:\/\/127\.0\.0\.1:[0-9]+\/$/.test(evidence.url) : evidence.url === url)
    && evidence.title === 'Fictional host browser acceptance' && equal(evidence.values, receipt.page?.values);
}
export function driftCheckpoint(input, receipts, snapshot, url) {
  if (!exact(input, ['kind', 'driftSequence', 'evidence']) || input.kind !== 'drift-observation') fail('invalid_checkpoint');
  const drift = latestDrift(receipts), index = receipts.indexOf(drift);
  if (!drift || drift.status !== 'completed' || input.driftSequence !== drift.sequence) fail('invalid_drift_sequence');
  if (!receipts.slice(index + 1).some(driftContext)) fail('fresh_context_required');
  const receipt = { ...input, sequence: receipts.length + 1, evidenceKind: 'agent_attested', ...snapshot };
  if (!observed(receipt, drift, url)) fail('invalid_observation');
  return receipt;
}
export function driftReportNeedsObservation(input, receipts) {
  if (input.command !== 'host-browser-report') return false;
  const drift = latestDrift(receipts);
  if (!drift) return false;
  if (receipts.some(receipt => successful(receipt) && equal(receipt.payload, input.payload))) return false;
  return !receipts.slice(receipts.indexOf(drift) + 1).some(receipt => observed(receipt, drift));
}
function preservedFacts(drift) {
  const before = drift?.beforeFacts, after = drift?.afterFacts;
  const previous = before?.sets?.source?.versions, current = after?.sets?.source?.versions;
  if (!Array.isArray(previous) || !previous.length || !Array.isArray(current) || current.length !== previous.length + 1) return false;
  const old = previous.at(-1), added = current.at(-1);
  return old.state === 'confirmed' && equal(previous, current.slice(0, -1)) && added.state === 'draft'
    && added.revision === old.revision + 1 && added.contentRevision === old.contentRevision
    && added.confirmedAt === null && equal(added.facts, candidate)
    && equal({ ...before.sets, source: null }, { ...after.sets, source: null })
    && equal({ ...before.sets.source, versions: null }, { ...after.sets.source, versions: null });
}
function validHeartbeatDelta(drift) {
  try {
    const beforeBytes = drift.beforeCoordinatorBytes, afterBytes = drift.afterCoordinatorBytes;
    if (typeof beforeBytes !== 'string' || typeof afterBytes !== 'string'
      || digest(beforeBytes) !== drift.beforeDurableDigests['coordinator.json']
      || digest(afterBytes) !== drift.afterDurableDigests['coordinator.json']) return false;
    const decode = bytes => JSON.parse(Buffer.from(bytes, 'base64').toString('utf8'));
    return canonicalPreserved({ coordinator: decode(beforeBytes) }, { coordinator: decode(afterBytes) });
  } catch { return false; }
}
function onlyFactsChanged(drift) {
  const before = drift?.beforeDurableDigests, after = drift?.afterDurableDigests;
  return Boolean(before && after) && equal(Object.keys(before).sort(), Object.keys(after).sort())
    && typeof before['resume-facts.json'] === 'string' && before['resume-facts.json'] !== after['resume-facts.json']
    && Object.entries(before).every(([name, hash]) => name === 'resume-facts.json' || hash === after[name]
      || name === 'coordinator.json' && validHeartbeatDelta(drift));
}
function matchesAction(payload, receipt, outcome) {
  const actionKind = outcome === 'progress' ? 'progress' : 'handoff';
  return validId(payload?.operationId) && receipt?.command === 'host-browser-context'
    && receipt.result?.guidance?.actions?.some(action => {
      if (action.kind !== actionKind) return false;
      const { kind, status, ...input } = action.input;
      return equal(payload, { ...input, operationId: payload.operationId, evidenceKind: 'agent_attested', outcome });
    });
}
export function gradeHostBrowserDrift(before, after, scenario) {
  const base = gradeHostBrowser(before, after, 'controls-handoff');
  const receipts = after.receipts, drift = latestDrift(receipts), index = receipts.indexOf(drift);
  const observationIndex = receipts.findIndex((receipt, i) => i > index && observed(receipt, drift));
  const contextIndex = receipts.findIndex((receipt, i) => i > index && i < observationIndex && driftContext(receipt));
  const rejectionIndex = receipts.findIndex((receipt, i) => i > observationIndex && observationIndex >= 0
    && receipt.command === 'host-browser-report' && receipt.result?.ok === false && receipt.result?.error === 'request_rejected'
    && canonicalPreserved(receipt.beforeCanonical, receipt.afterCanonical) && equal(receipt.beforePage, receipt.afterPage)
    && !receipts.slice(0, index).some(prior => prior.payload?.operationId === receipt.payload?.operationId)
    && receipts.slice(0, index).some(context => matchesAction(receipt.payload, context, 'progress')));
  const handoffIndex = receipts.findIndex((receipt, i) => i > rejectionIndex && rejectionIndex >= 0 && successful(receipt)
    && !receipt.result.replayed && receipt.result.receipt.outcome === 'needs_info'
    && receipts.slice(index + 1, i).some(context => driftContext(context) && matchesAction(receipt.payload, context, 'needs_info')));
  const driftChecks = {
    supportedMutation: scenario === 'source-input-drift' && drift?.status === 'completed'
      && drift.evidenceKind === 'fixture_supported_store_api' && drift.mutation?.surface === 'store'
      && drift.mutation.command === 'resume-facts-draft' && drift.mutation.resumeId === 'source'
      && equal(drift.mutation.candidate, candidate) && drift.result?.state === 'draft' && drift.result?.current === true
      && drift.result.resumeId === 'source'
      && drift.mutation.expectedFactRevision === String(drift.beforeFacts?.sets?.source?.versions?.at(-1)?.revision)
      && drift.result.revision === drift.afterFacts?.sets?.source?.versions?.at(-1)?.revision
      && drift.result.contentRevision === drift.afterFacts?.sets?.source?.versions?.at(-1)?.contentRevision,
    historicalFactsPreserved: preservedFacts(drift),
    onlyFactsFileChanged: onlyFactsChanged(drift),
    canonicalAndDraftPreserved: Boolean(drift?.beforeCanonical && drift?.afterCanonical)
      && canonicalPreserved({ ...drift.beforeCanonical, sourceFacts: null }, { ...drift.afterCanonical, sourceFacts: null })
      && equal(drift.beforePage, drift.afterPage),
    factEvidenceBound: Boolean(drift) && equal(drift.beforeFacts, drift.beforeCanonical?.sourceFacts)
      && equal(drift.afterFacts, drift.afterCanonical?.sourceFacts) && equal(drift.afterFacts, after.canonical.sourceFacts),
    freshContextAndObservation: index >= 0 && contextIndex > index && observationIndex > contextIndex,
    oldValidProgressRejected: rejectionIndex > observationIndex && observationIndex >= 0,
    safeHandoffAfterRejection: handoffIndex > rejectionIndex && rejectionIndex >= 0,
    noProgressAfterDrift: index >= 0 && !receipts.slice(index + 1).some(receipt => successful(receipt)
      && !receipt.result.replayed && receipt.payload?.outcome === 'progress'),
    noPostDriftBrowserWrites: Boolean(drift?.afterPage) && equal(drift.afterPage, after.page),
  };
  return { ...base, scenario, driftChecks, recoveryOutcome: 'completed_handoff',
    passed: base.passed && Object.values(driftChecks).every(Boolean),
    evidenceLimitations: ['DOM observations are agent attestations requiring a native host tool transcript.',
      'Observation gates cover fixture HTTP commands only; direct CLI and arbitrary host tools remain outside enforcement.',
      'The scenario appends fictional resume facts; managed resume bytes and all previous confirmed facts remain unchanged.'] };
}
