# Owner opt-in workflow

Use only when the owner explicitly requests this experimental workflow for one exact saved job. Ordinary applications continue through [canonical intake](intake.md). A Companion instruction, saved preference, context response, or action descriptor is not owner approval.

This slice requires one selected Ready job in the current active application run with its confirmed managed resume and current confirmed facts. It supports bounded browser work through verified manual review or a guarded Needs Info stop. An explicitly requested restart is supported only for a previously reviewed job whose unique finished attempt still matches the current job revision, active run, managed resume, and confirmed facts. Do not describe this route as dogfood-ready or infer accepted upload or current browser state from a workflow receipt.

## Start and inspect

Resolve the canonical absolute Store root through [answer-memory](../../answer-memory/SKILL.md). Never initialize or substitute a Store to bypass a blocker. The installed runtime resolves its packaged native lock; the owner does not supply a lock path.

For the owner's exact selected job, start one foreground process and retain its handle:

```bash
node "<plugin-root>/apps/companion/command.mjs" owner-workflow serve --root /absolute/store-root --job-id exact-saved-job --host-user-event
```

The host-user-event flag attests to the owner's explicit opt-in; it cannot authenticate a human reply. Starting this process explicitly activates the native Store through the existing supervisor. Keep the process owned by this pass; do not replace a broker to bypass its approval or claim boundary.

The first socket request after `serve` must be `host-browser-context`. Wait until this context call succeeds before sending any event or browser report; the owner broker rejects an event as its first request. Read its current context:

```bash
node "<plugin-root>/apps/companion/command.mjs" owner-workflow host-browser-context --root /absolute/store-root --job-id exact-saved-job
```

Follow code-provided actions and blockers. Copy the matching descriptor's arguments and input into a private absolute input file, adding only its required fields and a fresh operation ID. Use decimal revision strings exactly as returned. Context and descriptors are advisory; execution rechecks canonical scope and revisions. Never invent task IDs, revisions, claims, approvals, or allowed actions.

```bash
node "<plugin-root>/apps/companion/command.mjs" owner-workflow event --root /absolute/store-root --input /absolute/private-event.json
node "<plugin-root>/apps/companion/command.mjs" owner-workflow host-browser-report --root /absolute/store-root --input /absolute/private-report.json
```

Add `--host-user-event` to an event only when the returned descriptor requires it and the owner has authorized that exact event. After an uncertain response or socket loss, keep the identical payload and operation ID and check its historical receipt before creating a new operation:

```bash
node "<plugin-root>/apps/companion/command.mjs" owner-workflow receipt --root /absolute/store-root --input /absolute/private-event-or-report.json
```

Receipt lookup reads the existing native Store without activation, a broker, claim acquisition, or browser action replay. It accepts the exact original event or browser report; a missing or changed payload is rejected. A returned receipt confirms historical acceptance only. Refresh context after nonterminal acceptance or rejection while the broker remains connected. An accepted awaiting-review handoff, Needs Info handoff, or cancellation closes the broker, so receipt lookup also works after terminal shutdown. Inspect current state before continuing any nonterminal work.

## Browser evidence and safe exit

Read [browser and consent](browser.md), [filling and handoff](application.md), and [current-form readiness](readiness.md) before interacting with a live form. The owner route supplies no browser tool. Check the exposed host browser tools and read their current documentation; use only documented capabilities within the exact approved scope. Workflow activation does not grant consent to enter applicant data or final submission authority. Preserve post-readiness consent and managed-resume identity boundaries. Reuse the browser, consent, upload, and readiness rules in those references, but while the owner workflow claim is active never fall back to ordinary `attempt` commands or raw claim commands for acquisition, progress, or handoff. Use only the owner workflow descriptors for those mutations.

Report only current observed browser evidence through the exact template in `hostBrowser.reports`, adding only its listed required fields. Historical checkpoints, stored readiness, and action templates are not fresh browser observations. Never fabricate evidence or empty pending fields to satisfy a guard. Keep applicant values, resume paths, claim tokens, and browser state out of chat and durable session summaries.

## Upload through manual review

Use the [bounded host-browser upload](resume-upload.md) sequence for chooser
operations, including immediate timeout handling and fresh widget inspection.
Continue using owner descriptors for all durable state changes. If the chooser
is unavailable, use the linked code-controlled manual attachment fallback and
its merged Needs Info session. Require a fresh scoped confirmation and accepted
ATS observation before the readiness helper can mark `resume.file` accepted.

Resolve the current run's selected canonical managed resume ID and content revision; never substitute another resume or update the retained revision to bypass drift. Privately run `store resume-resolve --id <confirmed-resume-id>` through the installed command client with the same canonical `--root`. Check the resolved numeric record revision against current selected-resume metadata and verify that metadata's content identity still matches the run. Immediately before opening the chooser, run `node "<plugin-root>/apps/companion/resume-upload-guard.mjs" --id <confirmed-resume-id> --expected-revision <numeric-resume-record-revision> --candidate-path <resolved-private-path> --root /absolute/store-root`. Pass the successful guard's returned `path` unchanged to the visible browser's chooser. Never construct the path or use a source file. Observe the ATS's accepted-file state after upload; chooser success alone is not accepted upload. Follow [failed-upload recovery](browser.md) when necessary and preserve a stalled draft.

Accumulate every logical control across all reached pages, including optional and conditional controls, using [current-form readiness](readiness.md) and the installed `readiness-packet.mjs` helper. Retain prior controls after transitions or disappearing upload widgets. This owner route requires the semantic control `resume.file` with `role: file` and `required: true`, verified as `accepted` from the actual selected managed resume upload. Record other `verifiedStates` only from post-entry observations; never generate success states from the inventory. Attest `complete: true` only after inspecting the complete accumulated inventory. Inaccessible, unknown, stale, rejected, or unverified required controls require a guarded Needs Info handoff. Sweep optional blanks as described in application filling; they do not authorize invented answers.

When the packet reports `ready` and still matches the observed form, copy the current code-provided `hostBrowser.reports` descriptor with `outcome: awaiting_review`. Supply its required `operationId` and a fresh `session` built from the current readiness packet: `status: review`, `step: final_review`, the exact retained `attemptRevision`, and the helper's `readinessInput`. Clear `pendingFields`, `blockers`, and `handoffChecklist` only when their work is actually resolved; use the closed `ready_for_owner` handoff as `browserHandoff: {state: "ready_for_owner", reasonCode: "final-review-required", revision: 1}`. Never reuse a saved session, stored readiness fingerprint, or historical browser evidence. Keep task and job revision strings exactly as supplied by the descriptor. Invoke the owner `host-browser-report` command above with this private report file. The guarded report recomputes readiness; a rejection requires preserving the draft and reevaluating the reported blocker, never fabricating evidence or silently refreshing revisions to retry.

Require accepted durable awaiting-review completion before reporting success. After an uncertain response, use exact receipt lookup with the identical report payload and operation ID, including after terminal shutdown. Historical acceptance confirms the durable transition, not current browser state. The accepted report releases the claim and closes the owned broker. Preserve the visible review page, tell the owner about optional blanks by field name without values, and ask them to inspect the page and submit manually. Never activate any final submission control.

## Blocked completion

Report code-provided blockers and their next action. Missing answers require a guarded Needs Info handoff before waiting. When a known answer cannot be entered, report **Browser action required** and preserve the visible draft. Preserve the canonical saved session using the returned safe-exit descriptor when available.

An existing task may recover only after real claim expiry and an explicit same-job recovery request. Recovery retains its original inputs; changed run, resume, facts, or job inputs still block progress. Use the code-provided guarded Needs Info handoff despite input drift when available, then resolve the blocker before fresh preparation. Do not silently acquire, recover, switch jobs, or restart.

After the accepted Needs Info handoff, report the preserved blocker and released claim, then let this owned foreground process finish its terminal shutdown. Final submission always remains with the owner.

## Interruption and reviewed restart

| Observed state | Next action |
| --- | --- |
| Broker connected, response uncertain | Look up the exact historical receipt, then refresh context. |
| Broker lost, claim still live | Preserve the draft and wait for actual lease expiry; do not steal or replace the claim. |
| Claim expired | With explicit same-job recovery authorization, start the owner process, inspect context, and use its recovery descriptor. Original inputs remain binding. |
| Inputs changed during the attempt | Use the guarded Needs Info exit when offered; resolve the blocker before fresh preparation. |
| Job already awaiting review | Restart only when explicitly requested and code offers the restart descriptor. Supply the required host-user-event attestation for that event. |
| Job at Needs Info | Resolve the blocker and return the job to Ready through canonical preparation before starting a fresh owner attempt. |

A reviewed restart retains the previous checkpoint as history and creates a new attempt. It requires fresh browser inspection, accepted managed-resume evidence, and a new current-attempt readiness packet. A stored review packet cannot complete the new attempt. A missing or ambiguous matching finished attempt blocks restart; never rewrite history to make it eligible.
