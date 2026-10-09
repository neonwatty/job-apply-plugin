# Recovery preserves attempt input scope

Slice 4h is on `codex/agent-workflows-12-recovery-scope`, stacked on [PR #202](https://github.com/neonwatty/job-apply-plugin/pull/202). It fixes the executor limitation identified in the [attempt guidance comparison](attempt-guidance-model-eval.md).

## Contract

An attempt binds its input fingerprint when a new task is acquired or explicitly restarted. Every later event retains that fingerprint, including expired-claim recovery and terminal handoff/cancellation. Recovery restores the broker's private capability for the same task; it does not confirm or adopt new inputs.

Progress and `awaiting_review` handoff compare current inputs with that retained fingerprint before executing a canonical mutation. A mismatch returns `stale_revision` without writing a session, receipt, history entry or claim. Existing preflight and readiness checks still apply when the fingerprint matches. Read-only guidance continues to report changed inputs and omits progress.

Explicit expired recovery remains available after input drift so the user can release the claim safely. Needs Info handoff and cancellation can preserve the checkpoint and release the claim while retaining the task's original fingerprint in its terminal receipt. Continuing with changed inputs requires a fresh preparation/acquisition cycle and a new task. Queue revisions are part of the fingerprint even when the selected resume/facts remain ready.

Replay returns its historical receipt without executing domain work or restoring capability in a replacement broker. Repeated recovery keeps the same input fingerprint. Exact task/job revisions, profile access and explicit user-event attestation remain required as before.

## File map

| File | Responsibility |
| --- | --- |
| `src/app/claim-workflow.ts` | Retain task input fingerprint and guard progress/review handoff against drift |
| `runtime/app/claim-workflow.js` | Generated installed implementation |
| `tests_js/workspace_recovery_scope.test.mjs` | Real native Store and installed-broker regression scenarios |
| `skills/job-apply/references/experimental-workflow.md` | Explain recovery capability and changed-input safe exits |

## Verification scope

The new regressions use a supported run-queue update while the job remains claimed. Preflight stays ready, isolating the task fingerprint guard from canonical preflight. They cover both safe exits, exact-revision rejection, unchanged bytes after rejection/replay, token rotation, repeated recovery, checkpoint preservation, fresh-task rebinding, unchanged-input progress/review and the installed command route. The prior implementation fails three of the four new cases; unchanged-input recovery passes.

This is deterministic regression and installed-host coverage, not a new model comparison or browser-filling acceptance. The earlier model report stays pinned to its measured revision. No persisted schema migration is introduced: already-written task/receipt fingerprints are retained as recorded; the fix does not reconstruct acquisition scope for a task previously rebound by an older recovery. Publication receipts are under `.workflows/local/agent-workflow-experiment/slice12-*`.
