/**
 * One chooser operation using the host's existing browser objects. No browser
 * connection, Store mutation, retry, or accepted-upload attestation lives here.
 * guard must run the canonical upload guard immediately before this operation.
 * The caller supplies a uniquely scoped control from the observed live form.
 */
export async function uploadManagedResume({ tab, control, guard }) {
  const result = (outcome, next = 'inspect_widget') => ({ outcome, next });
  try {
    if (await control.count() !== 1 || !await control.isVisible()) {
      return result('control_unavailable');
    }
  } catch { return result('control_unavailable'); }

  let guarded;
  try { guarded = await guard(); }
  catch { return result('guard_failed', 'resolve_resume'); }
  if (guarded?.ok !== true || typeof guarded.path !== 'string' || !guarded.path) {
    return result('guard_failed', 'resolve_resume');
  }

  let pending;
  try {
    // Attach both handlers before awaiting click: the chooser can time out
    // while click is still pending. A delayed catch can reset the host REPL.
    pending = tab.playwright.waitForEvent('filechooser', { timeoutMs: 10000 })
      .then(chooser => ({ chooser }), () => ({ chooser: null }));
  } catch { return result('chooser_unavailable', 'manual_attachment'); }

  let clicked = false;
  try { await control.click({ timeoutMs: 5000 }); clicked = true; }
  catch { /* Drain the already-handled listener before returning. */ }
  const { chooser } = await pending;
  if (!clicked) return result('click_failed');
  if (!chooser) return result('chooser_unavailable', 'manual_attachment');
  try { await chooser.setFiles([guarded.path]); }
  catch { return result('selection_uncertain'); }
  return result('selection_attempted', 'observe_widget');
}
