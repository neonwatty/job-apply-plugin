# Application automation modes

Read this reference after canonical intake and before browser work. The Companion owns the durable mode; never infer a higher mode from the user's wording, a queued job, or an earlier conversation.

## Three modes

- **Guided** is the default. Follow the post-readiness, one-use consent flow in [browser.md](browser.md). Confirm uncertain and sensitive answers as that workflow requires.
- **Autofill to Review** is one exact-job grant. It may fill canonical resume facts, upload the run's managed resume, enter currently confirmed answers, repair a cleared field once, and navigate clearly non-final controls. It is consumed only by a successful durable `awaiting_review` handoff.
- **Campaign to Review** is a bounded, sequential grant over the exact jobs shown in the active application run. It performs the same operations one claim at a time. Pause, stop, expiry, revocation, run drift, or canonical-data drift ends unattended work immediately.

All modes stop at final review. Submit, Send, Apply, Mark applied, or any equivalent final action is never an authorized operation. Login, passwords, account creation, CAPTCHA, MFA, email verification, provider legal consent, missing or uncertain data, unsupported controls, an unexpected destination, and ambiguity always interrupt automation.

## Action-time evaluation

Read `store application-authority-status` before starting work. Guided uses the normal consent flow. In either higher mode, do not treat the status projection alone as permission to type. After the attempt broker is started, and before each coherent action group or changed page, put exactly this value-free packet in a private temporary file:

```json
{
  "destinationUrl": "https://the-current-visible-origin.example/path",
  "operations": ["fill_canonical_profile", "upload_managed_resume", "fill_confirmed_answer", "navigate_non_final"],
  "answerRefs": [],
  "sensitiveAnswerRefs": [],
  "interrupts": {
    "missingOrUncertainData": false,
    "captcha": false,
    "mfa": false,
    "emailVerification": false,
    "providerLegalConsent": false,
    "unsupportedControls": false,
    "unexpectedDestination": false,
    "ambiguity": false,
    "finalAction": false
  }
}
```

Run `node "<plugin-root>/apps/companion/command.mjs" attempt [--root <resolved-root>] authority-evaluate --input <private-file>`, then remove the file immediately. The broker privately adds the bound canonical job and live claim. Never add a job ID, claim token, applicant value, answer value, path, filename, tab ID, or browser state to this packet.

Proceed only when the response says `authorized: true`, the returned mode is the expected higher mode, and the operations exactly cover the intended group. A denial or interrupt reverts that action surface to Guided; do not retry it against unseen state. Final-action evaluation must always set `finalAction: true`, must be denied, and must be followed by the visible manual-review handoff—not by activating the control.

Only include a non-sensitive `answerRef` after the current canonical lookup confirms it. Include a sensitive reference in `sensitiveAnswerRefs` only when the active grant names that exact answer revision. A newly supplied or revised sensitive answer requires a new owner grant.

## Campaign driver

Campaign is a local sequential driver, not background submission and not parallel browser work:

1. Read `store application-authority-progress`. Continue only while its mode is `campaign_to_review` and status is `active`.
2. Use only `nextJob`, re-run canonical selection/preflight, and start one broker claim. Never keep two claims or delegate a scoped grant to an unbound worker.
3. Re-evaluate authority before each action group. Fill and verify through final review, then use the ordinary durable `awaiting_review` handoff. Never activate the final control.
4. On an interrupt, save one value-free `needs_info` handoff and release the claim. Continue to another Ready job only after progress still reports the campaign active. Never wait for the owner while holding a claim.
5. Between jobs, and after every handoff, read progress again. Pause leaves queued work untouched; stop or Guided ends the loop. When no Ready job remains, report counts at review, needing attention, or unavailable and stop.

Campaign ordering is the active run's exact queue order. It does not search for jobs, add jobs, choose another resume, revise facts, create accounts, or submit applications.
