import { decideFieldVerification } from './field-verification.mjs';

/** Host callbacks retain private values. This helper neither observes a browser
 * nor grants a retry: the caller supplies the existing control repair count.
 * A failed observation must never be interpreted as a failed write.
 */
export async function performVerifiedFieldEntry({ write, observe, repair, repairCount }) {
  if (typeof write !== 'function' || typeof observe !== 'function'
    || (repair !== undefined && typeof repair !== 'function')
    || ![0, 1].includes(repairCount)) throw Error('invalid field entry configuration');
  let writeState = 'completed';
  try { await write(); } catch { writeState = 'uncertain'; }
  const inspect = async count => {
    try {
      const evidence = await observe();
      // The caller cannot erase an already consumed alternate through readback.
      return decideFieldVerification({ ...evidence, repairCount: count });
    } catch {
      return { state: 'observation_failed', next: 'reobserve', verified: false,
        repairAllowed: false, finalSubmissionAllowed: false };
    }
  };
  let decision = await inspect(repairCount);
  let repairState = 'not_attempted';
  if (decision.next === 'repair_once' && repair) {
    repairCount = 1;
    repairState = 'completed';
    try { await repair(); } catch { repairState = 'uncertain'; }
    decision = await inspect(repairCount);
  }
  return { writeState, repairState, repairCount, ...decision };
}

/** A segmented date is verified only after every current segment and the
 * associated validation state agree. Inputs contain no date values.
 */
export function verifyDateGroup({ segments, validation } = {}) {
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 3
    || !['clear', 'invalid', 'unknown'].includes(validation)) {
    throw Error('invalid date group evidence');
  }
  const decisions = segments.map(decideFieldVerification);
  const verified = validation === 'clear' && decisions.every(item => item.verified);
  return { verified, next: verified ? 'continue' : 'inspect_date_group',
    finalSubmissionAllowed: false };
}
