# Explicit selection (slice 4c)

Branch `codex/agent-workflows-07-selection`, stacked on PR #197. The [first model comparison](preparation-model-eval.md) found that exact choice took longer through a start/question/reply lifecycle and that the model consumed its own pending question. This slice gives an explicit choice one deterministic mutation.

## File organization

| File | Responsibility |
| --- | --- |
| `src/app/preparation-selection.ts` | Closed selection request, compact canonical context, revision/scope guards and atomic finished-task receipt |
| `src/app/preparation-workflow.ts` | Compose the new selection operation with existing pending-task inspection |
| `src/cli/experimental-workflow.ts` | `context --job-id` and `select --input` on the existing fixture-only public route |
| `skills/job-apply/references/experimental-workflow.md` | Choose direct selection for explicit intent, resume genuine pending questions and describe the host trust limit |
| `tests_js/workspace_durable_selection.test.mjs` | Scope drift, active-task isolation, access revocation, concurrency and write-boundary retries |
| `tests_js/workspace_host_commands.test.mjs` | Installed-layout commands and fresh-process delivery retries |
| `evals/preparation/run.mjs` | Optional exact candidate revision for repeated comparisons with the pinned baseline |

Changed TypeScript modules have generated `runtime/` counterparts. This remains the same plugin and experimental fixture-only route. Ordinary commands, discovery, metadata version and the existing pending protocol remain compatible.

## Deterministic operation

`prepare context --job-id <exact-id>` returns the existing active task projection plus a small `selection` object. It exposes the job revision and fingerprint of the current application run, resume and fact references. `ready` requires successful current preflight, available profile access, no active workflow task and stored Ready status. `allowedActions` is advisory; execution repeats canonical checks under the Store lock.

`prepare select --input <private-json>` accepts exactly `operationId`, `jobId`, `jobRevision` and `inputRevision`. The caller derives the exact choice from the user request. Code verifies current access before replay lookup, rejects an occupied task slot or stale references, executes the existing selection service through the tool gateway, rechecks access, and commits one finished task plus receipt alongside the job in the existing atomic `jobs.json` replacement. The task revision is 1, pending is null, and the outcome is `job_ready`.

Retrying the identical operation returns its historical receipt without writing. Reusing its ID with changed input fails. An operation against an old job/input revision fails even if the selected job ID is unchanged. A new ID for an already Ready job can record a new accepted operation; hosts should inspect current readiness and avoid redundant requests. Receipts are not a fresh readiness assertion.

The existing start/question/reply route remains available when a known selection still needs a later decision. Direct selection cannot bypass an active or waiting task. Safe cancellation and ordinary claim/handoff boundaries are preserved.

## User event boundary

Code validates state and input references. It does not authenticate the user's semantic intent. The prototype's shell-visible `--host-user-event` flag remains callable by the model and therefore cannot prove a later human message arrived. The reference now reserves it for a later matching reply and names the incoming host user-message path as the intended trusted source. No cryptographic attestation or new host message adapter is claimed.

This slice removes an unnecessary pending question for an already explicit request. Missing or ambiguous job/resume choices still require clarification; the direct command does not invent them. Browser consent, claims, filling, review and final submission retain their separate boundaries.

## Verification

Focused checks cover the direct path and existing pending/installed behavior. Publication requires the repository review, affected selections, installed release and exact-commit local gates. Model comparison uses three repetitions per arm with the same prompts and pinned baseline; measurements and their limits are recorded separately once complete.
