# Remaining migration task catalog

Approved for execution from `94e7d9c`: 116 work packages, 329 separately assignable agent tasks.

Generated from [plan.json](plan.json). Read [execution rules](../remaining-migration-plan.md) before dispatch.
Every row requires the common acceptance gate as well as its specific criteria. Planning scopes are not write authorization; exact allowed_files must be frozen before implementation.

For implementation packages: **R** freezes/reuses independent reference evidence and the file/test manifest; **I** implements after every prerequisite V and its own R; **V** is independent review of the final revision. Gate packages have I and V only.

References can be prepared ahead of implementation dependencies, using existing behavior and inert interfaces; interface changes reopen them. Downstream implementation waits for prerequisite V. Gate pass alone never grants live release authority.

## P task group

### P00 — Foundation receipt reconciliation

- Agent tasks: P00.I → P00.V.
- Implementation prerequisites: none; approval and dispatch manifest still required.
- Parent gates: I, DONE.
- Planning ownership: Existing src/runtime and migration receipts.
- Acceptance: Bind 94e7d9c evidence to unchanged files; list every remaining native, Unicode and caller limitation; never upgrade inert evidence to whole-node acceptance.

### P01 — Executable task and acceptance receipts

- Agent tasks: P01.I → P01.V.
- Implementation prerequisites: P00.V.
- Parent gates: I, REF.
- Planning ownership: tools/migration; config/migration evidence schemas.
- Acceptance: Validate exact file manifests, surface/scenario IDs, environment identities, reviewer SHA, dependency staleness and internal skips; malformed or incomplete receipts must fail closed.

### P02 — Support matrix and test-host decisions

- Agent tasks: P02.I → P02.V.
- Implementation prerequisites: P00.V.
- Parent gates: HOST.
- Planning ownership: README support promises; host/runtime evidence.
- Acceptance: Enumerate supported product x OS x CPU x version cells and authorized clean hosts; preserve current promises unless explicitly changed; missing access remains open, never simulated as native success.

### P03 — Reviewed affected-test mappings

- Agent tasks: P03.R → P03.I → P03.V.
- Implementation prerequisites: P01.V.
- Parent gates: CI.
- Planning ownership: tools/local-checks/policy.mjs; tests_js/local_checks_policy.test.mjs.
- Acceptance: Map each accepted seam to its full transitive regression set; shared contracts, unknown paths, deletions, locks and policy changes escalate; mutation tests prove no consumer suite silently drops out.

### P04 — One heavy-run lease per host

- Agent tasks: P04.R → P04.I → P04.V.
- Implementation prerequisites: P01.V.
- Parent gates: CI.
- Planning ownership: tools/local-checks process coordination; new host-lease leaf.
- Acceptance: Two concurrent coordinators cannot overlap heavy suites; cancellation and dead-owner recovery release only the owned lease; PID reuse and separate worktrees are covered.

### P05 — Native evidence identity and required-cell runner

- Agent tasks: P05.I → P05.V.
- Implementation prerequisites: P01.V, P02.V.
- Parent gates: I, HOST.
- Planning ownership: tools/migration evidence adapters; test-runner receipt integration.
- Acceptance: Bind relevant interpreter binaries/all aliases, browser, compiler, native addon, OS build and artifact hashes; a passing suite with a required child skip must fail acceptance.

## S task group

### S01 — Codepoint-keyed JSON object leaf

- Agent tasks: S01.R → S01.I → S01.V.
- Implementation prerequisites: P00.V.
- Parent gates: SEM.
- Planning ownership: new src/contracts/raw-json/python-object.ts.
- Acceptance: Equal independently allocated keys overwrite without moving insertion order; literal surrogate pair/scalar keys coexist; legacy string Map inputs keep their behavior; no activation yet.

### S02 — Python-compatible JSON byte decoder

- Agent tasks: S02.R → S02.I → S02.V.
- Implementation prerequisites: P00.V.
- Parent gates: SEM.
- Planning ownership: new src/contracts/raw-json byte-decoding leaves.
- Acceptance: Frozen UTF8/16/32 detection, BOM, surrogatepass, malformed bytes and mixed surrogate cases match each supported reference profile; preserve explicit codepoints before parsing.

### S08 — Shared point-aware parser core with legacy entry points

- Agent tasks: S08.R → S08.I → S08.V.
- Implementation prerequisites: S01.V, S02.V.
- Parent gates: SEM.
- Planning ownership: existing raw-json scanner/value/serializer extraction and explicit legacy projection; at most eight source modules with one parser implementation.
- Acceptance: Frozen composed Python JSON witnesses pass for raw versus escaped surrogate neighbors, ordered point-keyed objects, numeric atoms and exact diagnostics; new point-aware entry points share the syntax engine, existing entry points retain their reviewed behavior, and no widened value reaches an unprepared consumer. This accepts preparation only, never public alias activation.

### S03 — Public typed parser and ASCII serializer activation

- Agent tasks: S03.R → S03.I → S03.V.
- Implementation prerequisites: S08.V, S04.V, S05.V.
- Parent gates: SEM.
- Planning ownership: raw-json public value/parser/serializer and shared validation/read/managed-observation composition; one final integration owner, at most eight source modules.
- Acceptance: Activate the prepared public parser/alias only after point-aware persistence and path consumers pass; combine only adjacent JSON escape pairs, preserve raw/escaped neighbors, ordered distinct keys, numeric atoms and exact codepoint diagnostics. All affected consumers compile and their joint regressions pass on the exact integrated subject; no casts or lossy legacy projection bypass representability.

### S04 — Codepoint-preserving persisted chunks

- Agent tasks: S04.R → S04.I → S04.V.
- Implementation prerequisites: S08.V.
- Parent gates: SEM, TX.
- Planning ownership: src/contracts/persisted-json.ts; jsonl-json.ts; private-filesystem.ts.
- Acceptance: Atomic writes encode at each original chunk boundary; JSONL encodes once before open; error object/position, prior bytes and cleanup match frozen atomic/JSONL profiles. Prepare explicit point-aware inputs while public parser activation remains gated by S03; reserve shared read/validation/managed-observation composition to S03.

### S05 — Text-aware paths and content caches

- Agent tasks: S05.R → S05.I → S05.V.
- Implementation prerequisites: S08.V.
- Parent gates: SEM, FS.
- Planning ownership: POSIX path/byte leaves; managed-resume and digest consumers.
- Acceptance: Retain path validation/encoding order and raw-byte identity; invalid last components do not fail before valid parent checks; equal text instances share cache keys, pairs/scalars differ. Prepare explicit point-aware inputs while public parser activation remains gated by S03; reserve shared read/validation/managed-observation composition to S03.

### S06 — Unicode normalization and answer matching

- Agent tasks: S06.R → S06.I → S06.V.
- Implementation prerequisites: S03.V.
- Parent gates: SEM, MATCH.
- Planning ownership: scripts/job_apply_answer_matching reference; new src/matching leaves.
- Acceptance: Curated and seeded normalization/ranking/ties/limits/scope/sensitivity corpus matches actual reference versions; no approximate Unicode subset or test-only normalization.

### S07 — Caller depth and diagnostic closure

- Agent tasks: S07.R → S07.I → S07.V.
- Implementation prerequisites: S03.V, S04.V, S05.V.
- Parent gates: SEM.
- Planning ownership: CLI/HTTP ingress diagnostics and recursion contract tests.
- Acceptance: Exercise real ingress and helper callers for invalid options, depth, numeric limits and error ordering; select documented profile behavior where Python versions differ without silently changing contracts.

## F task group

### F01 — Native filesystem path and permission closure

- Agent tasks: F01.R → F01.I → F01.V.
- Implementation prerequisites: S05.V, P02.V, P05.V.
- Parent gates: FS.
- Planning ownership: src/store raw-read/path/digest leaves; native platform adapters.
- Acceptance: Native symlink/reparse/traversal/race/nonregular/permission cells pass on required hosts; rejected reads preserve bytes, mtimes and modes; EILSEQ and missing-host cells remain failures until resolved.

### F02 — Typed document reads and schema validation

- Agent tasks: F02.R → F02.I → F02.V.
- Implementation prerequisites: F01.V, S07.V.
- Parent gates: READ.
- Planning ownership: src/store/read-json-object.ts; validation leaf modules.
- Acceptance: All document kinds preserve corrupt/future/legacy handling, int/float identity and field order; prove pure reads have no startup or recovery writes.

### F03 — Lock and atomic-write native closure

- Agent tasks: F03.R → F03.I → F03.V.
- Implementation prerequisites: F01.V, S04.V.
- Parent gates: TX.
- Planning ownership: exclusive-file-lock; atomic-write-json; private-filesystem and native bindings.
- Acceptance: Eight contending writers, killed owner, every named open/write/flush/fsync/rename/close fault and platform cell preserve reference outcomes; repeat recovery without lost acknowledged updates.

### F04 — Streaming history reader and validation

- Agent tasks: F04.R → F04.I → F04.V.
- Implementation prerequisites: F02.V.
- Parent gates: READ, JOB.
- Planning ownership: new src/store history-read leaves.
- Acceptance: Frozen history reference preserves strict UTF8 read-ahead, physical line labels, validation asymmetry and complete input-tree preservation across supported profiles.

### F05 — Real history idempotency and append integration

- Agent tasks: F05.R → F05.I → F05.V.
- Implementation prerequisites: F04.V, F03.V, S04.V.
- Parent gates: TX, JOB.
- Planning ownership: src/store/jsonl-history.ts; new history-identity leaves.
- Acceptance: Use real canonical identity instead of synthetic callbacks; append/repair/duplicate/stale/corrupt cases preserve exact bytes and ordering under lock and process death.

### F06 — Shared journal protocol interfaces

- Agent tasks: F06.R → F06.I → F06.V.
- Implementation prerequisites: F03.V, F02.V.
- Parent gates: TX, JOUR.
- Planning ownership: new src/store journal protocol leaves.
- Acceptance: Freeze each inventoried journal discriminator, state transition, ownership and fault point; domains consume leaf protocols without editing shared dispatch; malformed journals cannot broaden writes.

## A task group

### A01 — Pure account/readiness and policy decisions

- Agent tasks: A01.R → A01.I → A01.V.
- Implementation prerequisites: S07.V.
- Parent gates: POL.
- Planning ownership: new src/policy leaves from form-readiness/accounts/policy model.
- Acceptance: Decision matrices preserve defaults, authorization lifetime and malformed inputs; clocks/randomness explicit; pure functions perform no hidden IO or credential lookup.

### A02 — HTTP trust and body transport

- Agent tasks: A02.R → A02.I → A02.V.
- Implementation prerequisites: S02.V, P01.V, S03.V.
- Parent gates: AUTH.
- Planning ownership: new src/workspace HTTP/auth leaves.
- Acceptance: Real loopback wire tests cover Host/Origin/Bearer, headers, content lengths, body bounds and frozen39 byte cases; denied requests cause zero writes and no secret leakage.

### A03 — Read projections and queries

- Agent tasks: A03.R → A03.I → A03.V.
- Implementation prerequisites: F02.V.
- Parent gates: PROJ.
- Planning ownership: new src/workspace projections/queries leaves.
- Acceptance: All projection schemas, ordering and missing/legacy defaults match; lazy startup effects are excluded and assigned to journal startup.

### A04 — HTTP read and asset routes

- Agent tasks: A04.R → A04.I → A04.V.
- Implementation prerequisites: A02.V, A03.V.
- Parent gates: PROJ, AUTH.
- Planning ownership: new src/workspace read/asset route leaves.
- Acceptance: Every inventoried read/asset/HEAD route has exact status/header/body tests and authorization negatives; CLI and HTTP projections agree on shared fixtures.

## D task group

### D01 — Profile mutations

- Agent tasks: D01.R → D01.I → D01.V.
- Implementation prerequisites: F02.V, F03.V, F06.V, S07.V.
- Parent gates: PF.
- Planning ownership: new src/store/domains/profile leaves.
- Acceptance: Exact revision/provenance, protected fields, null/missing, no-op/conflict and response/tree parity; publish fixed journal protocol before recovery integration.

### D02 — Fact mutations and provenance

- Agent tasks: D02.R → D02.I → D02.V.
- Implementation prerequisites: D01.V.
- Parent gates: PF.
- Planning ownership: new src/store/domains/facts leaves.
- Acceptance: Create/update/delete/merge preserve fact identities and provenance; stale or protected mutations preserve state; profile cross-references survive reload.

### D03 — Job CRUD and legacy reads

- Agent tasks: D03.R → D03.I → D03.V.
- Implementation prerequisites: F02.V, F03.V, F06.V.
- Parent gates: JOB.
- Planning ownership: new src/store/domains/jobs CRUD/legacy leaves.
- Acceptance: Create/read/update and legacy documents preserve defaults, identity and revisions; invalid/conflicting operations leave exact state unchanged.

### D04 — Job upsert and overview

- Agent tasks: D04.R → D04.I → D04.V.
- Implementation prerequisites: D03.V, F05.V.
- Parent gates: JOB.
- Planning ownership: new src/store/domains/jobs upsert/overview leaves.
- Acceptance: Repeat upsert is idempotent; URL/identity collisions and history links match reference; overview stays consistent with durable job state.

### D05 — Job trash, restore and delete

- Agent tasks: D05.R → D05.I → D05.V.
- Implementation prerequisites: D04.V.
- Parent gates: JOB.
- Planning ownership: new job lifecycle leaves.
- Acceptance: Referenced jobs enforce delete/restore restrictions; typed confirmation and stale revisions behave identically; repeated lifecycle and interrupted operations preserve links.

### D06 — Resume import and assignment mutations

- Agent tasks: D06.R → D06.I → D06.V.
- Implementation prerequisites: F02.V, F03.V, F06.V.
- Parent gates: RES.
- Planning ownership: new src/store/domains/resumes storage/mutation leaves.
- Acceptance: Import/replace/assign validate exact bytes, digest, permissions and references; interruption at each storage transition preserves baseline recovery state.

### D07 — Resume read, trash and restore

- Agent tasks: D07.R → D07.I → D07.V.
- Implementation prerequisites: D06.V.
- Parent gates: RES.
- Planning ownership: new resume read/lifecycle leaves.
- Acceptance: Missing/nonregular files, assignments, blocked deletion and repeat restore match state/projection contracts without hidden reads becoming writes.

### D08 — Extraction request lifecycle

- Agent tasks: D08.R → D08.I → D08.V.
- Implementation prerequisites: D06.V, D02.V.
- Parent gates: RES.
- Planning ownership: new extraction request leaves.
- Acceptance: Human-requested extraction authority, persisted request identity, cancellation and stale revision behavior match; no unsolicited extraction or live document access in tests.

### D09 — Extraction proposals and grouped review

- Agent tasks: D09.R → D09.I → D09.V.
- Implementation prerequisites: D08.V.
- Parent gates: RES.
- Planning ownership: new extraction proposal leaves.
- Acceptance: Accept/reject/partial grouped review preserves provenance, protected facts, idempotency and journal state at every interruption boundary.

### D10 — Answer reads and reuse selection

- Agent tasks: D10.R → D10.I → D10.V.
- Implementation prerequisites: F02.V, S06.V, D02.V.
- Parent gates: ANS.
- Planning ownership: new answer read/reuse leaves.
- Acceptance: Scope, sensitivity, provenance and ranked reuse match; corrupt/stale mappings and no-match behavior are exact and read-only.

### D11 — Answer CRUD and mappings

- Agent tasks: D11.R → D11.I → D11.V.
- Implementation prerequisites: D10.V, F03.V, F06.V.
- Parent gates: ANS.
- Planning ownership: new answer mutation leaves.
- Acceptance: Create/update/delete and field mappings preserve keys, revisions, provenance and durable bytes; stale/conflict/privacy cases reject without writes.

### D12 — Answer merge and cleanup

- Agent tasks: D12.R → D12.I → D12.V.
- Implementation prerequisites: D11.V.
- Parent gates: ANS.
- Planning ownership: new answer merge/cleanup leaves.
- Acceptance: Merge/cleanup preserve ordering and cross-references; repeat invocation and interruption are idempotent; protected and sensitive data do not leak.

### D13 — Account registry

- Agent tasks: D13.R → D13.I → D13.V.
- Implementation prerequisites: F02.V, F03.V, F06.V, A01.V.
- Parent gates: ACC.
- Planning ownership: new account registry leaves.
- Acceptance: Account identities, revisions, synthetic separation and credential references match; public output/logs never expose secrets.

### D14 — Account settings and scopes

- Agent tasks: D14.R → D14.I → D14.V.
- Implementation prerequisites: D13.V.
- Parent gates: ACC.
- Planning ownership: new account settings/email-scope leaves.
- Acceptance: Default/settings changes and provider scopes preserve authority boundaries, revisions and no-op semantics; denial leaves state unchanged.

### D15 — Trusted Fill state transitions

- Agent tasks: D15.R → D15.I → D15.V.
- Implementation prerequisites: D14.V.
- Parent gates: ACC.
- Planning ownership: new account trusted-fill leaves.
- Acceptance: One-shot authorization, scope binding, stale/replayed tokens and transitions preserve human control; repeat consumption cannot widen authority.

### D16 — Account operation persistence

- Agent tasks: D16.R → D16.I → D16.V.
- Implementation prerequisites: D15.V.
- Parent gates: ACC.
- Planning ownership: new account operations/password/email execution state leaves.
- Acceptance: Supported transitions, owner loss, cancellation and partial operation journals preserve exact state; native execution remains an explicit adapter.

## J task group

### J01 — Extraction recovery

- Agent tasks: J01.R → J01.I → J01.V.
- Implementation prerequisites: D09.V, F06.V.
- Parent gates: JOUR.
- Planning ownership: new extraction recovery leaves.
- Acceptance: Every valid/invalid extraction journal phase converges exactly once on repeated startup; stale or malformed records cannot mutate unrelated facts/files.

### J02 — Account recovery

- Agent tasks: J02.R → J02.I → J02.V.
- Implementation prerequisites: D16.V, F06.V.
- Parent gates: JOUR.
- Planning ownership: new account recovery leaves.
- Acceptance: Crash/restart across account operation phases preserves revision/credential references and refusal semantics; repeated recovery is stable and secret-free.

### J03 — Coordinator journal persistence and recovery

- Agent tasks: J03.R → J03.I → J03.V.
- Implementation prerequisites: D05.V, D07.V, D12.V, J01.V, J02.V, F05.V.
- Parent gates: JOUR.
- Planning ownership: new coordinator persistence/recovery leaves.
- Acceptance: Cross-domain journal fault matrix closes history/reference updates exactly once; concurrent recovery and corrupt/stale journals preserve authority and state.

### J04 — Startup orchestration

- Agent tasks: J04.R → J04.I → J04.V.
- Implementation prerequisites: J03.V.
- Parent gates: JOUR.
- Planning ownership: single startup dispatcher and Store composition owner.
- Acceptance: Inventory all write-aware startup reads; recovery order and legacy initialization match; Python/TS remain isolated and exactly one dispatcher owns writes.

## C task group

### C01 — Session documents and lifecycle

- Agent tasks: C01.R → C01.I → C01.V.
- Implementation prerequisites: J04.V, A01.V, S06.V.
- Parent gates: SESS.
- Planning ownership: new session document/lifecycle leaves.
- Acceptance: Legacy/current/future session schemas, lifecycle revisions, readiness and close/reopen behavior preserve response and state parity.

### C02 — Claims, leases and heartbeat

- Agent tasks: C02.R → C02.I → C02.V.
- Implementation prerequisites: C01.V.
- Parent gates: SESS.
- Planning ownership: new coordinator claim leaves.
- Acceptance: Controlled-clock expiry, eight competitors, stale owners, process death and heartbeat races produce one owner and no duplicate acknowledgments.

### C03 — Progress and attention projections

- Agent tasks: C03.R → C03.I → C03.V.
- Implementation prerequisites: C02.V.
- Parent gates: SESS.
- Planning ownership: new coordinator progress/attention leaves.
- Acceptance: Progress/history and blockers agree with durable state; nominal reads with writes are explicit; stale browser responses cannot overwrite newer state.

### C04 — Approval and readiness coordination

- Agent tasks: C04.R → C04.I → C04.V.
- Implementation prerequisites: C03.V.
- Parent gates: SESS.
- Planning ownership: new coordinator approval/readiness leaves.
- Acceptance: Approval lifetime, invalidation, restart and known-data versus browser-action distinctions match; no automatic final submission.

### C05 — Task CLI and broker integration

- Agent tasks: C05.R → C05.I → C05.V.
- Implementation prerequisites: C04.V, N03.V, Q08.V.
- Parent gates: ATT.
- Planning ownership: new src/cli task and task-broker leaves.
- Acceptance: Exact argv/stdout/stderr/exit contracts and synthetic task-to-session lifecycle preserve heartbeat, bearer and authority under process loss.

### C06 — Attempt CLI lifecycle

- Agent tasks: C06.R → C06.I → C06.V.
- Implementation prerequisites: C05.V, Q03.V.
- Parent gates: ATT.
- Planning ownership: new src/cli attempt leaves.
- Acceptance: Task-to-attempt-to-capture/recovery flow with real owned adapters preserves lease lifetime and final-action refusal; no duplicate attempt ownership.

## N task group

### N01 — Credential adapter and identity

- Agent tasks: N01.R → N01.I → N01.V.
- Implementation prerequisites: P02.V, D13.V, P05.V.
- Parent gates: NATIVE.
- Planning ownership: new src/native credential adapter; retained Swift boundary.
- Acceptance: Actual supported host cells prove executable identity, permission denial, cancellation, redaction and credential reference handling; mocks cannot close native evidence.

### N02 — Account native execution adapters

- Agent tasks: N02.R → N02.I → N02.V.
- Implementation prerequisites: N01.V, D16.V.
- Parent gates: NATIVE.
- Planning ownership: new native account/password/email adapters.
- Acceptance: Synthetic native flows cover cancellation, attestation, stale authority and process loss; opt-in real account flows require separate explicit authority if required by agreed matrix.

### N03 — Trusted Fill native boundary

- Agent tasks: N03.R → N03.I → N03.V.
- Implementation prerequisites: N02.V, D15.V.
- Parent gates: NATIVE.
- Planning ownership: new native Trusted Fill adapter.
- Acceptance: Exact one-shot scope, stale receipt and replay rejection; native failure cannot extend authority or expose secrets; preserve retained Swift contracts.

## Q task group

### Q01 — Recorder filesystem and private checkpoints

- Agent tasks: Q01.R → Q01.I → Q01.V.
- Implementation prerequisites: F03.V.
- Parent gates: QA.
- Planning ownership: new src/qa recorder IO/checkpoint/resource leaves.
- Acceptance: Owned paths, partial writes, quotas and cleanup preserve capture identity and private modes; no orphan files or descriptors after interruption.

### Q02 — Recorder capture and safety modules

- Agent tasks: Q02.R → Q02.I → Q02.V.
- Implementation prerequisites: Q01.V, A01.V, Q16.V.
- Parent gates: QA.
- Planning ownership: new src/qa recorder capture/record/isolated-source/CLI leaves.
- Acceptance: All ATS safety modules preserve capture/export contracts, input bounds, backpressure and sanitization using synthetic fixtures.

### Q03 — Recorder broker and guardian

- Agent tasks: Q03.R → Q03.I → Q03.V.
- Implementation prerequisites: Q02.V.
- Parent gates: QA.
- Planning ownership: new src/qa broker/guardian leaves.
- Acceptance: Disconnect, cancellation, owner death, request authentication and checkpoint recovery preserve one owned capture and bounded cleanup.

### Q04 — QA and account renderers

- Agent tasks: Q04.R → Q04.I → Q04.V.
- Implementation prerequisites: P01.V.
- Parent gates: QA.
- Planning ownership: new src/qa renderer modules emitted over old JS.
- Acceptance: Original-JS differential and real-browser synthetic render tests preserve events, identity and final-action observation; no Python server dependency in final form.

### Q05 — QA HTTP and account test servers

- Agent tasks: Q05.R → Q05.I → Q05.V.
- Implementation prerequisites: A02.V, Q04.V.
- Parent gates: QA.
- Planning ownership: new src/qa server/auth/events/account-server leaves.
- Acceptance: Real owned test servers preserve authentication, event streaming, bounded requests, disconnect cleanup and final-action observation; all server startup paths become Python-free.

### Q06 — Chrome discovery and authenticated control

- Agent tasks: Q06.R → Q06.I → Q06.V.
- Implementation prerequisites: F01.V.
- Parent gates: CHROME.
- Planning ownership: new src/qa/chrome discovery/control leaves.
- Acceptance: Forged/stale controls, replaced PID/socket and unowned browser generations cannot be adopted or killed; only owned synthetic profiles used.

### Q07 — Chrome supervision and lifecycle

- Agent tasks: Q07.R → Q07.I → Q07.V.
- Implementation prerequisites: Q06.V.
- Parent gates: CHROME.
- Planning ownership: new src/qa/chrome owner/supervisor/CLI leaves.
- Acceptance: Launch/partial connection/death/timeout/shutdown matrix cleans only owned processes; receipt binds actual browser binary and generation.

### Q08 — Human-only final-action policy

- Agent tasks: Q08.R → Q08.I → Q08.V.
- Implementation prerequisites: A01.V, F03.V.
- Parent gates: FINAL.
- Planning ownership: new policy authorization/storage/outcome leaves; synthetic submission observer.
- Acceptance: Races/retries/expired authority produce zero unauthorized submissions and one winner; only the established human final path remains possible.

### Q09 — Replay prepare and lifecycle

- Agent tasks: Q09.R → Q09.I → Q09.V.
- Implementation prerequisites: Q03.V, Q05.V, Q07.V, Q08.V, Q14.V, Q15.V.
- Parent gates: REPLAY.
- Planning ownership: new src/qa/replay prepare/lifecycle/secure-io leaves.
- Acceptance: Approved fixture identity, substitution resistance, capture ownership and interruption/recovery match; no live account behavior substituted for synthetic proofs.

### Q10 — Replay evaluate, report and cleanup

- Agent tasks: Q10.R → Q10.I → Q10.V.
- Implementation prerequisites: Q09.V.
- Parent gates: REPLAY.
- Planning ownership: new replay evaluate/report/cleanup leaves.
- Acceptance: Exact oracle results, signed cleanup authority, no leaks/orphans and repeated cleanup after crashes; report privacy and event order preserved.

### Q11 — Privacy scanner and signed tombstones

- Agent tasks: Q11.R → Q11.I → Q11.V.
- Implementation prerequisites: F03.V, Q02.V.
- Parent gates: REPLAY.
- Planning ownership: new src/qa privacy and deletion leaves.
- Acceptance: Known leak canaries and substitution/tombstone tests reject secrets, unexpected artifacts and invalid signatures without erasing unrelated state.

### Q12 — Promotion approval and candidate binding

- Agent tasks: Q12.R → Q12.I → Q12.V.
- Implementation prerequisites: Q10.V, Q11.V.
- Parent gates: REPLAY.
- Planning ownership: new promotion approval/binding/candidate leaves.
- Acceptance: Approved immutable candidate and destination identity survive substitution/race tests; no unapproved fixture becomes public.

### Q13 — Promotion transaction and rollback

- Agent tasks: Q13.R → Q13.I → Q13.V.
- Implementation prerequisites: Q12.V, F03.V.
- Parent gates: REPLAY.
- Planning ownership: new promotion transaction/rollback/CLI leaves.
- Acceptance: Every write/rename/deletion interruption rolls back or recovers to the exact expected tree; repeat recovery and leak scans pass.

### Q14 — Oracle state and account observations

- Agent tasks: Q14.R → Q14.I → Q14.V.
- Implementation prerequisites: Q05.V, F02.V.
- Parent gates: QA.
- Planning ownership: new src/qa oracle/history/session/account-observation leaves.
- Acceptance: Preserve synthetic observation identity, expected outcomes, event ordering and redaction; all required oracle scenarios and failure regressions survive in Python-free execution.

### Q15 — Fixture compiler and contract models

- Agent tasks: Q15.R → Q15.I → Q15.V.
- Implementation prerequisites: P01.V.
- Parent gates: QA.
- Planning ownership: new src/qa compiler/contracts/fixture model leaves.
- Acceptance: Compile every committed synthetic fixture with exact schema, stable identifiers and reviewed output; malformed or substituted provenance is rejected without auto-refreshing expected results.

### Q16 — Recorder ATS safety adapters

- Agent tasks: Q16.R → Q16.I → Q16.V.
- Implementation prerequisites: Q01.V, A01.V.
- Parent gates: QA.
- Planning ownership: new src/qa/recorder/safety leaves.
- Acceptance: Each inventoried ATS safety adapter preserves selectors, scope, denial and final-action refusal on fixed synthetic fixtures; any host-dependent cell remains explicitly required.

## U task group

### U01 — Remaining pure UI helpers

- Agent tasks: U01.R → U01.I → U01.V.
- Implementation prerequisites: P00.V.
- Parent gates: UI0.
- Planning ownership: new src/workspace-ui/lib leaf modules.
- Acceptance: Every remaining original helper/export has independent original-JS differential tests for coercion, defaults, text, ordering and input mutation; existing trash/resume evidence reused only if unchanged.

### U02 — UI API, state and DOM infrastructure

- Agent tasks: U02.R → U02.I → U02.V.
- Implementation prerequisites: U01.V.
- Parent gates: UI0.
- Planning ownership: new src/workspace-ui API/state/DOM leaves.
- Acceptance: Auth URLs, errors, request cancellation, event binding and stale-response rules match; no bootstrap dependency from leaf modules.

### U03 — Overview and jobs UI

- Agent tasks: U03.R → U03.I → U03.V.
- Implementation prerequisites: U02.V.
- Parent gates: UIF.
- Planning ownership: new overview/jobs feature modules.
- Acceptance: Original feature exports and synthetic DOM workflows preserve editing/filtering/selection and stale results; real route acceptance deferred to integrated gate.

### U04 — Answers and facts UI

- Agent tasks: U04.R → U04.I → U04.V.
- Implementation prerequisites: U02.V.
- Parent gates: UIF.
- Planning ownership: new answers/facts feature modules.
- Acceptance: Editing/reuse/provenance/conflict and grouped review state match original UI; stale response cannot resurrect deleted data.

### U05 — Resumes and unified trash UI

- Agent tasks: U05.R → U05.I → U05.V.
- Implementation prerequisites: U02.V.
- Parent gates: UIF.
- Planning ownership: new resumes/trash feature modules.
- Acceptance: Import/assignment/trash/restore/delete confirmation and blocked state remain correct; no implementation internals exposed to users.

### U06 — Activity, automation and navigation UI

- Agent tasks: U06.R → U06.I → U06.V.
- Implementation prerequisites: U02.V.
- Parent gates: UIF.
- Planning ownership: new activity/automation/navigation feature modules.
- Acceptance: Activity order, navigation/auth state and automation controls preserve public events and authority; error/loading/no-data states covered.

### U07 — UI bindings and bootstrap composition

- Agent tasks: U07.R → U07.I → U07.V.
- Implementation prerequisites: U03.V, U04.V, U05.V, U06.V.
- Parent gates: UIF.
- Planning ownership: single src/workspace-ui bootstrap/bindings owner.
- Acceptance: Every original browser export/event reachable exactly once; no duplicate handlers, stale module paths or handwritten shipped JS escapes.

## W task group

### W01 — Profile/fact write routes

- Agent tasks: W01.R → W01.I → W01.V.
- Implementation prerequisites: A02.V, D02.V.
- Parent gates: PROJ, PF.
- Planning ownership: new workspace profile/fact route adapter.
- Acceptance: Real HTTP and CLI mutations agree on exact responses, revisions and rejection state; auth failures have zero effects.

### W02 — Job lifecycle write routes

- Agent tasks: W02.R → W02.I → W02.V.
- Implementation prerequisites: A02.V, D05.V.
- Parent gates: PROJ, JOB.
- Planning ownership: new workspace job route adapter.
- Acceptance: Create/upsert/trash/restore/delete route matrix agrees with durable domain and history; stale/invalid/denied calls preserve state.

### W03 — Resume and extraction write routes

- Agent tasks: W03.R → W03.I → W03.V.
- Implementation prerequisites: A02.V, D07.V, D09.V, J01.V.
- Parent gates: PROJ, RES.
- Planning ownership: new workspace resume/extraction route adapter.
- Acceptance: Bytes, digest, proposals, grouped review and cancellation parity over real HTTP; partial failure and auth refusal have exact effects.

### W04 — Answer write routes

- Agent tasks: W04.R → W04.I → W04.V.
- Implementation prerequisites: A02.V, D12.V.
- Parent gates: PROJ, ANS.
- Planning ownership: new workspace answer route adapter.
- Acceptance: CRUD/reuse/merge/cleanup response and state parity, including scopes, sensitivity, conflicts and missing/null distinctions.

### W05 — Account/settings/Trusted Fill write routes

- Agent tasks: W05.R → W05.I → W05.V.
- Implementation prerequisites: A02.V, D16.V, J02.V, N03.V.
- Parent gates: PROJ, ACC.
- Planning ownership: new workspace account route adapter.
- Acceptance: Full transition and denial wire matrix; secrets absent from HTTP/logs and native failures never widen authority.

## B task group

### B01 — Native binary stream adapter

- Agent tasks: B01.R → B01.I → B01.V.
- Implementation prerequisites: P02.V, F01.V, P05.V.
- Parent gates: DIST.
- Planning ownership: new src/package binary read/write buffering leaves.
- Acceptance: Actual raw read/write/flush/close failures and partial buffered bytes match frozen profiles on each required native host; model-only evidence is insufficient.

### B02 — Native data-copy acceleration

- Agent tasks: B02.R → B02.I → B02.V.
- Implementation prerequisites: B01.V.
- Parent gates: DIST.
- Planning ownership: new native copy bindings and data-copy adapter.
- Acceptance: Actual supported accelerator/fallback/error chains preserve partial state and permissions; no Node copyFile substitution that changes modes prematurely; Linux/Windows explicitly proven or excluded by approved matrix.

### B03 — Metadata-copy adapter

- Agent tasks: B03.R → B03.I → B03.V.
- Implementation prerequisites: B01.V.
- Parent gates: DIST.
- Planning ownership: new metadata copy leaves; timestamp provider integration.
- Acceptance: Post-data stat/atime/mtime/xattr/chmod/flags ordering and suppressed/propagated errors match actual reference; full nanoseconds and platform differences witnessed natively.

### B04 — Critical artifact copy and verification

- Agent tasks: B04.R → B04.I → B04.V.
- Implementation prerequisites: B02.V, B03.V.
- Parent gates: DIST.
- Planning ownership: installed-artifacts/artifact-paths and package-copy orchestrator.
- Acceptance: Whole-package preflight including missing destinations, symlinks/FIFOs, exact copied bytes and partial failure state; inventory and verification cover all candidate artifacts.

### B05 — Packaged runtime selection and build

- Agent tasks: B05.R → B05.I → B05.V.
- Implementation prerequisites: P02.V.
- Parent gates: DIST.
- Planning ownership: runtime packaging/build/signing configuration.
- Acceptance: Meet agreed clean-host promise without install/download at launch; reproducible Node/native binary identity, licenses and target-specific artifacts; developer-installed Node/clang is not customer acceptance.

### B06 — Python-free installed launchers

- Agent tasks: B06.R → B06.I → B06.V.
- Implementation prerequisites: B04.V, B05.V, G01.V, G02.V, G03.V.
- Parent gates: DIST.
- Planning ownership: installed Store/workspace/task/attempt/QA launch wrappers.
- Acceptance: Cold/offline launch, missing/corrupt runtime diagnostics, paths with spaces and host discovery work without Python or source checkout; no hidden fallback or launch-time build.

### B07 — Clean-host installation evidence

- Agent tasks: B07.I → B07.V.
- Implementation prerequisites: B06.V, P05.V.
- Parent gates: DIST, HOST.
- Planning ownership: native host test packages and install receipts.
- Acceptance: Fresh install/upgrade/uninstall/offline checks on every agreed product/OS/CPU/version cell; exact candidate hashes and owned cleanup; unavailable cells remain open.

## T task group

### T01 — Portable Python regression-test conversion

- Agent tasks: T01.I → T01.V.
- Implementation prerequisites: T06.V, T07.V, T08.V, T09.V, T10.V, T11.V, T12.V.
- Parent gates: REMOVE.
- Planning ownership: regression parity inventory audit only.
- Acceptance: Preserve every existing regression assertion and minimized counterexample with independent fixtures; required tests run without Python; historical reference tools may remain archived only.

### T02 — Browser and oracle regression conversion

- Agent tasks: T02.R → T02.I → T02.V.
- Implementation prerequisites: Q05.V, U07.V, Q14.V, Q15.V, G02.V.
- Parent gates: REMOVE.
- Planning ownership: tests_js and Python browser/oracle support.
- Acceptance: Every required synthetic browser/oracle scenario survives removal; real browser against owned TS servers, child skips recorded and required cells enforced.

### T03 — Native regression-test conversion

- Agent tasks: T03.R → T03.I → T03.V.
- Implementation prerequisites: N03.V, B07.V.
- Parent gates: REMOVE.
- Planning ownership: native fixture harness and Python native tests.
- Acceptance: Actual native assertions survive in Python-free runners for each required host; no replacement with mocks, missing opt-ins or waived cells.

### T04 — Python-free development and release tools

- Agent tasks: T04.R → T04.I → T04.V.
- Implementation prerequisites: P03.V, P04.V, P05.V, T13.V, T14.V, T15.V.
- Parent gates: REMOVE.
- Planning ownership: hook environment probes and remaining build/release entry scripts, after dedicated checker/smoke/fixture ports.
- Acceptance: All required build/test/hook/release commands work with Python absent; preserve baseline failure regressions, size ceilings, inventory and error behavior.

### T05 — Restore staging CI and server-side gates

- Agent tasks: T05.R → T05.I → T05.V.
- Implementation prerequisites: P03.V, P04.V, P05.V.
- Parent gates: CI.
- Planning ownership: .github/workflows and separately authorized staging rules.
- Acceptance: Review exact current required contexts, Node/runtime versions and duplicated jobs; representative staging PR runs required checks and intentional failure blocks merge; hooks alone never authorize merging.

### T06 — Codec and filesystem regression conversion

- Agent tasks: T06.R → T06.I → T06.V.
- Implementation prerequisites: P01.V.
- Parent gates: REMOVE.
- Planning ownership: portable numeric/JSON/path/read/write Python regressions.
- Acceptance: All edge cases, binary/error-ordering fixtures and concurrency regressions retained with independent expected values.

### T07 — Profile, fact and answer regression conversion

- Agent tasks: T07.R → T07.I → T07.V.
- Implementation prerequisites: P01.V.
- Parent gates: REMOVE.
- Planning ownership: profile/fact/answer/matching Python test families.
- Acceptance: Provenance, ranking, privacy, no-op and conflict assertions retain coverage without executing Python.

### T08 — Job, resume and extraction regression conversion

- Agent tasks: T08.R → T08.I → T08.V.
- Implementation prerequisites: P01.V.
- Parent gates: REMOVE.
- Planning ownership: job/history/trash/resume/extraction Python test families.
- Acceptance: Lifecycle, byte/digest, journal and grouped-review counterexamples retained in required Python-free suites.

### T09 — Account and session regression conversion

- Agent tasks: T09.R → T09.I → T09.V.
- Implementation prerequisites: P01.V.
- Parent gates: REMOVE.
- Planning ownership: account/settings/Trusted Fill/session/coordinator Python test families.
- Acceptance: Lease/authority/revision/recovery and redaction assertions survive; native evidence remains owned by T03.

### T10 — CLI and workspace regression conversion

- Agent tasks: T10.R → T10.I → T10.V.
- Implementation prerequisites: P01.V.
- Parent gates: REMOVE.
- Planning ownership: Store/HTTP/CLI validation Python test families.
- Acceptance: All argv/status/stream/auth/route/startup assertions retained and mapped to inventoried surfaces.

### T11 — Policy, replay and privacy regression conversion

- Agent tasks: T11.R → T11.I → T11.V.
- Implementation prerequisites: P01.V.
- Parent gates: REMOVE.
- Planning ownership: policy/replay/promotion/privacy Python test families.
- Acceptance: Human-only final action, signed identity, interrupted promotion and leak canary assertions survive.

### T12 — Package and runtime regression conversion

- Agent tasks: T12.R → T12.I → T12.V.
- Implementation prerequisites: P01.V.
- Parent gates: REMOVE.
- Planning ownership: package/install/upgrade/runtime Python regression families.
- Acceptance: Cold/offline/install/upgrade/rollback tests preserve existing assertions and execute without Python.

### T13 — Source-size and policy checker conversion

- Agent tasks: T13.R → T13.I → T13.V.
- Implementation prerequisites: P01.V.
- Parent gates: REMOVE.
- Planning ownership: scripts/check-source-size.py and policy/docs checker replacements.
- Acceptance: Preserve physical-line counting, shrinking-only baseline, negative policy fixtures and exit behavior; hooks can run these checks without Python.

### T14 — Smoke, install and upgrade verifier conversion

- Agent tasks: T14.R → T14.I → T14.V.
- Implementation prerequisites: B04.V, P01.V.
- Parent gates: REMOVE.
- Planning ownership: scripts/smoke fixture/install/upgrade/workspace/lifecycle verifier replacements.
- Acceptance: Real owned installed fixtures preserve every required smoke/upgrade/rollback check and cleanup outcome without Python.

### T15 — QA fixture and scenario helper conversion

- Agent tasks: T15.R → T15.I → T15.V.
- Implementation prerequisites: Q14.V, Q15.V.
- Parent gates: REMOVE.
- Planning ownership: remaining QA fixture/scenario/walkthrough helpers.
- Acceptance: Every required helper referenced by tests/release tooling is mapped and ported; synthetic fixture identities and privacy boundaries remain unchanged.

## G task group

### G01 — Store facade and CLI dispatch assembly

- Agent tasks: G01.I → G01.V.
- Implementation prerequisites: C04.V, D12.V, D05.V, D07.V, D09.V, D16.V, J04.V.
- Parent gates: ASSEMBLE.
- Planning ownership: single Store facade/CLI parser-dispatch owner.
- Acceptance: All inventoried Store CLI commands/aliases and startup writers reach TS implementation; exact stdout/stderr/exit/schema contracts; no Python business-logic fallback.

### G02 — Workspace server assembly

- Agent tasks: G02.I → G02.V.
- Implementation prerequisites: G01.V, A04.V, W01.V, W02.V, W03.V, W04.V, W05.V, U07.V.
- Parent gates: ASSEMBLE.
- Planning ownership: single workspace bootstrap/server owner.
- Acceptance: All routes, assets and auth bind correctly in one process; CLI/UI cross-visibility and startup recovery use one TS Store implementation.

### G03 — Task, attempt and QA CLI assembly

- Agent tasks: G03.I → G03.V.
- Implementation prerequisites: C06.V, Q13.V, Q07.V, Q05.V, Q14.V, Q15.V.
- Parent gates: ASSEMBLE.
- Planning ownership: single ancillary CLI dispatch/entry owner.
- Acceptance: Every task/attempt/chrome/replay/QA/policy entry point reaches the correct owned adapter; argv/streams/status and interruption cleanup match.

### G04 — Installed candidate assembly

- Agent tasks: G04.I → G04.V.
- Implementation prerequisites: G01.V, G02.V, G03.V, B07.V.
- Parent gates: ASSEMBLE.
- Planning ownership: candidate manifest and emitted-artifact assembly owner.
- Acceptance: One immutable package contains all entry points, assets and native/runtime bytes; installed behavior independent of checkout, developer env and caches.

### G05 — Integrated storage and recovery acceptance

- Agent tasks: G05.I → G05.V.
- Implementation prerequisites: G01.V, F05.V, J04.V.
- Parent gates: TX, JOUR.
- Planning ownership: integration fault/concurrency tests only.
- Acceptance: Cross-domain references, all journal types, eight writers, kill/restart and repeated recovery pass on one revision; no lost/duplicate acknowledged updates or unexplained tree differences.

### G06 — Integrated UI and HTTP acceptance

- Agent tasks: G06.I → G06.V.
- Implementation prerequisites: G02.V.
- Parent gates: UIF, PROJ.
- Planning ownership: real-browser/HTTP integration tests only.
- Acceptance: Every mapped feature runs against real routes; browser writes visible through CLI and reverse; auth negatives, stale responses and all Active/Trash workflows pass.

### G07 — Integrated task and authority acceptance

- Agent tasks: G07.I → G07.V.
- Implementation prerequisites: G03.V.
- Parent gates: ATT, FINAL, REPLAY.
- Planning ownership: synthetic task/attempt/native/capture/replay end-to-end tests.
- Acceptance: Real owned adapters preserve leases, approval, process-loss recovery and privacy; zero unauthorized final submissions and no credential/capture leaks.

### G08 — Surface/writer/required-cell closure audit

- Agent tasks: G08.I → G08.V.
- Implementation prerequisites: G04.V, G05.V, G06.V, G07.V, P01.V, P05.V.
- Parent gates: CLOSE, REF.
- Planning ownership: coverage receipts and independent reachability audit.
- Acceptance: Zero unowned CLI/HTTP/browser/document/journal/installed surfaces, zero unexplained writers, zero missing required cells; inventory growth creates new required tasks, never a residual waiver.

### G09 — Immutable pre-removal candidate test

- Agent tasks: G09.I → G09.V.
- Implementation prerequisites: G08.V, T05.V.
- Parent gates: REHEARSE.
- Planning ownership: full/platform/release test coordinator.
- Acceptance: Exact candidate passes full suites, supported native hosts, fresh/upgrade/offline and resource budgets; retain failures and internal skips, none accepted as passing mandatory cells.

### G10 — Writer switch and post-write rollback rehearsal

- Agent tasks: G10.I → G10.V.
- Implementation prerequisites: G09.V.
- Parent gates: REHEARSE.
- Planning ownership: owned-clone switch/rollback harness.
- Acceptance: Interrupt every switch boundary under contention; Python and TS never write same Store concurrently; rollback after representative TS writes restores a usable Python state and exact expected data.

### G11 — Remove Python and obsolete shipped JS

- Agent tasks: G11.I → G11.V.
- Implementation prerequisites: G10.V, T01.V, T02.V, T03.V, T04.V.
- Parent gates: REMOVE.
- Planning ownership: reviewed deletion manifest; manifests/docs/launch paths.
- Acceptance: Delete only after regressions/tooling survive; static and installed reachability audits find no required Python path or non-emitted shipped JS; keep isolated reference provenance outside required execution.

### G12 — Fresh final-artifact acceptance without Python

- Agent tasks: G12.I → G12.V.
- Implementation prerequisites: G11.V.
- Parent gates: FINALQA.
- Planning ownership: final host test receipts bound to rebuilt artifact.
- Acceptance: Rebuild after deletion, then fresh install/upgrade/offline/uninstall on every required host with Python unavailable to the TS candidate; all required tests/cells pass without bypasses. In a separate owned clone, rollback restores the preserved Python runtime/environment and validates post-TS-write data recovery.

### G13 — Independent final conversion review and handoff

- Agent tasks: G13.I → G13.V.
- Implementation prerequisites: G12.V.
- Parent gates: READY.
- Planning ownership: final evidence index, hashes, support matrix and rollback bundle.
- Acceptance: Independent compatibility/security/completeness review has no unresolved blocker; S0-S7 gates all satisfied on exact artifact; release notes and rehearsed rollback delivered; live release still separately authorized.
