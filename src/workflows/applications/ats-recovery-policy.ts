import { workdayRecovery } from './workday-recovery.js';
import { recoveryEvidence, recoveryBudget } from '../../contracts/workspace/ats-recovery.js';
import type { RecoveryAction, RecoveryBudget } from '../../contracts/workspace/ats-recovery.js';

export const recoveryCounter = (next: RecoveryAction): keyof RecoveryBudget | undefined => {
  if (next === 'retry_save_once') return 'save';
  if (next === 'retry_after_sign_in') return 'afterSignIn';
  if (next === 'refresh_once') return 'refresh';
  return undefined;
};
/** Also exported for advisory previews. Only broker receipts reserve durable budget. */
export function atsRecovery(raw: unknown, rawBudget: unknown) {
  const evidence = recoveryEvidence(raw), budget = rawBudget === null ? null : recoveryBudget(rawBudget);
  let next: RecoveryAction = 'pause_preserve_draft';
  if (budget && evidence.observation === 'current' && evidence.ats === 'workday') {
    next = evidence.draft === 'unknown' ? 'inspect_existing_draft' : workdayRecovery(evidence,budget);
  }
  const nextBudget = budget ? {...budget} : null, counter = recoveryCounter(next);
  if (counter && nextBudget) nextBudget[counter] += 1;
  return {next, nextBudget, evidenceKind:'agent_attested' as const,
    browserMutationAllowed:false, finalSubmissionAllowed:false};
}
