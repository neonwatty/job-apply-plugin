# Workflow retention and recovery design

Status: read-only planning leaf implemented; archival remains a design for the bounded experimental ledger. Baseline: PR #206,
`21999d2d724033c7e90c2a87a7e360e37ad8eba3`. This document does not authorize
history deletion or claim that capacity has been reclaimed.

## Existing contract and pressure

`workflow-tasks.ts` validates a closed v1 ledger in
`jobs.metadata.agentWorkflows`: at most 64 task records, 256 accepted receipts,
and 1,048,576 serialized JSON code units. There is one active or waiting task. Each
receipt must reference a retained latest task with matching job/workflow identity
and a revision at least as recent as the receipt's task snapshot. No timestamps
exist for oldest-first retention decisions.

`runDurableOperation` checks current authorization before looking up the operation
ID. A matching fingerprint returns the exact historical receipt before current
revision checks, with no domain work. A changed fingerprint fails with
`operation_conflict`. New operations fail with `history_full` at capacity.
Deleting receipts would lose that distinction and permit old operations to run
again. Deleting terminal task records alone invalidates their receipts.

`ClaimWorkflow` allows routine work only with at least three remaining receipt
slots, recovery with two, and terminal handoff/cancellation with one. These are
capacity guards, not guarantees that canonical claim checks or authorization will
pass. Repeated broker loss can consume the last recovery slot: at one free slot,
a lost private bearer prevents handoff and the recovery guard refuses another
receipt. An active task alone can consume the receipt limit; archiving terminal
tasks alone would not solve that case. Heartbeats consume no workflow receipt.

Preparation pending question IDs, task/job revisions, and input-scope hashes are
part of the live protocol. Application pending fields and handoff checklists live
in canonical sessions. Archival must preserve both without copying applicant
answers into workflow metadata. A terminal task can also coexist with a newer
claim for the same job; task identity must govern capability retirement.

## Recommended first implementation

`workflowRetentionReport` in `src/contracts/workspace/workflow-retention.ts`
validates a v1 ledger and returns a pure, read-only report. It reports:

- Current task and receipt counts, limits and free slots.
- Serialized JSON pressure measured in UTF-16 code units, matching the existing
  codec's `JSON.stringify(ledger).length` limit exactly. This is not a UTF-8 byte count.
- Capacity-only booleans for a new task, one receipt, routine claim work, and
  recovery under `countCapacity`; these do not assert byte eligibility, domain
  eligibility, authorization or broker ownership. The next receipt/task size is
  unknown, so count availability alone cannot guarantee an operation will fit.
- The active/waiting task ID and counts of receipts pinned to it.
- Terminal task IDs and the count of their associated receipts as *potential*
  whole-task archive candidates. Sort IDs lexically for stable output; do not
  claim that this is chronological order.
- A fixed indication that no executable archive or reclaimed capacity exists.

Validate at the boundary, return detached value-free results, and never mutate
input or perform I/O. Keep candidate lists bounded by existing limits. Do not
expose fingerprints, original scopes, pending request IDs, session contents,
claim material, or historical receipts merely to describe capacity. A terminal
candidate is provisional: the planner lacks canonical claim/journal state.

This leaf API can be called inside an existing Store transaction after recovery.
It should have no facade, Store, journal or persisted-format changes in its first
package. Integration into existing inspect responses is a separate owner decision
because those responses are shared with approval/browser work. The current
`history_full` behavior and tests remain valid. The report makes the limit
inspectable; it does not remove the production retention blocker.

## Semantics required before any archival writer

1. Preserve every accepted operation ID, fingerprint and exact historical receipt
   for the lifetime of the Store. An operation ID stays reserved across tasks,
   workflow kinds, job trash/restore and process replacement. A tombstone with
   only a fingerprint can reject collisions but cannot satisfy exact replay.
2. Resolve receipts and task identity from the union of hot metadata and durable
   archive before treating an ID as new. Authorization still precedes disclosing
   a historical result. Preparation cancellation, claim safe exit, renewed host
   approval, and private bearer behavior retain their existing rules. Archive
   lookup must expose the original receipt's input scope to trusted review.
3. Keep the current active/waiting task record and pending question binding hot.
   Preserve its original input scope through recovery. Older receipts for that
   task may eventually move, but their historical snapshots remain exact and
   their task linkage must be checked against the current hot record. Whole-task
   archive candidates cannot include an active/waiting task or a task implicated
   in an unresolved canonical claim or journal.
4. Archive terminal task identity and all relevant receipt snapshots together.
   Archive lookup must not require a currently available canonical job. Existing
   exact replay after job trash remains valid and cannot resurrect the job.
5. Never persist a broker bearer, browser capability, approval grant or expiry in
   the archive. Reading/replaying acquisition never restores authority. Replaying
   a terminal operation retires only its own in-memory task capability.
6. Preserve existing revisions and historical outcomes. Archival is a storage
   change, not a workflow event, and consumes no operation ID or task revision.
7. No time-based expiry, silent eviction, best-effort empty lookup on I/O failure,
   or fallback to re-execution. Corrupt, missing or conflicting committed archive
   data fails closed with a distinct storage error before canonical writes.

## Storage choice and boundedness

A finite total collection of receipts cannot support unlimited accepted
operations with exact historical replay. Production retention must either allow
total archive growth on disk or explicitly stop accepting new operations at an
advertised archive capacity. It must not imply that bounded hot memory means
bounded lifetime disk usage.

The smallest correct archival experiment can use bounded immutable archive
segments with an explicit finite segment/index capacity and fail closed when that
capacity is exhausted. This extends the acceptance horizon without quietly
changing replay. State the additional capacity and full-state behavior in the
format. Do not present this as a permanent solution to sustained use.

For continuing growth, prefer an immutable paged index keyed by the exact
operation ID, with bounded pages/segment sizes and bounded reads per lookup.
An entry holds the exact ID plus its fingerprint and receipt location; digest
hashes alone cannot serve as exact collision detection. Task identities need a
parallel lookup or explicit receipt linkage. A fixed-size in-ledger tombstone map
recreates the same limit; an unbounded JSON map or directory scan moves the
problem into every transaction. Page splitting/root changes introduce another
journaled operation and must be reviewed as such. Choose the index strategy and
disk-full behavior before implementing a writer.

## Atomic publication and recovery

Today preparation writes selection and ledger in one `jobs.json` replacement.
Claim operations publish a coordinator journal containing the exact predecessor
ledger fingerprint and next ledger, then recover jobs/session/authority/history/
coordinator effects. Both workflow adapters execute under the canonical Store
lock. Bootstrap and ordinary native transactions recover pending work first.

A safe archive publication sequence under that same lock is:

1. Complete existing coordinator recovery, validate hot/archive state and compute
   the deterministic move. Stage immutable archive data and any index pages with
   private, owned, bounded file checks and the existing persistence primitives.
2. Make archive data durable before publishing its reference. If a process dies
   before publication, hot history remains authoritative; unpublished files are
   garbage, never accepted replay evidence.
3. Publish one recoverable commit that atomically changes the archive root and
   removes the corresponding hot entries. The journal needs exact predecessor
   and resulting roots, not only the old ledger hash. Recovery may observe only
   the full predecessor or the full successor, and is byte-idempotent.
4. Remove disposable staging only after validating its exact namespace and
   ownership. Never delete committed segments during hot compaction.

Preparation needs archive-aware atomic publication too; calling an archive write
and then `saveJobs` without a durable publication boundary is insufficient.
Claim journal recovery must validate all destinations and archive collisions
before its first canonical write. An archive-only maintenance operation needs a
bounded recognized recovery shape or a clearly separate journal recovered in a
specified order. A missing archive reference is never treated as an empty ledger.
A recovery capacity reserve must still work when only the active task has history;
otherwise the existing repeated-loss limitation remains.

## Integration ownership and compatibility

| Surface | Required change for actual archival |
| --- | --- |
| `src/contracts/workspace/workflow-tasks.ts` | Versioned hot/archive references and union task/receipt validation; retain strict bounds |
| `src/contracts/workspace/jobs.ts` | Understand supported metadata without resetting unknown versions |
| `src/harness/task-store.ts` | Transaction-local receipt/task lookup and capacity/compaction capabilities |
| `src/harness/run.ts` | Global replay/collision lookup before new execution and revision checks |
| `src/app/preparation-workflow.ts` | Authorization resolves archived task identities |
| `src/app/claim-workflow.ts` | Historical review and authorization use union lookup/original scope; shared capacity policy |
| `src/app/attempt-guidance.ts` | Report actual post-compaction capacity without granting actions |
| `src/store/native-workflow-tasks.ts` | Preparation archive publication under existing lock |
| `src/store/native-claim-workflow-tasks.ts` | Claim staging and archive-aware commit |
| `src/contracts/workspace/workflow-journal.ts` | Exact predecessor/result including archive root |
| `src/store/native-claim-journal.ts` | Validate/project archive references before canonical writes |
| `src/store/native-store-layout.ts` | Closed archive/staging namespaces, ownership and bounds |
| `src/store/native-store-bootstrap.ts` | Recover archival before ordinary Store access |
| `src/store/native-jobs.ts` | Same recovery in facade transactions; extract a leaf if changed |
| New archive contract/adapter leaves | Segment/index codec, bounded reads and immutable publication |
| Matching `runtime/` modules | Deterministic generated mirrors |

`native-jobs.ts` and bootstrap are shared owned files. Any implementation package
must name extraction targets when editing an oversized baseline file and agree
on one owner for facade/bootstrap changes. Do not place storage-dependent archive
lookups inside synchronous shared JSON codecs.

Keep v1 stores readable with an empty archive. Migration must run under the Store
lock after pending v1 recovery and preserve receipts exactly. Use an explicit v2
metadata format when archived entries cease to exist in the v1 ledger; hiding an
archive beside otherwise valid v1 metadata risks older code accepting an old ID
as new. Existing builds reject unsupported workflow metadata during ordinary jobs
validation. Therefore v2 adoption requires an intentional supported-version
upgrade and downgrade prohibition; it affects ordinary Store access, not only
experimental commands. New archive directories also affect layout validation,
clone/backup/privacy inventories and packaged artifacts. Do not mix Python and
TypeScript writers during this migration.

## Ordered migration packages

Each package lands behind the experiment boundary and preserves v1 behavior until
its dependent recovery and readers exist. One integration owner controls shared
contracts, application facades, Store facade and bootstrap throughout.

1. **Planning leaf (this package).** Ship the pure capacity report, bounded tests
   and generated mirror. No migration, archival writer or reclaimed space.
2. **Format and lookup contract.** Decide finite archive capacity versus a growing
   paged index, document disk-full behavior, define closed v2 root/segment/index
   codecs, and add transaction-local union receipt/task lookup interfaces. Keep
   v1 adapters working. Test exact IDs, duplicate/conflicting entries and bounds.
3. **Private archive persistence and recovery.** Implement immutable file writes,
   root publication and its bounded journal under the canonical lock; wire both
   bootstrap and ordinary Store recovery, with path/ownership checks. Add crash
   checkpoints and read-only v2 opening before allowing migration. Resolve clone,
   backup and packaged layout compatibility here.
4. **Dispatch and approval integration.** Change preparation/claim authorization,
   durable dispatch and trusted historical review to union lookup. Preserve
   original scopes after trash and safe-exit/revocation rules. Exercise archived
   replay/collision and replacement-broker tests before any compaction is enabled.
5. **Explicit migration and compaction.** Recover pending v1 operations first,
   publish v2 atomically, then move terminal histories and old active-task receipts
   with one recovery boundary. Preserve the current pending binding and canonical
   session. Prove repeated broker-loss recovery can obtain capacity when the only
   task is active; otherwise retain an explicit documented capacity limitation.
6. **Integration release gate.** Run affected, native crash, package/upgrade and
   downgrade tests in the integration owner's serialized queue. Document supported
   Store versions, capacity exhaustion and restore behavior before broader use.

Migration and compaction must stay disabled until packages 2–4 are complete.
The planning report alone leaves repeated broker-loss exhaustion unresolved.

## Verification contract

For the planning-only leaf, isolated deterministic tests cover empty, terminal,
active, waiting, all receipt-capacity thresholds, task saturation, receipt
saturation, invalid/future ledgers, stable detached results and input immutability.
Existing tests remain unchanged and still assert no eviction at capacity. Build,
type and size checks establish the leaf and generated mirror contract.

For an archival writer, add focused integration tests covering:

- More than 64 completed tasks and 256 receipts across hot/archive boundaries,
  including long active tasks and repeated recovery with original scope.
- Exact replay and changed-payload collision after archival, trash, restart,
  replacement broker, profile revocation, renewed trusted approval and unrelated
  later claims. No new domain write and no bearer restoration on replay.
- Waiting question/request preservation and pending application fields/checklists
  preserved through archival/recovery; unrelated Store bytes remain unchanged.
- No mutation at archive capacity, missing/corrupt index/segment, operation/task
  collision, unsupported version, bad ownership/link/path, or disk write failure.
- Real process termination at archive file/index publication, journal publication,
  hot metadata replacement and journal clear. Fresh ordinary Store access recovers
  before inspect/replay; repeating it preserves bytes and exact receipts.
- Concurrent dispatch and maintenance use one lock; identical operation IDs
  cannot be accepted independently on opposite sides of an archive boundary.
- v1 migration with a pending claim journal, untouched v1 without migration, and
  explicit fail-closed behavior of older builds on v2.

Relevant existing suites are `workspace_durable_preparation`,
`workspace_durable_selection`, `workspace_durable_crash`,
`workspace_durable_claims`, `workspace_durable_claim_crash`,
`workspace_recovery_scope`, `workspace_host_approval`,
`workspace_saved_handoff`, and `workspace_attempt_guidance` in `tests_js/`.
The integration owner runs the affected selection against the intended base and
serializes heavy native/crash/release gates. No live browser, owner Store or real
model run is needed to design or verify the planning leaf.
