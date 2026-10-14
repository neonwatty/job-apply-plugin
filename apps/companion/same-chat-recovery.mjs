const choices = {
  chatScope: ['same', 'different', 'unknown'],
  draft: ['present', 'missing', 'unknown'],
  observation: ['current', 'stale', 'unknown'],
  formScope: ['same', 'different', 'unknown'],
};

/** Advisory decision from fresh canonical context and value-free host observations.
 * Never observes a browser, authenticates consent, or grants mutation authority.
 * The broker still rechecks every descriptor at execution time.
 */
export function sameChatRecovery(context, evidence) {
  const invalid = () => { throw Error('invalid same-chat recovery input'); };
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
    || Object.keys(evidence).sort().join(',') !== Object.keys(choices).sort().join(',')
    || Object.entries(choices).some(([key, values]) => !values.includes(evidence[key]))) invalid();
  const guidance = context?.guidance;
  const broker = context?.broker;
  if (!guidance || !broker || typeof broker.connected !== 'boolean'
    || typeof broker.ownsClaim !== 'boolean' || !Array.isArray(guidance.actions)
    || !guidance.actions.every(action => action && typeof action.kind === 'string')
    || ![null, 'live', 'expired'].includes(guidance.claim === null ? null : guidance.claim?.state)) invalid();
  const result = next => ({ next, evidenceKind: 'agent_attested',
    navigationAllowed: false, browserMutationAllowed: false, finalSubmissionAllowed: false,
    currentReadinessVerified: false });
  if (evidence.chatScope !== 'same') return result('return_to_original_chat');
  if (evidence.draft === 'missing' || evidence.formScope === 'different') return result('preserve_checkpoint_request_fresh_attempt');
  if (evidence.draft !== 'present' || evidence.observation !== 'current'
    || evidence.formScope !== 'same') return result('inspect_existing_draft');
  if (guidance.claim?.state === 'live' && !(broker.connected && broker.ownsClaim)) return result('wait_for_claim_expiry');
  if (guidance.claim?.state === 'expired') return result(
    guidance.actions.some(action => action.kind === 'recover' && action.requiresExplicitUserEvent === true)
      ? 'request_explicit_recovery' : 'resolve_workflow_blocker');
  if (guidance.claim?.state !== 'live' || !(broker.connected && broker.ownsClaim)) return result('resolve_workflow_blocker');
  if (guidance.selection?.inputsCurrent !== true) return result('guarded_needs_info');
  if (guidance.actions.some(action => action.kind === 'progress')) return result('continue_via_current_descriptors');
  return result('guarded_needs_info');
}
