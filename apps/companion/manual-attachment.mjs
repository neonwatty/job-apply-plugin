import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const positive = value => Number.isSafeInteger(value) && value > 0;
const invalid = () => { throw Error('invalid manual attachment evidence'); };
const scopeKeys = ['jobId', 'attemptRevision', 'resumeId', 'resumeRevision', 'contentRevision', 'formInstanceId'];
function validScope(scope) {
  return exact(scope, scopeKeys) && positive(scope.attemptRevision) && positive(scope.resumeRevision)
    && ['jobId', 'resumeId', 'contentRevision', 'formInstanceId'].every(key =>
      typeof scope[key] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(scope[key])
      && !scope[key].includes('..'));
}
const equalScope = (a, b) => scopeKeys.every(key => a[key] === b[key]);

/** Derive the next step from current attestations, never from a chooser timeout alone.
 * Scopes are opaque identities, not URLs or applicant values. This helper cannot
 * authenticate a human reply or observe a browser; callers must supply real evidence.
 * Durable pauses use the existing canonical session and claim handoff, not this object.
 */
export function manualAttachmentDecision(input) {
  if (!exact(input, ['scope', 'currentScope', 'uploadOutcome', 'guardPassed',
    'pausedObservationRevision', 'observation', 'ownerConfirmation'])
    || !validScope(input.scope) || !validScope(input.currentScope)
    || !['chooser_unavailable', 'selection_uncertain', 'click_failed'].includes(input.uploadOutcome)
    || typeof input.guardPassed !== 'boolean' || !positive(input.pausedObservationRevision)
    || !exact(input.observation, ['revision', 'state']) || !positive(input.observation.revision)
    || !['missing', 'progress', 'accepted', 'rejected', 'unobservable'].includes(input.observation.state)) invalid();
  const confirmation = input.ownerConfirmation;
  if (confirmation !== null && (!exact(confirmation, ['scope', 'confirmed'])
    || !validScope(confirmation.scope) || typeof confirmation.confirmed !== 'boolean')) invalid();
  const result = (state, next, resumeState = 'unresolved') => ({ state, next,
    automaticRetryAllowed: false, finalSubmissionAllowed: false, resumeState });
  if (!equalScope(input.scope, input.currentScope) || !input.guardPassed) {
    return result('scope_changed', 'resolve_selected_resume');
  }
  if (input.observation.revision <= input.pausedObservationRevision) {
    return result('observation_required', 'inspect_current_widget');
  }
  if (input.observation.state === 'progress') return result('upload_pending', 'wait_for_ats_acceptance');
  if (input.observation.state === 'unobservable') return result('observation_required', 'owner_browser_handoff');
  if (input.observation.state !== 'accepted') {
    return result('attachment_required', 'ask_owner_to_attach_selected_resume',
      input.observation.state === 'rejected' ? 'rejected' : 'missing');
  }
  if (confirmation === null || !confirmation.confirmed || !equalScope(confirmation.scope, input.currentScope)) {
    return result('identity_confirmation_required', 'ask_owner_to_confirm_selected_resume');
  }
  return result('attachment_verified', 'revalidate_complete_form', 'accepted');
}

/** Merge the upload pause into a current session without dropping other work.
 * Submit the result through the current attempt/owner descriptor as needs_info;
 * only an accepted canonical handoff releases the claim.
 */
export function manualAttachmentPause(session, input) {
  const decision = manualAttachmentDecision(input);
  if (!session || typeof session !== 'object' || Array.isArray(session)
    || String(session.attemptRevision) !== String(input.currentScope.attemptRevision)
    || decision.state === 'attachment_verified'
    || (Object.hasOwn(session, 'blockers') && !Array.isArray(session.blockers))
    || (Object.hasOwn(session, 'handoffChecklist') && !Array.isArray(session.handoffChecklist))) invalid();
  const blockers = (session.blockers ?? []).map(item => ({ ...item }));
  if (!blockers.some(item => item.type === 'browser_handoff' && item.code === 'unsupported-control')) {
    blockers.push({ type: 'browser_handoff', code: 'unsupported-control' });
  }
  const checklist = [...(session.handoffChecklist ?? [])];
  if (!checklist.includes('resume_upload')) checklist.push('resume_upload');
  return { ...session, status: 'active', blockers, handoffChecklist: checklist,
    browserHandoff: { state: 'required', reasonCode: 'unsupported-control', revision: 1 } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--input' || process.argv[3] === '-') invalid();
    const source = readFileSync(process.argv[3]);
    if (source.length > 32 * 1024) invalid();
    process.stdout.write(JSON.stringify({ ok: true, ...manualAttachmentDecision(JSON.parse(source.toString('utf8'))) }) + '\n');
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, error: 'invalid manual attachment evidence' }) + '\n');
    process.exitCode = 2;
  }
}
