/** Workday policy consumes a shared, validated, value-free observation. */
export function workdayRecovery(e, budget) {
  if (e.draft === 'missing') return 'request_fresh_attempt';
  if (e.session === 'signed_out') return 'request_user_sign_in';
  if (e.failure === 'unsupported_control') return 'request_manual_control';
  if (e.failure === 'field_validation') return 'inspect_field_validation';
  if (e.failure === 'page_load') {
    if (budget.refresh > 0) return 'pause_preserve_draft';
    return e.refreshApproved ? 'refresh_once' : 'request_refresh_approval';
  }
  if (e.failure === 'generic_save') {
    if (e.session === 'unknown') return 'inspect_session_separate_tab';
    if (e.session === 'reauthenticated' && budget.afterSignIn === 0) return 'retry_after_sign_in';
    if (e.session === 'authenticated' && budget.save === 0) return 'retry_save_once';
    return 'pause_preserve_draft';
  }
  return 'inspect_existing_draft';
}
