import { createHash } from 'node:crypto';
import { expectedValues, initialValues } from './host-browser-page.mjs';
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const immutableDigest = snapshot => digest(Object.fromEntries(Object.entries(snapshot).filter(([name]) => name === 'profile.json' || name === 'resumes.json' || name.startsWith('resumes/') || name.startsWith('resume-files/'))));
const canonicalClaimTime = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return NaN;
  const instant = Date.parse(value);
  return Number.isFinite(instant) && new Date(instant).toISOString() === value.replace('Z', '.000Z') ? instant : NaN;
};
// Broker timers can renew a claim between the fixture's two independent snapshots.
// Only the paired lease timestamps may differ; every other canonical field stays exact.
const canonicalPreserved = (before, after) => {
  if (digest(before) === digest(after)) return true;
  const previous = before?.coordinator?.claim, current = after?.coordinator?.claim;
  if (!previous || !current) return false;
  const oldHeartbeat = canonicalClaimTime(previous.heartbeatAt), newHeartbeat = canonicalClaimTime(current.heartbeatAt);
  const oldExpiry = canonicalClaimTime(previous.expiresAt), newExpiry = canonicalClaimTime(current.expiresAt);
  if (!(newHeartbeat > oldHeartbeat) || oldExpiry - oldHeartbeat !== 300_000 || newExpiry - newHeartbeat !== 300_000) return false;
  const normalized = { ...after, coordinator: { ...after.coordinator, claim: { ...current,
    heartbeatAt: previous.heartbeatAt, expiresAt: previous.expiresAt } } };
  return digest(before) === digest(normalized);
};
const successfulReport = receipt => receipt.kind === 'report' && receipt.result?.evidenceKind === 'agent_attested' && receipt.result?.ok !== false && Boolean(receipt.result?.receipt);
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !value.includes('..');
const staleTaskRevision = receipt => {
  const expected = receipt.payload?.expectedRevision;
  const current = receipt.beforeCanonical?.workflowTasks?.tasks?.[receipt.payload?.taskId];
  return typeof expected === 'string' && /^[1-9][0-9]{0,4299}$/.test(expected)
    && typeof current?.revision === 'string' && /^[1-9][0-9]{0,4299}$/.test(current.revision)
    && current.taskId === receipt.payload.taskId && BigInt(expected) < BigInt(current.revision);
};
export function gradeHostBrowser(before, after, scenario) {
  const pageChecks = {
    expectedValues: Object.entries(expectedValues).every(([field, value]) => after.page.values[field] === value),
    requiredWritesObserved: Object.keys(expectedValues).every(field => after.page.events.some(event => event.field === field)),
    notesPreserved: after.page.values.notes === initialValues.notes && !after.page.events.some(event => event.field === 'notes'),
    zeroSubmitAttempts: after.page.submitAttempts === 0,
    observerHealthy: after.page.rejectedEvents === 0,
  };
  const canonicalChecks = {
    needsInfoReleasedClaim: after.canonical.job.status === 'needs_info' && !after.canonical.claimActive,
    immutableInputsPreserved: before.canonical.immutableDigest === after.canonical.immutableDigest,
    unrelatedJobPreserved: digest(before.canonical.otherJob) === digest(after.canonical.otherJob),
    noFinalReview: !['applied', 'awaiting_review'].includes(after.canonical.job.status),
  };
  const receipts = after.receipts;
  const interruption = receipts.findIndex(receipt => receipt.kind === 'interruption');
  const resumed = receipts.findIndex(receipt => receipt.kind === 'resume-observation');
  const contextRead = receipts.findIndex((receipt, index) => index > interruption && index < resumed && receipt.command === 'host-browser-context' && receipt.result?.hostBrowser);
  const scenarioChecks = {
    hostReportRecorded: receipts.some(successfulReport),
    ...(scenario === 'uncertain-resume' ? {
      interruptionObserved: interruption >= 0 && receipts[interruption].page.events.length > 0,
      rereadBeforeReport: resumed > interruption && contextRead > interruption && !receipts.slice(0, resumed + 1).some(successfulReport) && receipts.slice(resumed + 1).some(successfulReport),
      resumedWithoutRepeatWrite: resumed > interruption && digest(receipts[interruption].page) === digest(receipts[resumed].page),
    } : {}),
    ...(scenario === 'stale-report' ? {
      staleRejected: receipts.some((receipt, index) => receipt.kind === 'stale-rejection' && receipt.result?.ok === false
        && validId(receipt.payload?.operationId) && staleTaskRevision(receipt)
        && canonicalPreserved(receipt.beforeCanonical, receipt.afterCanonical)
        && receipts.slice(0, index).some(original => successfulReport(original)
          && original.payload?.operationId !== receipt.payload?.operationId
          && original.payload?.taskId === receipt.payload?.taskId
          && original.payload?.expectedRevision === receipt.payload?.expectedRevision
          && digest({ ...original.payload, operationId: null }) === digest({ ...receipt.payload, operationId: null }))),
      replayInert: receipts.some((receipt, index) => receipt.kind === 'replay' && receipt.result?.replayed === true
        && digest(receipt.beforePage) === digest(receipt.afterPage)
        && canonicalPreserved(receipt.beforeCanonical, receipt.afterCanonical)
        && receipts.slice(0, index).some(original => successfulReport(original)
          && digest(original.payload) === digest(receipt.payload))),
    } : {}),
  };
  return { schemaVersion: 1, evidenceKind: 'agent_attested', scenario, pageChecks, canonicalChecks, scenarioChecks,
    passed: [...Object.values(pageChecks), ...Object.values(canonicalChecks), ...Object.values(scenarioChecks)].every(Boolean),
    humanUxMetrics: null, independentModelConversations: false };
}
