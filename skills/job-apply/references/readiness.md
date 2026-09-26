# Current-form readiness packet

Read before the durable awaiting-review handoff. Resolve paths from the installed `<plugin-root>`, not the current directory.

For a live application, enumerate every user-facing logical input on the current visible form, including optional and conditional controls that are currently shown. Count a custom dropdown once; exclude its internal option inputs, hidden fields, and CAPTCHA internals. Give each a value-free semantic ID (`contact.email`, `resume.file`, `custom.question_1`), its role (`textbox`, `combobox`, `radiogroup`, `checkbox`, or `file`), and whether the form currently marks it required. Sort controls by ID. Never put labels, answers, filenames, paths, URLs, or browser IDs in this packet. The complete inventory is an agent attestation, not independent browser proof. If any logical control is inaccessible or its required status cannot be determined, hand off as Needs Attention rather than asserting completeness.

Bundled fixtures remain for deterministic QA replay and older packets. A live ATS form does not need to match a fixture; company-specific questions belong in its observed inventory.

The pure builders in `<plugin-root>/runtime/contracts/workspace/claim-session-readiness.js` provide the maintained serialization contract (convert ordinary JSON with `fromJSON` from `runtime/contracts/workspace/values.js`):

- `makeLiveFormManifest(observedForm, revision, ats)` derives the manifest from the full current inventory. Set `observedForm` to `{schemaVersion:1, platformFamily, observationRevision:revision, complete:true, controls:[{id,role,required},...]}` only after enumerating the visible form.
- `makeLiveReadinessObservation(observedForm, controlStates, revision, {adapterState, uploadCapability, validationErrorControlIds, finalControlState})` serializes the current visible states. Use `complete` for an ordinary filled control and `accepted` only for a verified file upload. Omit optional controls that have no observed completion; every required control needs evidence. Provide every option explicitly.

Use one positive observation revision for the fresh inventory and states, unchanged in both builders and `expectedObservationRevision`. It is separate from the retained post-acquisition `attemptRevision`. Re-enumerate after a conditional field appears, a page transition, or a material form change. Never generate success states by iterating the inventory. Verify an upload is accepted and ordinary fields are complete from actual current browser evidence. User-only legal consent, authentication, CAPTCHA, and final submission remain under the owner's control. Unknown, inaccessible, missing, rejected, or stale required controls cannot support `awaiting_review`.

Build the private session object with these keys (replace the descriptive placeholders with objects and exact integer revisions):

```text
status: review
step: final_review
pendingFields: []
attemptRevision: retained post-acquisition job revision
readinessInput:
  attemptRevision: same retained job revision
  evidenceKind: agent_attested_current_attempt
  observedForm: complete value-free inventory from the current visible form
  formManifest: builder result from that inventory
  observation: builder result from current observed states
  expectedObservationRevision: same fresh observation revision
```

Use the private `node "<plugin-root>/apps/companion/command.mjs" attempt [--root <resolved-root>] handoff --status awaiting_review --input <private-temp.json>` client in [application.md](application.md). The Store validates the closed inventory, recomputes its fingerprint and report, and requires all required controls complete, upload accepted, no validation errors, and final action available and untouched. It cannot independently verify that the agent listed every browser control. Delete private input on success or failure, preserve the draft on rejection, and never fall back to raw claim commands. Every final submission control remains untouched for the owner.
