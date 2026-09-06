# Autonomous TypeScript migration execution plan

Prepared 2026-09-05 from integration `b2d22412f0d1598059185fce802f7620ab76b5da`.
This is the execution map for the existing migration, not a restart. Package
status belongs in the execution ledger; this document defines dependencies and gates.

## Objective and non-negotiable completion criteria

Replace Python application code and browser JavaScript with modular TypeScript,
retaining necessary Swift native helpers. Preserve the current CLI, HTTP,
persisted schema, privacy, recovery and human-only final-submission behavior.
Deliver an independently reviewed, reproducible release candidate that launches
without Python on every declared supported host/platform combination.

The migration is complete only when all of these are evidenced:

1. Every current Store command (98 today), plus task/attempt/QA/policy interfaces
   and authenticated HTTP routes, has behavioral coverage and a verified TS path.
2. Every canonical write path routes to TS; no reachable Python writer remains.
   Crash recovery, contention, upgrade and rollback pass on required platforms.
3. Installed entry points, browser assets and native adapters use the reviewed
   emitted runtime. No dependency installation or download occurs at launch.
4. Fresh supported host launches, clean installs, upgrades, cold offline runtime
   launch, interruption and rollback pass for the immutable candidate.
5. Production Python and obsolete JavaScript are removed after equivalent TS
   regression coverage exists. Immutable reference fixtures/provenance survive.
6. Every scoped source/test/emitted file is at most 500 physical lines; no
   exceptions, packing, minification or monolithic generated workaround.

Preparing a release candidate is autonomous development work. Publication,
merge, release and activation on live data remain separate authorization gates.
Approval must concern a concrete candidate with its evidence and rollback plan.

## Starting snapshot at b2d2241: reuse completed work

This snapshot is historical. Consult the [execution ledger](migration-execution-state.md)
before assigning work; registration and numeric packages may already be complete.

- Source-size decomposition is complete; the exception baseline is empty.
- TypeScript/build scaffolding exists, but the starting runtime is predominantly
  Python; the checked-in TS foundation is not a completed application port.
- Sixteen Store commands have some reference behavior; 82 remain inventory-only.
  Even the 16 need broader valid/error/recovery coverage.
- Read/startup and 19 profile/fact mutation cases are accepted reference work.
- Raw matching has 42 cases; Python 3.13/3.14 observations are distinct. Python
  3.12 matching evidence is missing; the full matching implementation stays held.
- Raw-reference test registration is the first shared wiring task.
- Runtime launch strategy is unresolved, with zero accepted clean-host cells.
- Previous full validation has three reproduced baseline Python 3.14 assertions;
  it is not a green full receipt. Previously passed suites are not rerun blindly.
- PR49 belongs to the source task. The user retired duplicate legacy validation
  and its 20-PR retention requirement. Do not restore those or treat retirement
  as proof of equivalence. Reconcile actual dependency state before publication;
  independent shadow work continues without waiting for its CI investigation.

The older 90-command design count is historical. Derive the current inventory
from the parser and reconcile additions explicitly. This plan supersedes older
sequencing where writer cutover precedes potentially write-capable broker/QA
ports: all actual writers must move before the atomic switch.

## Execution model: coordinator plus three rotating slots

The coordinator owns shared configuration, package/build inventory, common
interface approval, integration and evidence. At most three subagents operate
alongside it. Initially use two implementation/test workers and one independent
contract or runtime worker. When code completes, rotate a slot into independent
review; never assume three implementers plus extra reviewers fit four slots.

Parallelize independent file families and test oracles, not overlapping edits.
Each package gets an immutable base, dependencies, exact allowed_files, expected
exports, prohibited changes, focused verification and a concrete done condition.
Broad directory names below are allocation families: split them into bounded
packages before dispatch. One worker must not receive an entire multi-domain port.

For isolated worktrees, workers commit only their assigned files and return
immutable SHAs. For a shared checkout, ownership must be equally disjoint and
the coordinator commits coherent changes. Never reset another worker's edits.
Each assignment names the corresponding emitted runtime files; workers may not
stage unrelated outputs from a whole-repository build. The coordinator checks
the complete one-to-one source/emission inventory after integration.

Only the coordinator edits `config/test-matrix.json`, package manifests/scripts,
compiler/build configuration, shared global schemas, CI or package inventories.
Named leaf subdirectories of `src/contracts/` can be delegated explicitly.
There is exactly one Store-facade owner and one workspace-bootstrap owner.
New leaves depend on shared primitives; primitives/facades must not acquire
accidental reverse dependencies on domain leaves.

Worker lifecycle: ready → implementing → focused verification → independent
review → integrated → milestone verified. Failed review returns to the owner;
it does not silently erase earlier failures. An accepted code package can remain
release-blocked by an unavailable platform without being reimplemented.

## Work waves and dependency graph

The matching critical path is numeric atoms → typed JSON boundary → matching
semantics → answer/session mutation behavior → journal integration → all-writer
routing. Storage primitives and runtime distribution are separate critical
paths. UI helpers, other pure policies and contract capture can proceed in parallel.

| Wave | Lane A | Lane B | Lane C | Exit gate |
| --- | --- | --- | --- | --- |
| 0 | Numeric codec | Independent numeric reference/tests | Missing contract inventory and runtime access preparation | Raw tests registered; numeric interface and evidence accepted |
| 1 | Typed JSON parser/scope encoder | Store read primitives | Pure UI helpers | Typed boundary and no-write reader interfaces accepted |
| 2 | Matching/reuse policies | Account/readiness policies | UI feature controllers | Each leaf passes its authoritative contract and independent review |
| 3 | Document reads/projections | HTTP/auth/read routes | Transaction/locking primitives | Read-only shadow paths and platform storage primitives accepted |
| 4 | Profile/facts, then answers | Jobs and lifecycle | Resumes/extraction | Domain writes equivalent on separate disposable clones |
| 5 | Durable accounts/Trusted Fill | Sessions/coordinator/journals | Recorder/renderer ports | Recovery and cross-domain orchestration equivalent |
| 6 | Attempt broker/native adapters | Replay/Chrome/promotion/privacy | Final-action policy and residual writer audit | Every canonical writer and authority boundary accounted for |
| 7 | Integrated CLI/HTTP routing | Independent platform/recovery verification | Independent browser/package/privacy verification | Atomic cutover rehearsal and launch gates pass |
| 8 | Python/obsolete JS removal | Fresh-install/upgrade/rollback verification | Independent completeness audit | Python-free release candidate accepted |

Contract capture is continuous across these waves, staying at least one package
ahead of implementations. Reserve a lane-C runtime/access package at each wave
boundary until the runtime gate is resolved; postpone that lane's next UI/QA
package rather than assuming a fourth worker slot exists. Record the reservation
in the ledger. Runtime work must not starve behind implementation work.

### Wave 0: immediate packages

**0A — numeric codec.** Own `src/contracts/raw-json/**` numeric modules and exact
`runtime/contracts/raw-json/**` counterparts. One token to tagged BigInt/float
and Python-compatible scope spelling; no object parser or production imports.
Preserve signed zero, integer/float identity, non-finite values, overflow,
underflow, digit-limit configuration and binary64 rounding. Substantiate finite
float formatting independently; do not assume JS stringification is equivalent.

**0B — independent numeric oracle.** Own `tools/contracts/raw-json-numeric/**`
and `tests_js/raw_json_numeric*.test.mjs`. Generate controlled synthetic values
from Python, record exact interpreter/configuration and deterministic seeds,
compare grammar, bits and spelling. Cover halfway values, subnormals, powers of
ten and safe-integer neighbors. No oracle may derive expectations from the TS code.

**0C — contract/access inventory.** Enumerate uncovered commands/routes and
their write/recovery/authority effects. Define per-family contracts and identify
available native test cells. Capture Python 3.12 when an authorized existing
environment is available; its absence must not block unrelated pure work.

**0R — reference-profile evidence.** A named predecessor of full matching:
capture existing Python 3.12 behavior, compare Unicode/error/numeric/caller-depth
semantics with recorded 3.13/3.14 evidence, and resolve the reference contract.
If the interpreter is unavailable, mark 0R blocked and run other ready packages.
Do not treat numeric parity alone as resolving the full reference profile.

Coordinator: review/wire the raw reference test, register numeric tests, verify
matrix uniqueness, build, size and fast checks; record current dependencies once.
Do not restart completed diagnostics or reopen PR49 CI ownership.

### Waves 1–3: boundaries and reads

**1A — typed JSON boundary.** Extend only the accepted raw-json subtree. Handle
objects, arrays, strings/escapes, duplicate decoded keys and Python-equivalent
scope serialization. Preserve numeric tags at request, CLI-argument AND persisted
candidate-document ingress. Diagnostic depth/output caps are not production limits.

**1B — read primitives.** Own `src/store/{paths,permissions,read-json,read-jsonl,
validation,startup-validation}.ts` and dedicated tests. Freeze shared path-security
interfaces for later transaction workers. Corrupt/future/legacy/symlink rejection
must preserve bytes and mtimes. Startup/recovery writes are not read-only behavior.
Path and permission work can run alongside 1A. JSON decoding of persisted data
depends on 1A's accepted tagged-value interface; do not fill that dependency with
ordinary `JSON.parse`. Split the package at that boundary to retain safe parallelism.

**1C/2C — browser helpers/features.** Own bounded `src/workspace-ui/lib/**` then
feature subtrees and their tests. Preserve events, exports, authentication and
browser/CLI state parity. One separately assigned owner controls bootstrap.

**2A — matching and answer policy leaves.** Own `src/domain/answers/**` in
sequential matching/reuse/cleanup packages. Full matching stays held until the
typed boundary and agreed reference semantics pass; no reduced scoring-only
scope or Unicode approximation is silently substituted.

**2B — account/readiness policies.** Split `src/domain/accounts/**` and
`src/domain/attempts/readiness.ts` into distinct assignments. Pure functions only;
no filesystem, clock, randomness, credentials lookup or implicit authority.

**3A/3B — reads and HTTP.** One owner ports `src/store/documents/**`; another
consumes the frozen read interface in `src/workspace/` auth/projections/read routes.
Verify Host/Origin/Bearer checks, loopback binding, no-store headers, status/body
contracts and forbidden writes. Live read routing is optional and not needed to
prove the migration; use synthetic shadow comparisons until its gates pass.

**3C — transaction foundation.** Own locking, atomic JSON, JSONL and secure-path
write primitives, consuming rather than duplicating the accepted path layer.
Test exclusive ownership, durability, crash boundaries and at least eight
concurrent TS writers on native required platforms before domain writers depend
on it. Python and TS never write the same fixture concurrently.

### Waves 4–6: mutation domains and authority

Create explicit profile/fact targets under `src/domain/profile/` and
`src/domain/facts/`; the older tree omitted them. Port those first. Then parallelize
`src/domain/answers/`, `src/domain/jobs/` and `src/domain/resumes/` only after their
pure dependencies and transaction interfaces are accepted.

Every mutation package must prove response AND durable-state equivalence for
success, no-op, invalid inputs, stale revisions, conflicts and rejected-state
preservation. Include provenance, permissions, append-only events and relevant
recovery. A successful API response with different stored bytes is a failure.

Give `src/store/journals/**` one orchestration owner, with sequential coordinator,
extraction and account-operation packages. Domain owners expose their contracts;
they do not independently edit shared journal dispatch. Durable account/Trusted
Fill work stays separate from pure account policies and native adapters.

Port recorder/renderer modules under bounded `src/qa/` subtrees in parallel with
the journals. Preserve capture/backpressure, interruption, cleanup, sanitization,
export identities and authority boundaries. Real-account automation is not a
test substitute; use synthetic fixtures and dedicated native tests.

Port the attempt broker and necessary macOS adapters under `src/cli/attempt/`,
`src/domain/attempts/` and `src/native/macos/`. Retain Swift where required.
Exercise leases, heartbeat, bearer lifetime, process loss, recovery and native
identity/attestation without weakening current checks.

Replay, promotion, Chrome supervision, privacy and final-action policy receive
separate small packages. Cover descriptor-relative cleanup, signed tombstones,
rollback, one-winner final-action concurrency and zero unauthorized submissions.
Audit all these paths for Store writes before declaring the writer graph closed.

### Waves 7–8: assemble, rehearse, remove

The coordinator integrates Store assembly, all CLI dispatchers, workspace mutation
routes and compatibility launchers. Rehearse a single writer switch on disposable
upgraded Stores. A Python compatibility launcher may temporarily exec TS, but it
must contain no reachable business logic/write path and must disappear before
the Python-free completion claim. No live mixed-writer transition is permitted.

Complete actual fresh-host runtime acceptance and packaged-browser parity before
activation. A developer machine's Node executable, simulated missing runtime or
container cannot certify a fresh native host/platform cell. Build the reviewed
distribution with modular runtime assets and verified inventory; decide delivery
strategy on evidence, not incidental PATH availability.

After candidate-wide verification, port/remove remaining Python tests while
preserving their regression cases and archived reference provenance. Remove
obsolete production files, update every documented entry point and package
inventory, and verify no packaged path needs Python. Run clean install, upgrade
from the previous version and rollback on the exact final artifact again.

## Validation ladder: rigorous checks at the right frequency

| Level | Required checks | Frequency |
| --- | --- | --- |
| Worker | Focused positive/negative/differential tests; privacy; typecheck; emitted parity; size; file-scope diff | Each meaningful package change |
| Independent review | Contract correctness, missing adversaries, silent failures, interface/ownership and regression risks | Every immutable implementation package; author cannot approve own work |
| Integration batch | Matrix coverage/uniqueness, fast tier, complete build inventory, relevant cross-domain tests | Once per dependency-complete batch |
| Milestone | Full portable suites, native platform suites, cross-domain privacy/recovery and relevant browser checks | Once per integrated wave with material behavior changes |
| Writer rehearsal | Every command/writer, concurrency, crash injection, restart, upgrade and rollback | Before any writer switch |
| Release candidate | Full/platform/release, fresh native hosts, installed bytes/entry points, offline runtime, rollback and removal audit | Exact release candidate; affected gates rerun after repairs |

Golden comparisons retain exact exit code, streams, HTTP headers/body, file bytes,
permissions, journal events and recovered state. Only previously reviewed
normalizations explicitly named by a contract are allowed; never normalize away
numeric, Unicode, missing-error or durable-state differences.

For storage, kill before and after every named write/fsync/rename/journal/cleanup
boundary, then run recovery repeatedly to stable state. Include permission errors,
disk/write failures, symlink/reparse substitution, corrupt/future documents and
contention. Enumerate fault points so an untested boundary is visible.

For numeric/property testing, preserve seeds and any minimized counterexample as
a new reviewed regression case. Require both curated edge cases and generated
samples. Sampling is evidence, not exhaustive proof or a license to narrow inputs.

Maintain a coverage ledger by command/route and scenario class: normal, invalid,
conflict, no-op, concurrency, crash/recovery, privacy, platform. Each cell must be
passed or explicitly inapplicable with rationale; inventory presence is not coverage.

The new test matrix remains the routing source. Retiring duplicate legacy CI
does not remove browser-created-job → CLI visibility or other behavior checks.
Keep affected-selection optimization in shadow until its separately required
observation gate is satisfied; otherwise use explicit relevant/full selections.

## Resource scheduling and failure handling

Pure unit/contract workers can test concurrently. On this machine, only one owner
runs heavy browser/package/native integration at a time; use separate authorized
CI machines to parallelize native OS cells. Record capacity acquisition/release.
Before restarting an interrupted run, inspect its exact process ownership and
existing receipts. Archiving a task does not prove children exited.

Each run has a declared timeout and log cap. Start from the established suite
budget, revise only with measured evidence. On timeout, terminate only owned
process groups, retain partial results and mark incomplete. Do not equate timeout
or platform skip with a pass; do not repeat unchanged full runs indefinitely.

Failure loop: preserve receipt → classify → reproduce minimally → compare the
unchanged base once when relevant → assign bounded repair → rerun focused and
affected gates. After two repairs without new evidence, stop that lane for root
cause review; continue independent lanes. This is a review trigger, never a waiver.
Do not install a different runtime, refresh goldens, drop cases or weaken assertions
merely to make a run green. Baseline defects remain visible until explicitly resolved.

## Durable state and autonomous continuation

At execution start, create `docs/migration-execution-state.md` with one row per
package: ID, dependencies, status, owner, base/head, scope, tests, reviewer, blockers
and next action. Store verbose value-free receipts in a dedicated evidence directory.
Update after every accepted package or changed gate; never rely on task memory alone.

Receipt minimum: exact base/head SHA; allowed/changed files; contract cases;
interpreter/Unicode/runtime/OS; command, seed and counts; start/end; exit status;
skips, failures and timeout; log/artifact hashes; reviewer findings/resolution;
remaining dependencies. Separate inherited evidence from new execution.
Existing runner aggregate status is insufficient: skipped cells can yield passed,
and some tiers omit HEAD. Wrap those receipts with the required provenance.

On each continuation: read ledger → verify branch/dirty state → inspect active
workers/processes → recover receipts → dispatch ready disjoint work → integrate
accepted changes → test/review → update ledger. Reuse workers when helpful;
avoid spawning idle roles or repeating completed investigations.

Autonomy covers ordinary implementation choices, bounded refactors, synthetic
tests, failure repair, local commits, reversible integration and candidate assembly
within the approved scope. Stop only the dependent lane for missing access,
unexplained compatibility/safety differences, overlapping ownership or a real
contract decision. Ask against concrete alternatives and evidence, not a vague plan.

Decisions still requiring evidence or explicit scope resolution:

- Reference semantics: preserve existing supported Python behavior by default;
  obtain Python 3.12 evidence before accepting full matching. Adopting a different
  Unicode/error profile is a behavioral decision, not a test-environment shortcut.
- Runtime distribution/support: verify the declared host/OS/CPU matrix and choose
  a proven launch strategy. New paid infrastructure, credentials, host configuration
  or a reduced support promise needs concrete authorization where not already given.
- Publication/live cutover: present final artifact, passed gates, unresolved risks
  and rollback rehearsal before requesting approval. Never infer this from worker
  completion or a request to continue local implementation.

## GoalBuddy

GoalBuddy is optional orchestration, not a prerequisite for a rigorous migration.
The local goal-prep entry explicitly permits ordinary complex work to proceed
without a board. This plan plus the execution ledger is sufficient for coordinated
work in this task. A GoalBuddy board could make the same dependencies, ownership
and resumptions easier to inspect across many sessions; it must mirror these
gates and evidence, not invent a second plan or substitute status for verification.
No GoalBuddy board, scheduled run or full-migration goal is created by this document.

## Source references

- [Existing migration plan](superpowers/plans/2026-09-04-typescript-strangler-migration.md)
- [Contract inventory and gaps](contract-corpus.md)
- [Raw input boundary and reference semantics](matching-input-boundary-plan.md)
- [Integration receipts and limitations](migration-integration-review.md)
- [Fresh-host runtime matrix](runtime-evidence/acceptance-matrix.md)
- [Conditional runtime distribution](runtime-evidence/launch-recommendation.md)
