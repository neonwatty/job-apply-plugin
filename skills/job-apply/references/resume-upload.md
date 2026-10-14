# Bounded host-browser upload

Use the selected host's documented file-chooser API. Preserve the current form
and use the exact managed-resume path returned by `resume-upload-guard.mjs`.
The helper below does not grant consent, acquire a claim, or verify ATS acceptance.

## One observed control, one operation

Inspect the Resume/CV group in the current form instance. For an embedded form,
build the locator **inside that frame once**. If both a button and a tiny file
input have the accessible name Attach, a visibility filter alone may still match
both. Narrow by the observed element type inside the group, for example:

```js
const frame = tab.playwright.frameLocator('#observed-frame-id');
const resumeGroup = frame.getByRole('group', { name: 'observed Resume/CV label', exact: true });
const attach = resumeGroup.locator('button', { hasText: 'Attach' });
```

These are placeholders, not selectors to guess. Use methods supported by the
current host. Do not intersect this locator with another frame-rooted locator
using `.and(frame.locator(...))`; that can duplicate the frame boundary and match
nothing. Require one visible match before arming the listener or clicking.

Read the installed `apps/companion/resume-upload.mjs` helper. In a host runtime
that supports importing local ESM modules, call `uploadManagedResume` with the
existing `tab`, the observed `control`, and a `guard` callback returning the
fresh successful canonical upload-guard result. Obtain that result through the
approved command tool immediately before this operation; never introduce shell
execution into a browser-only runtime. Do not import the module through page
evaluation. If local imports are unsupported, use the helper's same bounded
sequence with the host's documented API; never switch browser mechanisms merely
to load the helper.

The sequence attaches a rejection handler to the chooser promise **immediately**,
before awaiting the click. A catch added only after click is too late: the chooser
may reject while click is pending and reset the host REPL. Always drain the
listener after click failure; never leave a rejected promise unattended. Pass
only the guard's returned path to `setFiles`. Keep paths and raw browser errors
out of durable records and chat.

## Observe before recovery

| Helper outcome | Required next action |
| --- | --- |
| `control_unavailable` | Inspect the current group and correct an evidenced selector problem before another attempt. |
| `guard_failed` | Resolve the selected resume and revision again; do not click. |
| `click_failed` | Inspect the widget; no file selection was attempted by the helper. |
| `chooser_unavailable` | Inspect for an open native picker, accepted attachment, progress, or errors; absence of the event alone does not establish the widget state. |
| `selection_uncertain` | Inspect acceptance; do not automatically repeat `setFiles`. |
| `selection_attempted` | Observe the ATS's accepted file and verify selected-resume identity. This is not upload success. |

Allow at most one corrected retry for a demonstrated selector/path error after
fresh inspection and guard validation. A valid visible button whose chooser
still fails goes to the code-controlled manual attachment fallback below. Never reload
the draft to retry. A supported native picker may be handled only through the
selected host's documented capabilities and existing consent; otherwise leave
it for the owner. Do not infer file-URL permissions are disabled from a timeout.

If the owner attaches the file, freshly inspect the accepted-file state. If its
identity cannot be privately matched to the selected managed resume, ask the
owner to confirm that exact selection. Owner confirmation alone does not prove
the ATS accepted the file; a progress indicator is unresolved. Revalidate the
form and build fresh readiness evidence only after acceptance and identity are
both established. An unresolved required upload must remain `needs_info`.

Follow [browser recovery](browser.md#embedded-ats-resume-uploads) for the durable
handoff. Preserve all existing drafts and leave final submission to the owner.

## Code-controlled manual attachment fallback

A `chooser_unavailable` result routes to `manual_attachment`, including when a
native picker opened but the host did not deliver its event. Do not click again,
reload, change permissions, or switch browsers to work around this result.
`selection_uncertain` and `click_failed` also use this fallback if inspection
cannot establish an accepted attachment. Finish other authorized fields first.

Use `apps/companion/manual-attachment.mjs` to compute the next action. Call
`manualAttachmentDecision(input)` through an approved local module runtime, or
run `node <plugin-root>/apps/companion/manual-attachment.mjs --input <private-json>`
through the command tool. Never add command execution to a browser-only runtime.
The input is closed and contains no filename, path, answer, URL, or browser state:

```js
const input = {
  scope: { jobId, attemptRevision, resumeId, resumeRevision, contentRevision, formInstanceId },
  currentScope: { jobId, attemptRevision, resumeId, resumeRevision, contentRevision, formInstanceId },
  uploadOutcome: 'chooser_unavailable', guardPassed: true,
  pausedObservationRevision: 1,
  observation: { revision: 2, state: 'missing' },
  ownerConfirmation: null,
};
```

Use the actual canonical job/run/resume identities, the current numeric attempt
and resume record revisions, and a fresh opaque `formInstanceId` for this exact
form. Never put a URL or selector in that ID; retain it only while the same form
instance survives. The run's `contentRevision` is a separate opaque identity:
check it against the selected resume metadata, then pass the numeric resume
record revision to `resume-upload-guard.mjs --expected-revision`. Set `guardPassed`
only after that current check succeeds. Retain the pre-handoff scope and
observation revision; increment observation revision only after a fresh read.
If evidence is lost, reacquire current scope and fresh observations; do not
reconstruct an old confirmation. A new attempt requires new scoped evidence.

| Decision | Owner-visible action |
| --- | --- |
| `attachment_required` | Ask the owner to attach the selected managed resume in this draft and tell you when done. If the native picker is already open, use it; do not open another. |
| `upload_pending` | Wait for the current upload to finish, then inspect acceptance. Do not select the file again. |
| `identity_confirmation_required` | Ask whether the accepted attachment is the selected managed resume for this exact draft. |
| `observation_required` | Inspect the current widget; if inaccessible, leave browser work to the owner. |
| `scope_changed` | Resolve the selected resume and current attempt/form again. Do not reuse old acceptance or confirmation. |
| `attachment_verified` | Revalidate the complete form. This decision never authorizes submission or declares the whole application ready. |

Before waiting for the owner, pass the current value-free session and input to
`manualAttachmentPause(session, input)`. It preserves existing pending work,
adds `resume_upload` to `handoffChecklist`, and adds the closed
`unsupported-control` browser handoff. Record that session through the current
owner report descriptor or ordinary attempt handoff as **needs_info**. Require
canonical acceptance and claim release, and mark the visible tab for handoff.
Do not store the helper input as a new Store document or insert unsupported
fields into the canonical session. The existing session is the durable pause.

### Help selecting the managed file

After the canonical Needs Info pause is accepted and its claim released, use
`apps/companion/manual-attachment-guidance.mjs` through the approved local module
runtime to derive owner-facing guidance from the same evidence:

```js
const guidance = manualAttachmentGuidance(input, {
  helpRequested: true,
  pickerState: 'open', // observed open, observed closed, or unknown
  platform: 'macos', // macos or other
  clipboardCapability: 'available', // available or unavailable
});
```

Use actual current host capabilities and the owner's request for help. This pure
helper performs no clipboard, browser, or Store operations and grants no new
consent. It recomputes the existing manual-attachment decision; scope drift,
stale evidence, upload progress, or accepted attachments cannot request another
selection. An unknown picker state requires inspection. An open picker is reused;
only a freshly observed closed picker gets instructions to open Attach once.
Never repeat the automatic chooser attempt, change permissions, switch browsers,
or bypass an app safety check to prepare this assistance.

`preparePrivateClipboard: true` is a preparation request, never proof that a path
was copied. Honor it only after fresh canonical selection/content checks and a
successful `resume-upload-guard.mjs` result for this exact current scope. Privately
copy only the returned managed path through the host's available approved
clipboard capability. Never substitute a guessed path, original source path,
filename search result, or another resume. Keep the path out of chat, screenshots,
logs, and durable receipts. Do not print or echo the path while copying it. If
scope changed or guard/clipboard preparation fails, stop this assistance and
resolve that condition; do not claim the clipboard is ready.

After successful preparation, tell the owner the verified path is on the
clipboard. On macOS, give the helper's steps: use the existing picker (or open
Attach once if freshly observed closed), press **Command–Shift–G**, then
**Command–V**, then **Return**, and click **Open**. Ask them to confirm the selected
resume for this exact draft and leave Submit untouched. When clipboard capability
is unavailable or the platform differs, use documented host assistance or leave
selection to the owner; do not invent equivalent shortcuts or capabilities.
The helper output is value-free, but it is not a new durable state document.

On the owner's reply, follow the canonical recovery/selection route to a current
attempt before continuing. An explicit reply confirming the intended selected
resume supplies `ownerConfirmation: { scope: currentScope, confirmed: true }`;
a generic “done” requires an identity question if it did not confirm that choice.
Never infer this confirmation from the file name, a previous application, or a
historical receipt. Inspect the ATS again: `accepted`, `missing`, `progress`,
`rejected`, or `unobservable` must reflect what is currently visible.

For this fallback, include the same input as `manualAttachment` when calling
`buildReadinessPacket` (or its JSON CLI). Its current attempt and observation
revisions must match the packet. Code replaces the `resume.file` state with the
computed state even if a caller supplied `accepted`; missing confirmation,
stale evidence, progress, or drift cannot become accepted upload through this
helper. Only fresh ATS acceptance plus exact scoped owner confirmation yields
`accepted`. Clear only the resolved upload checklist/blocker; preserve all other
work. The canonical readiness and handoff gates still decide manual-review
completion. Browser observations and human replies are host/agent attestations,
not independently authenticated by this helper.
