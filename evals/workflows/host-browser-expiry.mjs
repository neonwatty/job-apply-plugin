import { isDeepStrictEqual as equal } from 'node:util';
import { gradeHostBrowser } from './host-browser-grade.mjs';

export const expiryScenarios = ['broker-expiry-recovery'];
const fail = message => { throw Object.assign(Error(message), { status: 400 }); };
const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ? Date.parse(value) : NaN;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !value.includes('..');
const lossIn = receipts => receipts.findLast(receipt => receipt.kind === 'broker-restart');
const claimOf = canonical => canonical?.coordinator?.claim;
const expiredContext = receipt => receipt.command === 'host-browser-context' && receipt.result?.hostBrowser
  && receipt.result?.guidance?.claim?.state === 'expired'
  && receipt.result.guidance.actions?.some(action => action.kind === 'recover' && action.requiresExplicitUserEvent === true)
  && receipt.result.guidance.actions.every(action => action.kind === 'recover');

/** Server time only: no caller-supplied clock or Store mutation is accepted. */
export function expiryCheckpoint(input, receipts, snapshot) {
  if (!input || Array.isArray(input) || Object.keys(input).length !== 1 || input.kind !== 'claim-expired') fail('invalid_checkpoint');
  const loss = lossIn(receipts), index = receipts.indexOf(loss);
  if (!loss || loss.status !== 'completed') fail('broker_loss_required');
  const claim = claimOf(loss.afterCanonical), observedAt = new Date().toISOString();
  if (!claim || !equal(loss.beforeCanonical, loss.afterCanonical)
    || !equal(loss.afterCanonical, snapshot.canonical)) fail('original_claim_required');
  if (!(instant(observedAt) >= instant(claim.expiresAt))) fail('claim_not_expired');
  if (!receipts.slice(index + 1).some(expiredContext)) fail('expired_context_required');
  return { kind: input.kind, sequence: receipts.length + 1, lossSequence: loss.sequence,
    evidenceKind: 'fixture_clock', observedAt, ...structuredClone(snapshot) };
}

// Heartbeat may advance after recovery; other canonical fields must remain exact.
function preserved(before, after) {
  if (equal(before, after)) return true;
  const old = claimOf(before), next = claimOf(after);
  if (!old || !next || !(instant(next.heartbeatAt) > instant(old.heartbeatAt))
    || instant(old.expiresAt) - instant(old.heartbeatAt) !== 300000
    || instant(next.expiresAt) - instant(next.heartbeatAt) !== 300000) return false;
  const normalized = structuredClone(after);
  normalized.coordinator.claim.heartbeatAt = old.heartbeatAt;
  normalized.coordinator.claim.expiresAt = old.expiresAt;
  return equal(before, normalized);
}
const taskOf = (canonical, id) => canonical?.workflowTasks?.tasks?.[id];
const success = receipt => receipt?.command === 'host-browser-report' && receipt.result?.receipt && receipt.result.ok !== false;
const rejected = receipt => receipt?.command === 'host-browser-report' && receipt.result?.ok === false
  && receipt.result.error === 'request_rejected' && preserved(receipt.beforeCanonical, receipt.afterCanonical)
  && equal(receipt.beforePage, receipt.afterPage);
const oldReport = (receipt, contexts, canonical) => {
  const task = taskOf(canonical, receipt.payload?.taskId);
  return Boolean(task) && receipt.payload.expectedRevision === task.revision
    && receipt.payload.jobId === task.subject?.jobId && receipt.payload.jobRevision === task.subject?.jobRevision
    && validId(receipt.payload?.operationId) && contexts.some(context =>
  context.command === 'host-browser-context' && context.result?.guidance?.actions?.some(action => {
    if (action.kind !== 'progress') return false;
    const { kind, ...input } = action.input;
    return equal(receipt.payload, { ...input, operationId: receipt.payload.operationId, evidenceKind: 'agent_attested', outcome: 'progress' });
  }));
};
const validObservation = (receipt, loss) => receipt.kind === 'recovery-observation' && receipt.lossSequence === loss?.sequence
  && receipt.evidenceKind === 'agent_attested' && receipt.evidence?.source === 'native_host_browser'
  && receipt.evidence?.title === 'Fictional host browser acceptance'
  && /^http:\/\/127\.0\.0\.1:[0-9]+\/$/.test(receipt.evidence?.url ?? '')
  && Boolean(receipt.page) && equal(receipt.evidence.values, receipt.page.values);

export function gradeHostBrowserExpiry(before, after) {
  const base = gradeHostBrowser(before, after, 'controls-handoff'), receipts = after.receipts;
  const loss = lossIn(receipts), lossIndex = receipts.indexOf(loss), claim = claimOf(loss?.beforeCanonical);
  const expiry = instant(claim?.expiresAt);
  const expiredIndex = receipts.findIndex((receipt, index) => index > lossIndex && receipt.kind === 'claim-expired');
  const expired = receipts[expiredIndex];
  const liveIndex = receipts.findIndex((receipt, index) => index > lossIndex && index < expiredIndex
    && rejected(receipt) && oldReport(receipt, receipts.slice(0, lossIndex), loss?.beforeCanonical)
    && instant(receipt.beforeAt) >= instant(loss?.afterAt) && instant(receipt.afterAt) >= instant(receipt.beforeAt)
    && instant(receipt.afterAt) < expiry && equal(receipt.beforeCanonical, loss?.afterCanonical));
  const recoverIndex = receipts.findIndex((receipt, index) => index > expiredIndex && receipt.kind === 'authorized-event'
    && receipt.command === 'event' && receipt.payload?.kind === 'recover' && receipt.result?.receipt && receipt.result.ok !== false);
  const recover = receipts[recoverIndex], id = recover?.payload?.taskId;
  const originalTask = taskOf(loss?.beforeCanonical, id), recoveredTask = taskOf(recover?.afterCanonical, id);
  const contextIndex = receipts.findIndex((receipt, index) => index > recoverIndex && receipt.command === 'host-browser-context' && receipt.result?.hostBrowser);
  const observationIndex = receipts.findIndex((receipt, index) => index > contextIndex && validObservation(receipt, loss));
  const oldIndex = receipts.findIndex((receipt, index) => index > observationIndex && index > recoverIndex && rejected(receipt)
    && liveIndex >= 0 && equal(receipt.payload, receipts[liveIndex].payload));
  const handoffIndex = receipts.findIndex((receipt, index) => index > oldIndex && index > observationIndex && success(receipt)
    && receipt.payload?.outcome === 'needs_info' && receipt.payload.taskId === id
    && receipt.payload.expectedRevision === recoveredTask?.revision
    && receipt.payload.session?.handoffChecklist?.includes('resume_upload'));
  const recoveryChecks = {
    ownedBrokerReplaced: lossIndex >= 0 && loss.status === 'completed' && loss.evidenceKind === 'fixture_owned_process'
      && ['SIGKILL', 'SIGTERM'].includes(loss.signal) && Number.isInteger(loss.oldPid) && loss.oldPid > 0
      && Number.isInteger(loss.newPid) && loss.newPid > 0 && loss.oldPid !== loss.newPid,
    originalLeasePreserved: Boolean(claim) && instant(claim.expiresAt) - instant(claim.heartbeatAt) === 300000
      && instant(loss?.beforeAt) < expiry && instant(loss?.afterAt) >= instant(loss?.beforeAt)
      && loss.beforeDurableDigest && loss.beforeDurableDigest === loss.afterDurableDigest
      && equal(loss.beforeCanonical, loss.afterCanonical) && equal(loss.beforePage, loss.afterPage),
    liveProgressRejected: liveIndex > lossIndex,
    genuineExpiryObserved: expiredIndex > liveIndex && expired?.evidenceKind === 'fixture_clock'
      && expired.lossSequence === loss?.sequence && instant(expired.observedAt) >= expiry
      && equal(expired.canonical, loss?.afterCanonical)
      && receipts.slice(lossIndex + 1, expiredIndex).some(expiredContext),
    explicitRecovery: recoverIndex > expiredIndex && recover?.authorizationEvidence === 'host_attested'
      && validId(recover.payload.operationId) && instant(recover.beforeAt) >= instant(expired?.observedAt)
      && instant(recover.afterAt) >= instant(recover.beforeAt)
      && equal(recover.beforeCanonical, expired?.canonical)
      && receipts.slice(lossIndex + 1, recoverIndex).some(receipt => expiredContext(receipt)
        && receipt.result.guidance.actions.some(action => equal(recover.payload, { ...action.input, operationId: recover.payload.operationId }))),
    originalTaskInputsPreserved: Boolean(originalTask && recoveredTask) && recoveredTask.taskId === originalTask.taskId
      && recoveredTask.subject?.jobId === originalTask.subject?.jobId
      && typeof originalTask.subject?.inputRevision === 'string' && recoveredTask.subject?.inputRevision === originalTask.subject.inputRevision
      && /^[1-9][0-9]*$/.test(recoveredTask?.revision ?? '') && /^[1-9][0-9]*$/.test(originalTask?.revision ?? '')
      && BigInt(recoveredTask.revision) > BigInt(originalTask.revision)
      && recover?.payload?.expectedRevision === originalTask.revision
      && equal(recover?.result?.receipt?.task, recoveredTask),
    replacementClaimAcquired: Boolean(claimOf(recover?.afterCanonical))
      && claimOf(recover?.afterCanonical)?.tokenHash !== claim?.tokenHash,
    freshContextAndObservation: recoverIndex >= 0 && contextIndex > recoverIndex && observationIndex > contextIndex,
    oldReportRejectedAfterRecovery: oldIndex > observationIndex && oldIndex > recoverIndex,
    safeHandoffAfterRejection: handoffIndex > oldIndex && oldIndex >= 0,
    originalFactsAndRecordsPreserved: Boolean(before.canonical.sourceFacts)
      && [after.canonical, ...receipts.flatMap(receipt => [receipt.canonical, receipt.beforeCanonical, receipt.afterCanonical].filter(Boolean))]
        .every(canonical => equal(canonical.sourceFacts, before.canonical.sourceFacts)
          && canonical.immutableDigest === before.canonical.immutableDigest && equal(canonical.otherJob, before.canonical.otherJob)),
    noRepeatedBrowserWrites: Boolean(loss?.beforePage) && equal(loss.beforePage, after.page)
      && receipts.slice(lossIndex + 1).every(receipt => ['page', 'beforePage', 'afterPage'].every(key => !receipt[key] || equal(receipt[key], loss.beforePage))),
    noUnexpectedReports: receipts.every((receipt, index) => !success(receipt) || index === handoffIndex),
  };
  return { ...base, scenario: expiryScenarios[0], recoveryChecks, recoveryOutcome: 'recovered_needs_info',
    passed: [...Object.values(base.pageChecks), ...Object.values(base.canonicalChecks), ...Object.values(base.scenarioChecks), ...Object.values(recoveryChecks)].every(Boolean),
    evidenceLimitations: ['Browser observations remain agent attestations requiring the native host transcript.',
      'Synthetic grader tests do not demonstrate real elapsed lease time. Actual trials use unchanged production leases and fixture server timestamps.'] };
}
