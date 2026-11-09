# Current-form readiness packet

Read before the durable awaiting-review handoff. Resolve paths from the installed `<plugin-root>`, not the current directory.

For a live application, enumerate every user-facing logical input across the application steps reached in this attempt, including optional and applicable conditional controls. Keep the accumulated inventory through page transitions; add newly revealed controls and do not drop a prior required control merely because its page is no longer visible. Count a custom dropdown once; exclude its internal option inputs, hidden fields, and CAPTCHA internals. Give each control a value-free semantic ID (`contact.email`, `resume.file`, `custom.question_1`), its role (`textbox`, `combobox`, `radiogroup`, `checkbox`, or `file`), and whether the form marks it required. Sort controls by ID. Never put labels, answers, filenames, paths, URLs, or browser IDs in this packet. The complete inventory is an agent attestation, not independent browser proof. If any logical control is inaccessible or its required status cannot be determined, hand off as Needs Attention rather than asserting completeness.

Bundled fixtures remain for deterministic QA replay and older packets. A live ATS form does not need to match a fixture; company-specific questions belong in its observed inventory.

### Build from accumulated browser observations

Prefer the installed `node "<plugin-root>/apps/companion/readiness-packet.mjs" --input <private-json>` helper. Capture each visible logical-control inventory from the selected browser before an upload or page transition and again after any form change. The helper unions those inventories, so an accepted resume input that disappears after upload is retained. Supply only value-free semantic IDs, roles, and required flags; do not include labels, applicant values, filenames, URLs, browser tab IDs, or screenshots. Record `verifiedStates` separately from actual post-entry observations. Do not generate success states by iterating the inventory. A missing required state produces a blocked report. Conflicting control definitions and unexpected fields are rejected without echoing the input.

The private input has `attemptRevision`, `platformFamily`, positive `observationRevision`, `complete:true`, `inventories:[{"controls":[{"id":"contact.email","role":"textbox","required":true}]}]`, `verifiedStates:[{"id":"contact.email","state":"complete"}]`, `adapterState`, `uploadCapability`, `validationErrorControlIds`, and `finalControlState`. Include every observed logical control, including optional and conditional controls, across all inventories. `complete:true` is an agent attestation after that inspection; the helper cannot independently collect the browser state. Remove the temporary input on success or failure.

Use its `readinessInput` in the review session only when the returned `readiness.status` is `ready` and the current form still matches the observations. Recheck fields after rerenders. A blocked result requires a typed Needs Attention handoff. The helper constructs the manifest and closed observation with the maintained builders below; never hand-author those derived structures.

The recomputed report also lists `optionalUnansweredControlIds`: value-free IDs for optional non-file controls without a verified complete state. These do not block review. Check the list against the visible form, observe genuinely unmatched optional questions in the Answer Store as described in [application filling](application.md), and name the skipped fields without values in the owner handoff. Optional convenience file uploaders are retained in the inventory but excluded from this list. The Companion shows the list in Job Activity; older reports without it say that optional blanks were not recorded.

The pure builders in `<plugin-root>/runtime/contracts/workspace/claim-session-readiness.js` provide the maintained serialization contract (convert ordinary JSON with `fromJSON` from `runtime/contracts/workspace/values.js`):

- `makeLiveFormManifest(observedForm, revision, ats)` derives the manifest from the full current inventory. Set `observedForm` to `{schemaVersion:1, platformFamily, observationRevision:revision, complete:true, controls:[{id,role,required},...]}` only after enumerating the visible form.
- `makeLiveReadinessObservation(observedForm, controlStates, revision, {adapterState, uploadCapability, validationErrorControlIds, finalControlState})` serializes the current visible states. Use `complete` for an ordinary filled control and `accepted` only for a verified file upload. Omit optional controls that have no observed completion; every required control needs evidence. Provide every option explicitly.

Use one positive observation revision for the final accumulated inventory and states, unchanged in both builders and `expectedObservationRevision`. It is separate from the retained post-acquisition `attemptRevision`. Recheck the inventory after a conditional field appears, a page transition, or a material form change. Carry a prior-step completion only when its value was verified and the form accepted that non-final transition; otherwise mark it unresolved. Never generate success states by iterating the inventory. Verify an upload is accepted and ordinary fields are complete from browser evidence in this attempt. Count consent controls as complete only after the approved action visibly persists; unapproved consent, authentication, CAPTCHA, and final submission remain under the owner's control. Unknown, inaccessible, missing, rejected, or stale required controls cannot support `awaiting_review`.

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
