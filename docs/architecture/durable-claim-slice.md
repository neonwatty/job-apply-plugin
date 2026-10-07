# Durable claim workflow (slice 3b)

Branch: `codex/agent-workflows-04-claims`, stacked on PR #194 at `6182ae835b9440c97ee335beada271796f3a4bca`. The PR targets `codex/agent-workflows-03-durable` while its dependencies remain open.

## Behavior

`application.attempt@1` runs one claim-owned attempt. Code validates the event, current task/job revisions, capability access and canonical domain guards. The broker owns the private claim bearer in memory. The Store owns jobs, claims, sessions, application authority, history and workflow receipts.

Supported events:

| Event | Canonical effect | Workflow result |
| --- | --- | --- |
| `acquire` | Ready job becomes In Progress and gets a claim | New active task |
| `restart` | Existing review-restart guards preserve prior review evidence | New active task |
| `recover` | Explicit same-job expired-claim recovery rotates the bearer | Existing task advances |
| `progress` | Existing progress validation updates the canonical session | Task advances |
| `handoff` | Session/history update; claim released to Needs Info or Awaiting Review | Attempt task finishes |
| `cancel` | Valid Needs Info handoff preserves canonical session/checklist and releases claim | Task cancelled |

Acquisition, review restart, recovery and cancellation require separate trusted host attestation matching the entire normalized event. The restart event attests that the prior application was not submitted. This is a host contract, not independent proof of a human's identity. Routine progress and handoff still require the broker's private bearer and the existing canonical guards. Awaiting Review requires current readiness evidence; no final submission action is available.

A Needs Info handoff ends this attempt task. The canonical job/session owns the pause and preserved checklist. After required information is available, explicit preparation/selection can ready the job and a new attempt task can acquire it. This does not create a second copy of the pending application questions in workflow metadata.

## File organization

| File | Responsibility |
| --- | --- |
| `src/contracts/workspace/claim-workflow-domain.ts` | Narrow staged domain port |
| `src/contracts/workspace/workflow-journal.ts` | Ledger predecessor fingerprint, validation and idempotent recovery projection |
| `src/contracts/workspace/workflow-tasks.ts` | Additional closed claim outcomes and broker-unavailable error |
| `src/workflows/applications/attempt-session.ts` | Decode known nested session/readiness revision strings to canonical exact integers |
| `src/workflows/applications/attempt.ts` | Closed event schema, registered tools/profile, safe exit classification |
| `src/app/claim-workflow.ts` | Durable dispatcher composition, broker-private bearer, access/revision checks and serialized lifecycle |
| `src/store/native-claim-workflow-tasks.ts` | Stage existing ClaimsService operations and attach a receipt before journal publication |
| `src/store/native-claim-journal.ts` | Recover workflow metadata together with canonical claim effects; journal session-only progress |
| `src/integrations/host/claim-broker.ts` | Translate private socket requests into events; maintain heartbeat lifecycle |
| `src/cli/attempt-broker.ts` | Optional trusted authority factory; existing installed authority remains the default |
| `src/cli/experimental-claim-workflow.ts` | Explicit synthetic-Store server/client commands |
| `src/cli/experimental-files.ts` | Bounded input-file reader shared with preparation CLI |
| `tests_js/workspace_durable_claim*` | Lifecycle, broker replacement, capacity, scope and crash tests |

Every TypeScript file has its generated runtime mirror. Shared journal code depends on shared contracts, not application workflow modules. Public task commands and installed prompts are not connected to the experimental workflow yet.

## Persistence and retries

The existing `coordinator-journal.json` operation can carry an optional `workflow` envelope: a fingerprint of its predecessor ledger and the intended next ledger. Existing non-workflow claim operations retain their shape and behavior. Workflow progress uses a new closed journal kind containing its validated session, current claim and workflow envelope; it does not fabricate an application history event.

Before publishing the journal, the adapter stages exactly one canonical operation, verifies current access again after asynchronous domain work, and builds the accepted receipt. Recovery validates the journal and ledger predecessor before canonical writes. It projects the job and ledger into the same `jobs.json` replacement, then restores any session/authority/history/coordinator effects and clears the journal. Ordinary native Store access finishes pending recovery before dispatch or replay lookup.

An identical operation ID/payload returns its historical receipt without rerunning the operation. A changed payload under the same ID fails. A receipt indicates that the canonical operation was accepted; it never grants browser authority or returns a bearer. After broker death, replaying acquisition cannot restore its token. Explicit recovery is allowed only when the existing claim has expired. If a response fails after journal publication, recovery may still complete the operation; inspect/replay before issuing a new event.

The ledger retains the existing 64-task/256-receipt limits without eviction. Routine work reserves two receipt slots; explicit recovery reserves one for terminal handoff. Repeated broker loss near saturation can still exhaust recoverability through this bounded experimental ledger. Existing claim services remain the authority for manual recovery/handoff, and retention/archival plus reconciliation are required before production rollout. Heartbeats use the existing coordinator service and do not consume task receipts.

Workflow metadata contains references, revisions, fingerprints and fixed outcomes. Canonical sessions and claim hashes remain in their existing documents/journal; raw bearer tokens never enter the journal, receipt, or public response. Older experimental builds may reject the new outcomes or pending journal kind; do not downgrade an active experimental Store or mix Python/TypeScript writers.

## Experimental CLI and host boundary

Use `runtime/cli/experimental-claim-workflow.js`:

- `serve --root /absolute/synthetic-store --native-lock /absolute/native-lock.node` starts the foreground broker. Stop this owned fixture process with SIGTERM; its claim is retained if still active.
- `context` with the same explicit paths reads the current task and whether this broker has a live claim capability.
- `event --input /absolute/event.json` sends a closed event. Add `--host-user-event` for the events requiring attestation.

Events contain `kind`, `operationId`, `taskId`, `expectedRevision`, `jobId`, and `jobRevision`. Revisions are decimal strings. This also applies to nested session `attemptRevision`, browser-handoff `revision`, and readiness attempt/observation revisions; the adapter converts those known fields to canonical exact integers. Safe numeric nested revisions remain compatible; unsafe JSON numbers are rejected. New acquisition/restart requires null task ID/revision; subsequent events use the last accepted receipt. Progress, handoff and cancellation also carry `session`. Handoff includes `status` (`needs_info` or `awaiting_review`). The CLI does not auto-launch a broker, access a default Store, install a plugin, or drive a browser. Both ends require an initialized synthetic fixture marker. The existing private socket/lock prevents concurrent broker ownership for that Store.

This demonstrates deterministic broker-mediated Store operations. It does not mediate the host's independent browser/shell tools, prove exactly-once external-site execution, or establish an improved live-model user experience.

## Validation checkpoint

The initial checkpoint passed 62 focused and regression tests, including 41 new claim workflow tests. Independent review then identified a nested large-revision conversion bug; a regression test and explicit revision decoder were added before publication. Focused tests exercise acquisition/progress/replay, safe cancellation after revocation, review/restart guards, broker loss and explicit expiry recovery, operation collisions, concurrent acquisition, staged revocation and journal-write failure. Real child processes are killed after journal publication, job replacement, applicable session replacement, history checkpoint, coordinator replacement and journal clear for acquisition, recovery, progress, handoff and cancellation. Fresh native access then checks canonical state plus the receipt and byte-idempotent replay. These are process-crash tests at durable write boundaries, not power-loss tests or new coverage for every internal temporary-file syscall.

The separate-process fixture CLI test kills the actual broker, starts a replacement, proves acquisition replay cannot restore its bearer, explicitly recovers the expired fictional claim, and cancels through a preserved handoff. Final review, test counts and publication receipts are recorded in the PR.
