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
still fails goes to owner handoff, not another speculative click. Never reload
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
