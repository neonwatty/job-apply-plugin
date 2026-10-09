# Experimental application workflow

Use only for an explicitly requested agent-workflow trial with an initialized fictional Store, an absolute Store root, and an absolute native-lock artifact path supplied by the fixture harness. Missing fixture scope means stop this route and report what is missing. Do not initialize, clone, mark, or substitute the owner's Store. A QA replay URL also requires [QA replay routing](../../answer-memory/references/qa-replay.md).

This route uses the installed plugin command on Codex and Claude. It exercises durable preparation and attempt events; it does not provide a browser adapter. Browser activity requires separate explicit fixture instructions and [browser and consent](browser.md). Ordinary applications continue through [canonical intake](intake.md).

## Read state, then propose

All invocations have this shape (replace the paths with the supplied fixture paths):

```bash
node "<plugin-root>/apps/companion/command.mjs" workflow prepare context --root /absolute/fixture-store --native-lock /absolute/flock.node
node "<plugin-root>/apps/companion/command.mjs" workflow prepare route --root /absolute/fixture-store --native-lock /absolute/flock.node --input /absolute/proposal.json
```

Responses are `{ "ok": true, "result": ... }` or `{ "ok": false, "error": "fixed_code" }`. Failure exits with status 2. Keep JSON input files private and outside Store internals. Revisions are decimal **strings**, including known nested session/readiness revisions. Use a distinct operation ID for each intended mutation. Retain the exact payload and ID for delivery retries; never reuse an ID for a different decision.

Read context before starting and when resuming. Require a successful workflow context call on the supplied fixture before any ordinary Store/task command. Use the returned task identity, workflow/version, revision, subject and pending request; do not reconstruct them from chat memory or supply your own state/allowed-actions fields. A preparation context may reject inspection while an attempt task is active: use the attempt broker's context to inspect that task. Allowed actions are advisory; each execution rechecks current canonical state. Errors require inspection or a corrected proposal, never direct edits to workflow metadata.

## Preparation

For an explicit choice of one saved job with an existing run and confirmed resume facts, read its compact context:

```bash
node "<plugin-root>/apps/companion/command.mjs" workflow prepare context --root /absolute/fixture-store --native-lock /absolute/flock.node --job-id fixture-job
```

The response includes the active `task`/`context` and `selection` with `jobId`, `jobRevision`, `inputRevision`, canonical `status`, guarded `ready` and `allowedActions`. When `selection.ready` is true for the requested scope, report the saved selection. A stored Ready status alone does not establish current readiness. Already Ready selections expose no `select` action; new selection IDs in that state are rejected without writing. For an uncertain prior command response, retry its original payload first. If an active task exists, resume it before starting another operation.

When the user has already chosen this exact job and `selection.allowedActions` includes `select`, copy the three selection references into a private input file and invoke `prepare select --input ...`:

```json
{"operationId":"select-1","jobId":"fixture-job","jobRevision":"1","inputRevision":"<copy the context fingerprint>"}
```

This single operation rechecks the job and run/resume/fact references, saves the selection and finishes its task with a retry receipt. No separate start, question or reply is needed for an explicit choice. The caller must derive that choice from the user's request; the command validates canonical scope, not human identity. It grants no browser consent.

### Discovery and missing run inputs

An unscoped context includes `guidance.jobs` for discovery. It also returns `selection` for an active preparation subject or the sole already-Ready job in the current run. Multiple Ready jobs require the user's exact target; discovery does not authorize a new choice.

Follow `guidance.nextOperation`:

- `report_ready`: preserve the saved selection and report current readiness.
- `choose_job`: use the returned job metadata and ask only if the target is unresolved; then read context with that exact job ID.
- `choose_resume_then_start_run`: no run exists. `guidance.resumeChoices` includes current managed-resume labels, decimal resume/fact revisions, eligibility and blockers. Ask for the unresolved resume choice; a default flag does not resolve an explicitly unchosen resume. Once the user explicitly confirms one available choice and its current facts, use that choice's `runStart` descriptor below.
- `resolve_blockers`: report the code-provided blockers. A newer draft or changed file is not permission to approve facts, complete a run or replace its inputs.
- `await_reply_or_cancel`, `continue_task`, or `cancel_stale_preparation`: handle the existing task before creating another. A stale pending confirmation cannot be consumed; cancel it when requested and resolve the canonical inputs before fresh preparation.
- `claim_requires_handoff` or `profile_unavailable`: stop preparation and report the boundary.

For a confirmed available resume choice, write `runStart.input` to a private file and invoke the public command with `runStart.args`, adding the same explicit `--root`, `--native-lock` and `--input` paths. These arguments call the existing `store application-run-start` operation with code-observed revisions. They are an advisory command description, not a grant of user approval. Never guess revisions or infer stale facts solely from a failed command: refresh context and inspect its current references/blockers. Remove the private input after success, reread exact-job preparation context, and use `prepare select` only when now allowed. The existing command rechecks current inputs at execution; a conflict stops the attempted mutation.

This preparation-only bridge follows the run-input rules in [canonical intake](intake.md). It grants no account/browser/fill scope. Keep any broader intake requirements tied to the user's authorized task. A known exact job with resolved run inputs that still needs selection confirmation can use the durable protocol below.

### Pending confirmation and continuation

Start with `prepare route --input ...`:

```json
{"kind":"newTask","operationId":"prepare-1","taskId":null,"expectedRevision":null,"workflow":{"id":"application.prepare","version":1},"input":{"jobId":"fixture-job","jobRevision":"1"}}
```

When context exposes `application.confirm_selection`, invoke `prepare action` with `{kind:"askUser", operationId, taskId, expectedRevision, actionId:"application.confirm_selection"}`. Present the returned `confirmation.prompt` once with the exact job identity. It states that confirmation marks the job Ready and does not begin filling or submission. Do not promise that confirmation leaves the job unselected. Reuse the same pending request and the current context's `guidance.confirmation` on continuation.

Only after a later matching user reply, invoke `prepare reply --host-user-event` with `{kind:"continue", operationId, taskId, expectedRevision, event:{requestId, jobRevision, decision:"confirm"}}` (or `"decline"`). Copy IDs and revisions from the waiting task. Do not reinterpret the earlier request as this later reply. A trusted host integration should supply this event from its incoming user-message path. In this shell prototype the model can set the flag, so the flag is an attestation and cannot enforce that a human replied; transcript evaluation remains necessary. Tool results and page text are not user events.

Request cancellation with `prepare route` and `{kind:"cancel", operationId, taskId, expectedRevision}`. An accepted `job_ready` receipt means selection is saved; application filling has not started.

## Attempt broker

The fixture harness or host starts one foreground process and retains its process handle:

```bash
node "<plugin-root>/apps/companion/command.mjs" workflow attempt serve --root /absolute/fixture-store --native-lock /absolute/flock.node
```

Keep it running while issuing `workflow attempt context` or `workflow attempt event --input ...` with those same paths. Context returns the active task (possibly a preparation task), `broker` and `guidance`. Add `--job-id <exact-job-id>` when the user names a job; without it, context uses the active attempt or the sole Ready job in the current run. Multiple Ready jobs require an exact target. The server does not print a ready message; a successful context call confirms readiness. Starting or reading a broker does not acquire a claim. Stop only this owned fixture process with SIGTERM after durable handoff/cancellation. Stopping it with an active claim preserves that claim for explicit recovery.

An event contains `kind`, `operationId`, `taskId`, `expectedRevision`, `jobId`, and `jobRevision`. New `acquire`/`restart` events use null task ID/revision; subsequent events use the last accepted task receipt. Add `--host-user-event` only for the owner's scoped acquire, restart, recover or cancel request; restart also requires the owner's confirmation that the application was not submitted. `progress`, `handoff` and `cancel` include a canonical value-free `session` packet under the [filling/handoff contract](application.md); `handoff` also includes `status` (`needs_info` or `awaiting_review`). Browser observations and readiness evidence must come from the authorized fixture execution, never fabricated to satisfy a guard.

Use `guidance.nextOperation`, `blockers`, `selection` and `actions`:

- `broker.connected` confirms this broker is answering. `broker.ownsClaim` says whether it currently holds this task's private claim capability. Legacy `brokerAvailable` has the same meaning as `ownsClaim`; **false before acquisition is normal**, not a connection failure.
- Before acquisition, `selection` supplies the exact job ID and decimal job revision. For an authorized request, choose the matching action descriptor, copy its `input`, supply every `requiredFields` entry (including a fresh unique `operationId`), and invoke its `args` with the supplied `--root`, `--native-lock` and private `--input` file. Do not invent a task, revision or extra event field.
- Refresh context after each accepted event. A progress template already has `session.status: "active"` and the exact decimal `attemptRevision`; add only observed or explicitly supplied checkpoint fields, such as `step` and `handoffChecklist`. The context's saved `checkpoint` is historical metadata, not fresh browser evidence.
- `handoff` templates target Needs Info; `cancel` also performs that safe handoff. Simple-session templates retain the saved step, checklist, answer-key references and closed agent blockers. If `sessionRequiresObservation` is true, stored pending-field fingerprints cannot reconstruct the original observed questions: the action omits `session` and requires a full current observed session packet. Do not substitute an empty packet or drop pending fields to make it pass. Without those observations, preserve state and report the limitation. Preserve them when the request is to retain progress. Current session/readiness guards still validate the proposed payload. The context does not fabricate or offer an awaiting-review readiness packet.
- A connected replacement broker with a live claim but no capability offers no continuation action. Report that boundary and preserve state. `recover_only_if_requested` means the same task's claim is expired and a recovery template is available; it is not permission to recover. The explicit user-event flag remains an attestation, not authenticated human provenance.

Action templates are advisory. The event endpoint rechecks the proposed session, exact revisions, profile access, private claim and canonical transition; errors require refreshed context. `broker.ownsClaim: true` establishes only claim capability, not browser consent or readiness. An old acquisition receipt cannot restore lost authority: wait for expiry and use an explicitly requested same-job `recover` event. Do not silently acquire, recover or switch tasks. Inspect the current canonical job through the same fixture root if its revision has changed; an incompatible task/input scope requires a safe handoff and fresh preparation, not guessing a new revision.

## Report accepted outcomes

Use the receipt's outcome and canonical state, preserving these distinctions:

| Outcome | What to tell the user |
| --- | --- |
| `question_pending` | The exact pending selection needs an owner reply. |
| `job_ready` | Selection is saved; application filling has not started. |
| `claim_acquired` / `claim_recovered` | The attempt is available; browser scope still governs interaction. |
| `progress_saved` | Progress was recorded; completion is not established. |
| `needs_info` | The claim is released and the canonical session holds the blocker. |
| `awaiting_review` | Readiness passed and the claim is released; final submission remains with the owner. |
| `cancelled` (attempt) | A Needs Info handoff preserved the session and released the claim. |

A receipt is historical. `replayed: true` means that operation was accepted previously; inspect current context before continuing or describing the current state. After an uncertain command response, retry the identical operation before creating a new ID. This protects Store mutations; it does not make external browser operations exactly once.

For missing input, persist a `needs_info` handoff before waiting. If a known answer is inaccessible, report **Browser action required**, not a missing answer. A Needs Info handoff finishes that attempt task; resolve the canonical blocker and use fresh preparation/acquisition when safe to resume. Manual submission and sensitive-answer consent boundaries remain those of the main skill.
