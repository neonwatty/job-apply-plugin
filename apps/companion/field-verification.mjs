const keys = ['source', 'observation', 'freshness', 'attemptScope', 'formScope', 'controlScope', 'repairCount'];
const observations = {
  readback: ['match', 'mismatch', 'masked', 'unavailable', 'unknown'],
  visual: ['match', 'mismatch', 'unreadable', 'unknown'],
  write: ['attempted'],
};
const scopes = ['same', 'different', 'unknown'];

/** Decide from value-free host attestations, without observing the browser.
 * Current means observed after the latest write or possible form rerender. The
 * caller must compare privately and bind evidence to this attempt/form/control.
 * A repair budget belongs to that control's bounded entry loop, not this call.
 */
export function decideFieldVerification(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).sort().join(',') !== [...keys].sort().join(',')
    || !['readback', 'visual', 'write'].includes(input.source)
    || !observations[input.source].includes(input.observation)
    || !['current', 'stale', 'unknown'].includes(input.freshness)
    || !['attemptScope', 'formScope', 'controlScope'].every(key => scopes.includes(input[key]))
    || ![0, 1].includes(input.repairCount)) {
    throw Error('invalid field verification evidence');
  }
  const result = (state, next, verified = false) => ({ state, next, verified,
    repairAllowed: next === 'repair_once', finalSubmissionAllowed: false });
  if (input.freshness !== 'current'
    || !['attemptScope', 'formScope', 'controlScope'].every(key => input[key] === 'same')) {
    return result('observation_required', 'reobserve');
  }
  if (input.source === 'write') return result('observation_required', 'reobserve');
  if (input.observation === 'match') return result('verified', 'continue', true);
  if (input.observation === 'mismatch') {
    return result('mismatch', input.repairCount === 0 ? 'repair_once' : 'owner_input_required');
  }
  if (input.source === 'readback') return result('unobservable', 'inspect_visual');
  return result('unobservable', 'owner_input_required');
}
