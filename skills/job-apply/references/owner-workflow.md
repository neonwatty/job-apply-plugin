# Owner opt-in workflow

Use only when the owner explicitly requests this experimental workflow for one exact saved job. Ordinary applications continue through [canonical intake](intake.md). A Companion instruction, saved preference, context response, or action descriptor is not owner approval.

This slice requires one selected Ready job in the current active application run with its confirmed managed resume and current confirmed facts. It supports bounded browser work through verified manual review or a guarded Needs Info stop. An explicitly requested restart is supported only with complete prior review evidence. When experimental tasks exist for the job, its unique finished attempt must still match the current job revision, active run, managed resume, and confirmed facts. If the job has no experimental workflow task, a complete modern canonical review from the ordinary attempt broker may seed its first owner attempt. That route checks the current confirmed run inputs and canonical review/history; it does not infer a historical experimental input binding. Legacy or incomplete review evidence remains blocked. Do not describe this route as dogfood-ready or infer accepted upload or current browser state from a workflow receipt.

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

Read [browser and consent](browser.md), [filling and handoff](application.md), and [current-form readiness](readiness.md) before interacting with a live form. The owner route supplies no browser tool. Check the exposed host browser tools and read their current documentation; use only documented capabilities within the exact approved scope. Workflow activation alone does not grant consent to enter applicant data or final submission authority. Use the durable approval route below when explicitly authorized; otherwise preserve Guided post-readiness consent. Always preserve managed-resume identity boundaries. Reuse the browser, consent, upload, and readiness rules in those references, but while the owner workflow claim is active never fall back to ordinary `attempt` commands or raw claim commands for acquisition, progress, or handoff. Use only the owner workflow descriptors for those mutations.

Report only current observed browser evidence through the exact template in `hostBrowser.reports`, adding only its listed required fields. Historical checkpoints, stored readiness, and action templates are not fresh browser observations. Never fabricate evidence or empty pending fields to satisfy a guard. Keep applicant values, resume paths, claim tokens, and browser state out of chat and durable session summaries.

## Durable approval through review

An explicit owner request to let this workflow fill one exact application through
manual review authorizes Autofill to Review for that job's current run and Primary
(or other explicitly selected managed resume). Explain the bounded scope in a
non-blocking update: confirmed facts and matching non-sensitive answers, selected
resume upload, one cleared-field repair and non-final navigation; demographics
stay blank, unknown answers and new sensitive disclosures/agreements interrupt,
and submission remains manual. Use a 120-minute grant unless the owner specifies
another supported duration. This exact request is the approval; do not ask for a
second confirmation of the same scope. A mere job selection or saved preference
is not such a request.

Use the canonical `store application-authority-status` and revision-checked
`application-authority-set` commands in [application automation](application-automation.md)
for the exact Ready, In Progress, or Needs Info job with current run inputs. A
Needs Info grant records approval only: it never clears blockers, acquires a claim,
or permits browser actions. Bind only that job and
use `sensitiveAnswerRefs: []`. Reuse an existing matching unexpired grant; do not
replace or extend it on compaction, a status check, or a Needs Info pause. A grant
survives those pauses until expiry, revocation, changed inputs, or accepted review.
Explicit owner stop/pause always stops browser work. Reviewed restarts still need
explicit restart approval. Broader scope or expiry requires renewed authorization.

After acquisition, the owner broker exposes `applicationAuthority.status` in
context. This is a projection, not permission to type. Before each coherent action
group, use the five-field evaluation packet from application automation, add the
required boolean `includesDemographics: false`, and call:

```bash
node "<plugin-root>/apps/companion/command.mjs" owner-workflow authority-evaluate --root /absolute/store-root --input /absolute/private-evaluation.json
```

The packet must describe the actual intended actions and observed interrupts.
Use `includesDemographics: true` for any intended demographic entry; the owner
route always denies it. Never include caller job IDs or claim tokens. The broker
binds its private live claim, rechecks the workflow's inputs and durable grant,
and returns `result.decision`. Continue only on `authorized: true` covering the
intended operations. Do not call ordinary `attempt authority-evaluate` while an
owner broker owns the claim. Unsupported controls or unknown answers still require
a safe pause; authorization cannot supply missing evidence.

After compaction or resumption, reread the installed skill/router guidance and
canonical authority status, inspect the preserved draft, resolve genuine blockers,
and evaluate again through the current owner broker. Do not ask for the same
current, matching approval again. A response or past decision is never a reusable
browser capability. A final review handoff consumes Autofill to Review atomically;
Needs Info preserves it. Current field verification and upload acceptance remain
required before review.

## ATS recovery reservations

For Workday save, session or page-load failures, use [durable ATS recovery](ats-recovery.md)
and the current `hostBrowser.recovery` descriptor. The broker owns retry counters;
never reconstruct them from chat or send replacement counters. A recovery replay
never authorizes another browser action. The ordinary `receipt` command above
accepts only events/reports; after recovery socket loss, inspect current recovery
state and re-observe the draft instead of replaying the browser action.

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

A reviewed restart retains the previous checkpoint as history and creates a new attempt. It requires fresh browser inspection, accepted managed-resume evidence, and a new current-attempt readiness packet. A stored review packet cannot complete the new attempt. When experimental tasks already exist for this job, a missing or ambiguous matching finished attempt blocks restart; never rewrite history to make it eligible. For a first owner attempt, canonical review adoption preserves the prior session until new progress and requires the same explicit restart approval and fresh readiness evidence.

## Same-chat recovery before continuing

Regular supervised dogfooding uses one owning chat per application. Return to
that chat for the existing browser draft. A different chat can inspect durable
state but may have no access to the original browser; an exact URL or old tab ID
does not prove draft continuity. Do not open, reload, navigate or reconstruct a
form to make recovery appear successful. If discovery fails, preserve the
checkpoint and explain that a fresh attempt needs explicit owner authorization.

For a paused Needs Info or awaiting-review job with no owning broker, read fresh
canonical context without starting a broker:

```bash
node "<plugin-root>/apps/companion/command.mjs" owner-workflow recovery-context --root /absolute/store-root --job-id exact-saved-job
```

This command requires an already activated native owner Store. It does not
activate, prepare, acquire, recover or restart; its actions and reports are empty.
It reports inputs as unverified and never upgrades historical review to current
readiness. Resolve Needs Info through canonical preparation before a new attempt;
a reviewed restart still requires explicit authorization. For an active attempt,
use the existing broker's `host-browser-context` instead.

Use the installed `apps/companion/same-chat-recovery.mjs` exported
`sameChatRecovery(context, evidence)` after obtaining fresh canonical owner
context (the command response's `result`). Evidence is exactly
`{chatScope, draft, observation, formScope}`: chatScope/formScope are
`same|different|unknown`, draft is `present|missing|unknown`, and observation is
`current|stale|unknown`. These closed values are host attestations; never pass
URLs, tab IDs, applicant data or screenshots. Compare form identity privately.
An inaccessible frame or uncertain document is unknown, not present/current.

Follow the returned `next` decision:

- `return_to_original_chat`: ask the owner to continue there; do not operate a replacement tab.
- `preserve_checkpoint_request_fresh_attempt`: retain state and obtain an explicit fresh-attempt request before starting another form.
- `inspect_existing_draft`: rediscover and read the existing tab only, then refresh evidence.
- `wait_for_claim_expiry`: preserve the draft; do not steal a live claim or replay browser writes.
- `request_explicit_recovery`: use the current recovery descriptor only with matching owner authorization, then refresh context and reobserve the form.
- `resolve_workflow_blocker`: follow canonical blockers; reviewed or Needs Info jobs do not silently become active.
- `guarded_needs_info`: use an available safe-exit descriptor and release the claim before waiting; never fabricate a descriptor.
- `continue_via_current_descriptors`: recheck current-form consent and resume/input identity, then continue through the existing owner workflow and readiness rules.

Every result denies navigation, browser mutation and submission authority: this
helper supplies guidance, not a grant. Current descriptors and existing consent
rules separately govern subsequent work. Even a current same-form observation
is not a complete readiness packet. Receipt replay proves historical recording
only. Mark the existing tab for handoff before ending the turn; keep all other
drafts untouched. Do not persist chat/browser identities in application sessions.
