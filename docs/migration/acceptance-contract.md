# Migration acceptance contract

Approved by user agreement, 2026-09-06. Normative companion to the
[dependency map](end-to-end-map.md). Execution is active under the agreed dependency map.
Every criterion is required unless explicitly marked inapplicable with reviewed rationale.

## Status definitions

| State | Meaning |
| --- | --- |
| Planned | Scope and acceptance requirements recorded |
| Ready | Accepted prerequisite interfaces/contracts; exact files, owner, oracle, commands, scenario IDs and platform cells assigned |
| Implemented | Code exists; no acceptance or production activation implied |
| Verified locally | Named tests pass on recorded environment; missing native cells remain open |
| Accepted node | All common and node-specific gates pass on the independently reviewed immutable revision |
| Integrated subset | Member nodes accepted and real cross-node tests pass on one integrated revision |
| Accepted release candidate | Exact final artifact passes all migration-wide gates |
| Released | Separately authorized publication and activation checks completed |
| Blocked | Named criterion lacks evidence/access/decision; unrelated ready work continues |

Accepted inert interfaces can unlock downstream development without activation.
Portable child packages may be accepted while a native parent remains open.
REF accepts family contracts incrementally; its whole-node completion requires the
entire inventory. Never label a parent complete from a passing subset.

## Common gate for every implementation node

1. Exact allowed files, public surfaces and emitted counterparts match the final diff.
2. Every applicable success, invalid, missing, no-op, stale/conflict, concurrency,
   interruption, privacy and recovery case passes against an independent oracle.
3. No unexplained response, durable-state, permission, error or authority differences.
4. Declared predecessor interfaces used; no hidden dependencies or unexpected writers.
5. Strict types, reproducible emission, source-size policy, test inventory and staged
   fast checks pass. Every scoped file stays at or below 500 physical lines.
6. Independent reviewer accepts final code and adversarial coverage. All actionable
   findings fixed or resolved against the contract; unresolved findings keep it open.
7. Receipt records immutable base/head, files, commands, environment/Unicode profile,
   scenario IDs, seeds, counts, internal skips, failures, log hashes and reviewer.
8. No live Store touched; Python/TS writers use separate disposable clones. Owned
   test processes and temporary resources cleaned up.

A skipped, unavailable, flaky, timed-out or mocked-only required cell is not passed.
Suite exit status and line coverage alone are insufficient. Every counterexample
becomes a minimized regression test. Reviewer-approved inapplicability is explicit.

## Every node: acceptance and done

Each row adds to the common gate. Done means its final-column evidence is present;
its descendants and integration subset still have their own acceptance gates.

| ID | Acceptance requirements | Done evidence / handoff |
| --- | --- | --- |
| DONE | Reconcile accepted inert foundations without enlarging their claims | Existing receipts mapped to unchanged code; affected checks rerun after dependency changes; UTF-8 and diagnostic/depth limitations retained |
| I | Enumerate all CLI/HTTP/browser surfaces, documents, journals, writers, native boundaries and packaged entry points | Machine-readable ledger and executable checker reject unowned/new surfaces, empty/unregistered suites, missing evidence fields, overlapping ownership and dependency cycles |
| REF | Independent synthetic fixtures for every family's required scenario classes, exact streams/state and permitted normalization | Every current public surface behaviorally covered; no inventory-only remainder; versioned provenance and reviewed expected outcomes |
| SEM | Resolve Unicode, numeric identity, duplicate keys, byte decoding/BOM, caller errors/positions and depth across supported ingresses | Versioned compatibility decision plus cross-profile and real-ingress regressions; no undecided required behavior |
| FS | Preserve native path/permission semantics; traversal, symlink/reparse replacement, missing/nonregular files and read failures handled | Required native cells prove identity-safe reads and rejection without unexpected byte/mtime/mode changes; raw-read interface published |
| READ | Typed reads preserve schema, numeric identity, ordering and corrupt/future/legacy behavior | Tree comparisons prove pure reads remain pure; startup/recovery effects explicitly assigned to writers |
| TX | Locking, atomic JSON/JSONL, flush/rename ordering and failure behavior match contract | At least eight concurrent TS writers; every enumerated write/fsync/rename/cleanup fault point exercised; no lost/duplicate acknowledged updates; stable repeated recovery on required native cells |
| MATCH | Exact Unicode normalization, ranking/ties/limits, scope, sensitivity and malformed-input semantics | Selected SEM-profile differential corpus passes curated and seeded cases; no approximate matching subset |
| POL | Pure account/readiness/settings decisions preserve defaults, validation and authorization | Deterministic decision matrix passes; clocks/randomness explicit; no hidden filesystem, network or credential effects |
| AUTH | Loopback/Host/Origin/Bearer trust, status/headers/body, decoding, bounds and redaction preserved | Real local HTTP negative/wire matrix passes; denied requests cause zero unauthorized effects |
| PROJ | Every mapped CLI/HTTP/UI projection preserves schema, ordering and missing/legacy fields | Cross-interface results agree on shared fixtures; no lazy writes mislabeled as projection |
| UI0 | Every remaining pure helper preserves exports/coercion/defaults/text/order and input behavior | Independent original-JS differential and fixed edge cases pass; no bootstrap dependency |
| UIF | All inventoried features/events/states/auth/URLs ported, including stale responses and Active/Trash | Real browser against integrated routes passes workflows; browser changes visible to CLI and reverse; mocked API tests insufficient |
| PF | Profile/fact revisions, provenance, protected fields, no-ops and conflicts preserved | Per-command response/tree parity; journal protocol published; coordinated recovery closes in JOUR subset |
| JOB | Job/history/trash references, restrictions, restore/delete and append semantics preserved | Complete lifecycle and stale/conflicting operation sequences pass with exact state/rejection preservation |
| RES | Resume bytes/digests/assignments and extraction requests/proposals preserve behavior | Import/replace/trash/restore/extract/reject/interruption cases pass; shared recovery validated by JOUR |
| ANS | Answer CRUD/reuse/cleanup preserves keys, scope, mappings, provenance and ranking | Mutation, reload and matching results agree; conflicts preserve state and protected data |
| ACC | Accounts/settings/Trusted Fill preserve operation state, revisions and credential references | All supported transitions and negative authority cases pass; no secrets in public/log artifacts; JOUR closes recovery |
| JOUR | Every journal kind and valid/invalid partial state handled by one orchestration owner | Crash/restart/repeated-recovery matrix converges exactly once; startup effects match; stale/corrupt journals cannot broaden writes |
| SESS | Session/claim/coordinator leases, revisions, history and write-aware reads preserved | Controlled-clock expiration, competing claims, owner loss, heartbeat and restart pass without duplicate ownership/events |
| NATIVE | TS adapters retain necessary Swift and identity/attestation/denial/cancellation contracts | Required actual native fixture runs pass; process/socket/receipt mocks explicitly distinguished from native evidence |
| QA | Recorder/renderer/server exports and lifecycle preserve identity, backpressure, bounds and sanitization | Synthetic round trips, disconnects, interruption and cleanup pass; no orphan processes or secret artifacts |
| FINAL | Human-only final submission and authorization lifetime preserved under races/retries | Synthetic observer proves zero unauthorized submissions and one-winner concurrency; authorized human path retains contract |
| CHROME | Discovery/control/supervision acts only on owned browser generation | Forged/stale controls, PID replacement and partial connections cannot affect unrelated processes; shutdown/cleanup bounded |
| REPLAY | Replay/promotion/privacy preserve approved identities, signed tombstones and transaction semantics | Substitution/crash/leak/rollback fixtures pass end to end through owned adapters |
| ATT | Task/attempt/broker CLI preserves heartbeat, lease, bearer, process-loss and native authority behavior | Complete synthetic task-to-attempt lifecycle with real adapters passes recovery and final-action refusal cases |
| HOST | Supported product/version x OS/CPU matrix agreed, existing promises checked and authorized test access established | Explicit matrix and provenance/access requirements accepted; missing required host access leaves node blocked |
| DIST | Reproducible runtime distribution satisfies HOST, prerequisites and missing-runtime behavior | Actual packaged launch, cold/offline start and byte verification on every required cell; no install/download at launch |
| ASSEMBLE | All public dispatch/HTTP/UI/package entry points route correctly; shared assembly has single owners | Integrated product workflows pass on one revision; no accidental Python writer or compatibility business logic in candidate routing |
| CLOSE | All current surfaces/writers/required scenario cells mapped; inventory rerun on candidate | Executable coverage check plus independent reachability/completeness audit pass; zero unowned surfaces or unexplained writers |
| CI | Staging automatic validation and valid current required contexts restored | Representative staging PR produces matching contexts; intentional synthetic failure demonstrates required gate blocks; no phantom/retired requirement |
| REHEARSE | Full candidate and single writer switch tested under interruption/contention/upgrade | Immutable candidate passes full/platform/release and switch fault matrix on clones; rollback succeeds after representative TS writes |
| REMOVE | Required regression/tooling ports precede Python/obsolete-runtime deletion; docs/manifests updated | Static and installed-entry-point audits show no required Python path; shipped JS accounted for as TS emission; reference archive excluded from required execution |
| FINALQA | Exact post-removal artifact tested across HOST without Python available | All mandatory fresh-install/upgrade/offline/cleanup/rollback cells pass; hashes match receipts; no mandatory skips or blocking findings |
| READY | Independent final completeness/security/compatibility review accepts evidence | Immutable artifact, checksums, support matrix, release notes and rehearsed rollback bundle delivered; implementation migration complete |
| RELEASE | Separate authorization names READY artifact and rollout scope | Authorized artifact published, installed hash and operational checks pass, rollback available; outside automatic implementation completion |

## Acceptance of graph subsets

Subsets overlap and are acceptance milestones, not scheduling barriers. Their done
state requires all member nodes plus integrated tests on one immutable revision.
Accepted dependency receipts must match consumed interfaces/implementations.

| Subset | Members | Integrated acceptance | Done means |
| --- | --- | --- | --- |
| S0 Coverage and compatibility | I, REF, SEM | Executable inventory, every required behavior cell, selected semantics tested at real ingress | No inventory-only public surface or undecided required compatibility rule; family contracts can unblock work earlier |
| S1 Foundations and reads | DONE, FS, READ, TX, AUTH, PROJ | Byte-to-document-to-HTTP parity, rejection preservation, native storage/permission fault tests | Storage/trust interfaces usable by domains; not a claim of completed domain recovery |
| S2 Behavior and UI | MATCH, POL, UI0, UIF | Real browser flows against owning integrated mutation/read routes, including CLI visibility | Every inventoried UI/policy/matching behavior accepted; final UIF gate waits for real domains |
| S3 Durable business state | PF, JOB, RES, ANS, ACC, JOUR, SESS | Cross-domain references/revisions, startup repair, competing operations and repeated crash recovery | All canonical business mutations preserve response and durable-state contracts with journals integrated |
| S4 Execution and authority | NATIVE, QA, FINAL, CHROME, REPLAY, ATT | Synthetic task/attempt/capture/replay flow under process loss and forged authority | Ancillary writers and authority paths covered; zero unauthorized final actions; actual native cells passed |
| S5 Runtime and assembly | HOST, DIST, ASSEMBLE | Installed package exercises all entry points/assets independent of developer checkout | Runtime delivery works for support matrix and product is testable as one artifact |
| S6 Cutover eligibility | S0–S5, CLOSE, CI, REHEARSE | Full coverage, restored CI, candidate-wide tests, interrupted switch and post-write rollback | Disposable cutover demonstrated; removal work permitted, live activation not implied |
| S7 Migration complete | REMOVE, FINALQA, READY | Final-artifact tests after deletion; no Python fallback, missing native cell or obsolete shipped JS | Python-free final candidate accepted end to end and ready for separate release authorization |
| S8 Deployment complete | RELEASE | Authorized rollout and operational verification of same artifact | Release complete; distinct from implementation acceptance |

## Preventing circular acceptance

NATIVE adapters can be accepted independently before ATT integrates them. Domain
modules publish fixed journal protocols before JOUR verifies coordinated recovery.
UI modules may develop against frozen contracts before UIF acceptance with real
routes. Child package interfaces and parent integration gates must be separate;
never introduce reverse whole-node prerequisites that form cycles. The executable
checker validates expanded child/parent dependency edges before dispatch.

## Staleness, budgets and evidence

Changes to code, contracts, fixtures, dependencies, compiler/runner policy or relevant
environment reopen affected node/cell acceptance. Descendant integration receipts
become stale when consumed implementations/contracts change. Unaffected immutable
receipts may be reused with explicit dependency rationale. The 24-hour local hook
receipt is not node, subset or release acceptance.

Before Ready, each package freezes exact commands, scenario IDs, platform versions,
timeout/output limits, allowed files and expected artifacts. Relevant performance
and resource budgets derive from existing contracts or a measured baseline before
porting; unexplained regressions beyond those budgets fail acceptance. Do not
invent universal coverage percentages or performance numbers unsupported by evidence.

For failures retain evidence, reproduce minimally, compare unchanged base once when
needed, assign bounded repair and rerun affected gates. Two ineffective repairs
trigger independent diagnosis while unrelated lanes continue. No endless unchanged
full-suite reruns and no changing goldens or required cells to manufacture success.

## Migration-wide done statement

DONE means S7: every current in-scope public surface has an accepted TypeScript
implementation; every mandatory scenario/native/host cell passes for the exact
final artifact; no required product/test/release path needs Python; all required
regressions survive; no blocking review finding remains; and fresh install,
upgrade, offline use and rollback after TS writes succeed. Human-only submission,
privacy, persisted schema and single-writer authority remain intact.

Mandatory gaps cannot become advisory just to declare completion. Scope or contract
changes require explicit agreement. Worker completion, merged PR count, number of
passing tests, line coverage or TypeScript source percentage never establishes done.
