import { manualAttachmentDecision } from './manual-attachment.mjs';

const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

/** Value-free presentation of an existing manual-attachment decision.
 * Context is a current host/owner attestation, not a capability detector.
 * No browser, clipboard, filesystem or Store operation is performed here.
 */
export function manualAttachmentGuidance(evidence, context) {
  if (!exact(context, ['helpRequested', 'pickerState', 'platform', 'clipboardCapability'])
    || typeof context.helpRequested !== 'boolean'
    || !['open', 'closed', 'unknown'].includes(context.pickerState)
    || !['macos', 'other'].includes(context.platform)
    || !['available', 'unavailable'].includes(context.clipboardCapability)) {
    throw Error('invalid manual attachment guidance context');
  }
  const decision = manualAttachmentDecision(evidence);
  const result = (next, instructions, preparePrivateClipboard = false) => ({
    ...decision, next, instructions, preparePrivateClipboard,
    freshUploadGuardRequired: preparePrivateClipboard,
  });
  if (decision.state !== 'attachment_required') {
    const instructions = {
      scope_changed: 'Resolve the current selected resume, attempt and form before continuing.',
      observation_required: 'Inspect the current attachment widget or hand browser work to the owner.',
      upload_pending: 'Wait for the current upload to finish, then inspect ATS acceptance.',
      identity_confirmation_required: 'Ask whether the accepted attachment is the selected resume in this exact draft.',
      attachment_verified: 'Revalidate the complete form for manual review. Leave final submission to the owner.',
    };
    return result(decision.next, [instructions[decision.state]]);
  }
  if (context.pickerState === 'unknown') {
    return result('inspect_native_picker', [
      'Check whether a native file picker is already open before asking for another Attach click.',
    ]);
  }
  const start = context.pickerState === 'closed'
    ? 'In this exact draft, click Resume/CV → Attach once to open the file picker.'
    : 'Use the file picker that is already open.';
  if (!context.helpRequested) {
    return result('ask_owner_to_attach_selected_resume', [start,
      'Select the chosen managed resume and confirm that selection for this exact draft. Leave Submit untouched.',
    ]);
  }
  if (context.platform !== 'macos' || context.clipboardCapability !== 'available') {
    return result('owner_file_picker_help', [start,
      'Use the host’s documented file-picker assistance to select the chosen managed resume. If unavailable, leave selection to the owner.',
      'Confirm the selected resume for this exact draft. Leave Submit untouched.',
    ]);
  }
  return result('prepare_guarded_private_clipboard', [start,
    'After the current guarded managed-resume path has been copied privately, press Command–Shift–G, then Command–V, then Return, and click Open.',
    'Confirm the selected resume for this exact draft. Leave Submit untouched.',
  ], true);
}
