# TypeScript Strangler Migration Implementation Plan

> **For agentic workers:** Assign bounded work packages with explicit allowed files, dependencies, and verification. Use isolated worktrees for parallel writers and independent review of each immutable result. One integration owner updates shared configuration, launchers, and package inventories. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Python and browser JavaScript with a modular TypeScript application while retaining only necessary Swift native helpers and preserving every existing safety/data contract.

**Architecture:** Freeze external behavior, port pure/read-only seams first, and compare Python and TypeScript on separate cloned Stores. TypeScript mutation code remains shadow-only until all canonical writers switch atomically; race-sensitive replay and policy components migrate last.

**Tech Stack:** Node, TypeScript, ES modules, JSON Schema, Node test runner/Playwright, retained Swift

**Spec:** `docs/superpowers/specs/2026-09-04-codebase-modernization-design.md`

## Current starting point and parallel ownership

The Python decomposition now provides concrete migration seams: Store domains
under `scripts/job_apply_store/domains/` cover profile/facts, answers, jobs,
coordinator, resumes, extraction, sessions, accounts, and startup. Shared
validation, I/O, runtime bindings, compatibility adapters, CLI parser and
dispatcher are separate modules. Workspace HTTP/auth/projections and route
domains live under `scripts/job_apply_workspace/`; browser bootstrap, shared
libraries, and features live under `workspace/`. The installed-package smoke
harness is split under `scripts/smoke/`. Preserve these boundaries during ports.

The public Store contract is **98 commands**, checked by the parser contract;
90 is obsolete. TypeScript implementation and Python removal are not completed
by this extraction. Facade assembly is complete (365 lines, no size exceptions);
accept integrated deterministic and installed-package verification before
starting the port.

The runtime/platform launch gate is unresolved: local Node availability is not
evidence that fresh supported Codex and Claude installations can launch the
package on every supported OS/architecture. Task 1 must settle that evidence
and the launch strategy before runtime cutover or Python removal.

| Lane | Bounded ownership | Dependency and handoff |
| --- | --- | --- |
| Runtime and contract foundation | Task 1 probe/docs; Task 2 capture tools, schemas and vectors | Can investigate in parallel; publish stable vectors before domain ports. Integration owner alone edits manifests, package scripts, compiler/build configuration and shared contract types. |
| Pure answer/readiness policies | Task 4 answer and readiness modules plus their tests | Starts after Tasks 2–3; owns pure functions only. Hands off policy interfaces to Store read/mutation lanes. |
| Pure account policies | Task 4 realm/settings/flow/Trusted Fill policy modules plus their tests | Starts after Tasks 2–3; native adapters and durable account operations stay with later tasks. |
| Browser UI | Task 5 UI modules and UI tests | Starts after frozen HTTP contracts and build setup; one owner controls browser bootstrap. Recorder work uses a separate subtree and can take a freed slot. |
| Store reads and HTTP | Task 6 read-only document/projection/routes modules and tests | Starts after Tasks 2–3; consumes published policies. Does not own transaction primitives or mutation routes. |
| Transactions and mutation domains | Task 7 primitives, followed by bounded Task 8 domain packages | Primitive contracts land first. Domain workers get disjoint subtrees and disposable cloned Stores; one owner controls journal integration and writer cutover. |

With three worker slots, start the runtime probe, contract corpus, and build
scaffold in disjoint files; shared contract types follow the frozen corpus.
Then rotate capacity into pure policies,
UI, and read-only Store work as their prerequisites land. Queue dependent work
instead of assigning overlapping files. Review focused results independently,
and run broader cross-domain/package checks once at integration points.

Python remains the only live writer throughout these lanes. Differential tests
must run Python and TypeScript against separate clones; even read-only rollout
must exclude startup repair, migration, journal recovery and implicit writes.

## Global Constraints

- Complete the 500-line facade decomposition and tiered test foundation first.
- Every TS/test/compiled-runtime/Swift file <=500 lines; no monolithic bundle.
- No mixed Python/TypeScript writes to a live Store.
- No schema bump or public command/path change during compatibility phases.
- Installed plugin performs no dependency installation or network fetch.
- Python is removed only after runtime, upgrade, rollback, and packaged-agent gates pass.
- CI equivalence observation is pending: retain legacy execution until at least
  20 PR runs have zero unexplained divergence; keep affected selection in shadow
  for two weeks with zero omitted failures. Infrastructure or local passes do
  not satisfy either external observation gate.

---

### Task 1: Resolve the Node runtime and packaging gate

**Files:**
- Create: `docs/runtime-support.md`
- Create: `tools/probe-installed-runtime.mjs`
- Create: `tests_js/runtime-support.test.mjs`
- Modify later: plugin manifests and README runtime declarations.

**Interfaces:** Probe returns value-free `{platform,arch,nodeAvailable,nodeVersion,launchMode}`.

- [ ] **Step 1: Test the probe against missing, unsupported, and supported Node without exposing executable paths.**
- [ ] **Step 2: Run it in fresh supported Codex and Claude plugin installations on Linux, macOS, and Windows.**
- [ ] **Step 3: Decide and document one final launch mode: guaranteed Node runtime or signed standalone executable per OS/architecture.**
- [ ] **Step 4: Block all Python-removal tasks until this gate passes; commit the evidence contract.**

### Task 2: Freeze public, persisted, and privacy contracts

**Files:**
- Create: `contracts/cli/*.schema.json`, `contracts/store/*.schema.json`, `contracts/http/*.schema.json`
- Create: `test/contract/vectors/**`
- Create: `tools/capture-python-contracts.mjs`, `tools/verify-contract-redaction.mjs`

**Interfaces:** Golden vectors cover all 98 Store commands, task/attempt/QA/policy families, authenticated workspace routes, schema-version-1 documents, and stable error codes.

- [ ] **Step 1: Capture clean/legacy/trashed/corrupt/future Store reads with injected clocks/nonces and prove rejected cases do not change bytes or mtimes.**
- [ ] **Step 2: Capture mutation results on disposable clones, including permissions, journal stages, restart recovery, and append-only history.**
- [ ] **Step 3: Add secret canaries and require stdout/stderr/files/artifacts to satisfy existing redaction rules.**
- [ ] **Step 4: Run all current Python tiers unchanged and commit the frozen contract corpus.**

### Task 3: Establish the sub-500-line TypeScript workspace

**Files:**
- Create: `tsconfig.json`, `src/`, `test/`, `runtime/` build configuration
- Create: `src/contracts/{errors,common,profile,fact-groups,answers,jobs,resumes,sessions,claims,accounts,trusted-fill,workspace-api}.ts`
- Create: `src/build/build-runtime.ts`, `test/contract/build-runtime.test.ts`
- Modify: `package.json`, package inventory checks.

**Interfaces:** Strict ES modules compile one-to-one into `runtime/`; exported JSON types validate through runtime parsers rather than unchecked casts.

- [ ] **Step 1: Add strict compiler settings, source maps excluded from the plugin, deterministic output, and no bundle.**
- [ ] **Step 2: Test reproducible runtime bytes and one-source-to-one-module inventory.**
- [ ] **Step 3: Define closed error/result and schema-version types from frozen vectors.**
- [ ] **Step 4: Add typecheck/build to fast/full/package tiers and commit.**

### Task 4: Port pure domain seams in parallel

**Files:**
- Create: `src/domain/answers/{identity,matching,reuse,cleanup,merge}.ts`
- Create: `src/domain/attempts/readiness.ts`
- Create: `src/domain/accounts/{realms,settings,flows,trusted-fill}.ts`
- Create corresponding `test/unit/**/*.test.ts` files.

**Interfaces:** Pure functions accept/return validated JSON values and injected policy configuration; they perform no filesystem, browser, clock, random, or process work.

- [ ] **Step 1: Port answer matching and form readiness from existing extracted Python leaf modules.**
- [ ] **Step 2: Port accounts, credentials metadata, password-flow decisions, and Trusted Fill policy in independent lanes.**
- [ ] **Step 3: Run every frozen vector through Python and TS and require canonical JSON/error equality.**
- [ ] **Step 4: Keep Python authoritative; commit each 100%-equivalent pure domain independently.**

### Task 5: Convert browser UI and recorder JavaScript

**Files:**
- Replace modular `workspace/**/*.js` with `src/workspace-ui/{api,state,render,bindings,bootstrap}.ts` and feature/view/dialog modules.
- Replace modular `qa/recorder/**/*.mjs` and renderer/oracle JS with `src/qa/recorder/**` and `src/qa/renderer/**` TypeScript.
- Move tests to `test/{unit,integration}/workspace-ui` and `test/integration/recorder`.

**Interfaces:** UI features receive explicit context; ATS safety predicates remain pure; compiled runtime preserves current browser exports and DOM behavior.

- [ ] **Step 1: Convert pure helper modules and run differential unit vectors.**
- [ ] **Step 2: Convert feature controllers/read-only rendering before mutations/bootstrap.**
- [ ] **Step 3: Convert ATS recorder predicates in parallel, then capture/checkpoint/record orchestration.**
- [ ] **Step 4: Run Playwright, accessibility, browser/CLI parity, package inventory, and size gates before removing original JS.**

### Task 6: Implement TypeScript Store reads and workspace HTTP in shadow mode

**Files:**
- Create: `src/store/{paths,permissions,read-json,read-jsonl,validation,startup-validation}.ts`
- Create: `src/store/documents/{profile,fact-groups,answers,jobs,resumes,sessions,accounts}.ts`
- Create: `src/workspace/{server,auth,static,errors,projections}.ts`
- Create: `src/workspace/routes/{read,profile,facts,answers,jobs,resumes,accounts}.ts`

**Interfaces:** `StoreReader` exposes validated snapshot/projection reads only. Shadow mode accepts only cloned/read-only roots and asserts zero byte/mtime changes.

Task 7 owns write-capable locking, atomic JSON and JSONL primitives; this task
must not implement initialization, recovery, or writes under read-only names.

- [ ] **Step 1: Implement path/permission/version validation and document loaders against clean, legacy, corrupt, future, symlink, and reparse fixtures.**
- [ ] **Step 2: Compare every read CLI and workspace projection with Python exact canonical JSON.**
- [ ] **Step 3: Implement loopback Host/Origin/Bearer/no-store/error behavior and compare status, headers, and bodies.**
- [ ] **Step 4: Cut read-only workspace routes over behind a reversible launcher flag only after zero differential failures.**

### Task 7: Implement atomic TypeScript storage primitives

**Files:**
- Create: `src/store/{lock,atomic-json,jsonl,secure-path}.ts`
- Create: `test/platform/store-primitives.*.test.ts`

**Interfaces:** One TypeScript `StoreTransaction` owns locking, same-directory temp creation, mode enforcement, flush/fsync, atomic rename, directory fsync, and journal append.

- [ ] **Step 1: Reproduce POSIX and Windows lock exclusion in isolated TS-only fixtures; do not attempt interoperability with Python locks.**
- [ ] **Step 2: Add crash injection before/after every write, fsync, rename, journal stage, and cleanup boundary.**
- [ ] **Step 3: Add eight-or-more concurrent writer, symlink/reparse substitution, path identity, permission, and process-kill tests on all platforms.**
- [ ] **Step 4: Keep all primitives shadow-only until the atomic writer cutover.**

### Task 8: Port mutation domains on separate cloned Stores

**Files:**
- Create: `src/domain/jobs/{identity,provenance,preflight,lifecycle,upsert,attention}.ts`
- Create: `src/domain/resumes/{records,files,proposals}.ts`
- Complete answer/account mutation modules.
- Create: `src/store/journals/{coordinator,resume-extraction,account-operation}.ts`

**Interfaces:** A test harness clones one pre-state twice, injects identical clock/nonces, runs Python and TS separately, and compares response plus durable/recovered state.

- [ ] **Step 1: Port profile/facts, then answers, then jobs/upsert in independent shadow lanes.**
- [ ] **Step 2: Port resumes/file staging and proposals with byte/digest/recovery comparison.**
- [ ] **Step 3: Port accounts/Trusted Fill, then coordinator/answer-merge/extraction/account journals last.**
- [ ] **Step 4: Require exact equivalence for normal writes, conflicts, stale revisions, crashes, restart roll-forward, deletes, and privacy scans.**

### Task 9: Atomically cut over the canonical mutation engine

**Files:**
- Create: `src/store/store.ts`
- Create: `src/cli/store/{main,parser,dispatch-profile,dispatch-answers,dispatch-jobs,dispatch-resumes,dispatch-claims,dispatch-accounts}.ts`
- Convert `scripts/job-apply-{store,task,workspace}.py` into temporary exec-only compatibility launchers.

**Interfaces:** All public commands route to one TS Store process; no Python business logic or writer remains reachable.

- [ ] **Step 1: Run full clean-store and upgrade suites on Linux/macOS/Windows, including all 98 commands and package installs.**
- [ ] **Step 2: Run concurrency, every journal kill point, corrupt/future preservation, legacy import, permissions, and rollback rehearsals.**
- [ ] **Step 3: Switch all Store/task/workspace mutations in one release candidate; assert process inventory contains no Python writer.**
- [ ] **Step 4: Roll back automatically on any differential, privacy, platform, or recovery failure; otherwise hold one full release observation window.**

### Task 10: Port attempt broker and retained Swift adapters

**Files:**
- Create: `src/cli/attempt/*.ts`, `src/domain/attempts/{session,claim,handoff}.ts`
- Create: `src/native/macos/{build,identity,credential-adapter,account-flow-adapter}.ts`
- Retain: split `native/macos/*.swift` files.

- [ ] **Step 1: Port detached broker lifecycle with bearer only in memory and same-user restricted socket/pipe behavior.**
- [ ] **Step 2: Prove lease, 60-second heartbeat, explicit recovery, restart-review, and process-loss semantics.**
- [ ] **Step 3: Wrap Swift compilation/identity/attestation without weakening digest, device/inode, code-signing, or focused-control checks.**
- [ ] **Step 4: Keep visible browser observations advisory and deterministic native contracts required.**

### Task 11: Port replay, promotion, Chrome, and final-action policy last

**Files:**
- Create: `src/cli/{qa-replay,qa-chrome,policy}.ts`
- Create: `src/qa/{contracts,compiler,oracle,privacy,promotion,replay,chrome}/**/*.ts`
- Remove corresponding Python only after gates pass.

- [ ] **Step 1: Port descriptor-relative cleanup, signed tombstones, promotion rollback, and Chrome supervision against adversarial vectors.**
- [ ] **Step 2: Port auto-submit policy with one-winner concurrency and zero unauthorized final actions.**
- [ ] **Step 3: Run complete QA fixture, privacy, browser, promotion, cleanup, interruption, and installed-package suites.**
- [ ] **Step 4: Require previous stable package rollback to read unchanged schema-version-1 data.**

### Task 12: Complete the Python-free major release

**Files:** Remove Python production/tests/launchers; update skills, README, manifests, smoke inventory, runtime declarations, and release notes.

- [ ] **Step 1: Replace every documented `python3 <plugin-root>/...` command with the packaged Node/standalone runtime command and test every copied instruction.**
- [ ] **Step 2: Verify fresh and upgrade installations in Codex and Claude on all supported platforms with no network dependency installation.**
- [ ] **Step 3: Run fast, affected, full, platform, release, privacy, byte-parity, rollback, and 500-line gates.**
- [ ] **Step 4: Remove Python files only when repository search finds no runtime reference and only necessary Swift remains; tag the major release.**
