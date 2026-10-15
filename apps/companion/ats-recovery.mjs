import { workdayRecovery } from './ats-recovery/workday.mjs';

const choices = {
  ats: ['workday', 'other'],
  draft: ['present', 'missing', 'unknown'],
  observation: ['current', 'stale', 'unknown'],
  session: ['unknown', 'authenticated', 'signed_out', 'reauthenticated'],
  failure: ['none', 'field_validation', 'unsupported_control', 'generic_save', 'page_load'],
};
const invalid = () => { throw Error('invalid ATS recovery input'); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

/** Advisory policy only. Budget is scoped to the SAME draft, including across
 * claims and sign-in. Missing budget fails closed: never infer zero after recovery.
 * No browser operations or Store writes occur here. Host evidence is attested.
 */
export function atsRecovery(evidence, budget) {
  if (!exact(evidence, [...Object.keys(choices), 'refreshApproved'])
    || Object.entries(choices).some(([key, values]) => !values.includes(evidence[key]))
    || typeof evidence.refreshApproved !== 'boolean') invalid();
  if (budget !== null && (!exact(budget, ['save', 'afterSignIn', 'refresh'])
    || Object.values(budget).some(n => !Number.isInteger(n) || n < 0 || n > 1))) invalid();
  let next = 'pause_preserve_draft';
  if (budget !== null && evidence.observation === 'current' && evidence.ats === 'workday') {
    next = evidence.draft === 'unknown' ? 'inspect_existing_draft' : workdayRecovery(evidence, budget);
  }
  const nextBudget = budget === null ? null : {...budget};
  const counter = {retry_save_once: 'save', retry_after_sign_in: 'afterSignIn', refresh_once: 'refresh'}[next];
  // Reserve the action before attempting it; an ambiguous tool result consumes it.
  if (counter) nextBudget[counter] += 1;
  return {next, nextBudget, evidenceKind: 'agent_attested',
    browserMutationAllowed: false, finalSubmissionAllowed: false};
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
