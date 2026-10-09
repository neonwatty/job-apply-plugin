# Safe exit with a saved pending-question checkpoint

Slice 4i is on `codex/agent-workflows-13-saved-handoff`, stacked on [PR #203](https://github.com/neonwatty/job-apply-plugin/pull/203). It lets an experimental attempt stop safely without asking the model to reconstruct saved question text from fingerprints.

## Contract

A `cancel`, or a `handoff` targeting `needs_info`, may provide `savedSessionFingerprint` instead of `session`. The two fields are mutually exclusive. Progress, acquisition, recovery, restart and awaiting-review handoff cannot use this reference. Existing observed-session events keep their contract.

For a current active checkpoint with pending questions, context supplies its fingerprint and pending-field count, and safe-exit templates need only a new operation ID. `sessionRequiresObservation` remains true for progress: original questions cannot be reconstructed from persisted fingerprints. If the saved checkpoint is from another attempt or is not active, there is no saved-checkpoint template; the existing observed-packet route remains necessary.

Execution rechecks the task/job revisions, private claim capability and exact saved checkpoint under the Store lock. Any intervening checkpoint change invalidates the reference. The operation copies the canonical session, changes only `updatedAt`, and performs the existing journaled Needs Info transition, claim release and workflow receipt commit. Step, pending references, sensitive-field metadata, answer references, blockers, readiness, approvals and browser-handoff metadata remain historical state. No answer is resolved, consent granted, observation refreshed or browser action authorized by this copy.

Cancellation still requires the exact explicit host-event attestation. Input drift and profile revocation still allow the guarded safe exit. Recovery after broker loss retains its existing explicit-request and expiry requirements. A matching replay returns its prior receipt without another write or restoring a private claim capability.

The ordinary claim/session JSON interfaces and persisted schemas are unchanged. A shared internal handoff commit helper keeps both existing observed-session handoff and saved-checkpoint handoff on the same journal path. No legacy Python writer runs against these Stores.

## File map

| File | Responsibility |
| --- | --- |
| `src/contracts/workspace/saved-claim-session.ts` | Exact canonical fingerprint, eligibility and locked saved-checkpoint validation/copy |
| `src/workflows/applications/attempt.ts` | Closed, mutually exclusive experimental event forms |
| `src/app/attempt-guidance.ts` | Historical checkpoint reference and safe-exit templates |
| `src/app/claim-workflow.ts` | Forward the reference through the guarded operation |
| `src/contracts/workspace/claim-workflow-domain.ts` | Internal domain call contract |
| `src/store/native-claim-workflow-tasks.ts` | Restrict saved references to safe exits and stage the journal operation |
| `src/workspace-core/claims.ts` | Saved handoff and shared handoff commit path |
| `tests_js/workspace_saved_handoff.test.mjs` | Native and installed-host regressions, stale references, recovery and crash replay |
| `tests_js/workspace_attempt_guidance.test.mjs` | Progress still needs observations; saved safe exit retains pending work |
| `skills/job-apply/references/experimental-workflow.md` | Invocation and truthful historical-state guidance |

Runtime files are generated one-to-one from TypeScript. Tests use isolated fictional Stores and no browser filling. This slice provides deterministic and installed-host evidence; no new model-UX or live application acceptance is claimed. Model trials for pending sessions, changed-input recovery and trusted human-event delivery remain follow-up work. Local review/publication receipts are under `.workflows/local/agent-workflow-experiment/slice13-*`.
