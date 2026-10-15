import { atsRecovery as preview } from '../../runtime/workflows/applications/ats-recovery-policy.js';
const invalid = () => { throw Error('invalid ATS recovery input'); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
/** Advisory preview only. Owner retry actions require a durable broker reservation. */
export function atsRecovery(evidence, budget) {
  try { return preview(evidence, budget); } catch { return invalid(); }
}

/** Local observation labels are independent; page advancement is not a receipt. */
export function applicationProgress(evidence) {
  if (!exact(evidence, ['entered', 'verified', 'pageAdvanced', 'persistenceConfirmed'])
    || Object.values(evidence).some(v => typeof v !== 'boolean')
    || (evidence.verified && !evidence.entered)) invalid();
  return {...evidence, persistence: evidence.persistenceConfirmed ? 'confirmed' : 'unknown',
    manualReviewReady: false, finalSubmissionAllowed: false};
}

/** Batch outstanding decisions from the whole visible page, without values.
 * Indices refer only to the current ephemeral inventory; never persist them as IDs.
 */
export function questionBatch(fields, ownsClaim) {
  if (!Array.isArray(fields) || fields.length > 200 || typeof ownsClaim !== 'boolean'
    || fields.some(f => !exact(f, ['required', 'state']) || typeof f.required !== 'boolean'
      || !['approved', 'missing', 'consent', 'unsupported'].includes(f.state))) invalid();
  const unresolved = fields.flatMap((f, index) => f.state === 'approved' ? [] : [{index, ...f}]);
  return {next: unresolved.some(f => f.required)
    ? (ownsClaim ? 'guarded_needs_info_then_ask_batch' : 'ask_batch_before_acquire')
    : 'continue_with_approved_fields', unresolved,
    finalSubmissionAllowed: false};
}
