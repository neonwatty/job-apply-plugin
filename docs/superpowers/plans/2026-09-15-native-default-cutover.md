# Native Default Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the installed TypeScript Companion and Store the ordinary default with a process-owned atomic Python rollback path, complete shipped command routing, and evidence-bound release validation.

**Architecture:** Land independent attempt, final-action policy, and account/automation CLI tranches first. Then close the remaining Store compatibility commands, add a production supervisor around the existing process-owned switch, update shipped callers atomically, and serialize migration metadata and immutable evidence. Python QA/reference tooling remains installed only where explicitly classified until the later Python-free artifact tranche.

**Tech Stack:** TypeScript, emitted ESM JavaScript, Next.js Companion, Node-API POSIX flock, Node/Python differential tests, GitHub Actions.

**Spec:** `docs/migration/controlled-writer-routing.md`

## Global Constraints

- Base every independent tranche on `b4cdfe93e085f27edec8290186703062479b2e93`.
- Never operate on the owner's live Store; use disposable owned roots and canonical clones.
- Preserve one writer and one policy authority across activation, rollback, restart, and failure recovery.
- Do not silently fall back to Python after native startup failure.
- Preserve a manual human-only final action and value-free metadata.
- Keep Python rollback explicit and restore the exact original Store bytes.
- Keep QA/reference Python classified separately from ordinary product routing.
- Generate runtime JavaScript from TypeScript; never edit the pair independently.
- Regenerate `config/migration/review-lock.json` after every other migration JSON is final.

---

### Task 1: Integrate the three parallel prerequisites

**Files:**
- Consume commits from: `2026-09-15-native-attempt-runtime.md`
- Consume commits from: `2026-09-15-native-final-action-policy.md`
- Consume commits from: `2026-09-15-native-automation-cli.md`

- [ ] **Step 1: Review each commit against its exclusive ownership boundary**

Reject changes to launcher, skills, shared native dispatcher, catalogs, and review lock from parallel workers. Confirm each source/runtime pair was generated together and focused tests pass on its branch.

- [ ] **Step 2: Cherry-pick the three commits into the integration branch**

Resolve no behavioral conflicts by weakening tests. If two commits touch a shared file, restore the base version and perform the composition in a later integration task.

- [ ] **Step 3: Run all three focused suites together**

Run: `node --test --test-concurrency=1 tests_js/native_attempt_protocol.test.mjs tests_js/native_attempt_lifecycle.test.mjs tests_js/final_action_policy_reference.test.mjs tests_js/final_action_policy_concurrency.test.mjs tests_js/final_action_policy_cli.test.mjs tests_js/workspace_native_automation_cli.test.mjs`

Expected: PASS with no skips.

### Task 2: Close ordinary Store CLI compatibility

**Files:**
- Create focused command leaf modules under: `src/cli/`
- Generate matching modules under: `runtime/cli/`
- Modify: `src/cli/native-jobs.ts`
- Generate: `runtime/cli/native-jobs.js`
- Modify: `src/store/native-store-layout.ts`
- Modify: `src/store/native-store-clone.ts`
- Generate: `runtime/store/native-store-layout.js`
- Generate: `runtime/store/native-store-clone.js`
- Test: new focused `tests_js/workspace_native_*_cli.test.mjs` files

**Interfaces:**
- Must add: `init`, `paths`, `history-append`, `history-list`, `profile-preparedness-get`, `resume-create`, `session-save`, `session-load`, `session-list`, `session-delete`, `replay-transition`, and `trusted-fill-approve/status/evaluate/revoke`.
- Must alias: `attention-approval-preview` and `attention-approval-approve` to the existing approval service without changing semantics.
- Must compose the ten account/automation commands from Task 1.

- [ ] **Step 1: Add a static Python/native command inventory test**

Parse Python `add_parser(...)` command names and union all native leaf command sets. Require zero missing names and reject duplicate native ownership.

- [ ] **Step 2: Implement ordinary initialization and paths**

Define first-run ownership for `JOB_APPLY_STORE_DIR` and `~/.job-apply`, private modes, legacy profile migration, and restart. Keep `fixture-init` restricted to synthetic roots. Add interruption tests before routing any shipped caller.

- [ ] **Step 3: Implement compatibility state leaves**

Expose history, standalone sessions, profile preparedness, and `resume-create` through repository methods that hold the existing Store lock. Preserve Python envelopes, optimistic revisions, privacy, and byte-compatible state.

- [ ] **Step 4: Compose trusted-fill, replay-transition, approvals, and account/automation leaves**

Use existing services and the new policy runtime. Do not create a second authority or lock domain. Exercise all 98 command names through the shared dispatcher.

- [ ] **Step 5: Include final-action policy state in canonical clones**

Replace the current blanket rejection of `auto-submit` with a bounded recursive inventory for campaign, archive, application, and receipt files. Preserve source bytes and private modes, reject symlinks/special files/unknown paths and excessive depth or count, include the tree in source/candidate digests, and prove post-preparation tampering prevents activation before either Store moves.

- [ ] **Step 6: Run Store differential and static closure tests**

Run the new focused suites plus `tests_js/workspace_native_task_cli.test.mjs` and all existing native Store/automation/account/trusted-fill suites.

Expected: every Python Store command has one native owner and tested success/denial behavior.

### Task 3: Production supervisor and safe activation

**Files:**
- Create: `apps/companion/supervise.mjs`
- Modify: `apps/companion/launch.mjs`
- Modify: `apps/companion/writer-route.mjs`
- Modify as required: `src/store/process-owned-writer.ts`
- Generate: `runtime/store/process-owned-writer.js`
- Test: `tests_js/companion_default_cutover.test.mjs`

**Interfaces:**
- No `--writer` selects the native ordinary route after successful owned preparation/activation.
- Explicit rollback quiesces the full native process group, retains native state, restores Python bytes, and starts Python.
- Activation/rollback refuses a live detached attempt broker or invokes its explicit quiescence protocol without clearing its claim.

- [ ] **Step 1: Write failing default and recovery tests**

Cover first run, initialized Python Store, prepared candidate, normal native restart, concurrent supervisor, lock/addon/readiness failure, controller death, live attempt broker, interrupted activation/rollback, and explicit rollback. Assert zero silent Python fallback.

- [ ] **Step 2: Separate outer supervision from inner service launch**

Keep `launch.mjs` as the owned Companion service and put activation/recovery in `supervise.mjs`. The supervisor holds the lifetime lease, sets `COMPANION_PROCESS_OWNER=process-group-v1`, preserves fd 3, and owns the complete Store/Next process group.

- [ ] **Step 3: Implement ordinary root preparation and native default routing**

Resolve `--root`, `JOB_APPLY_STORE_DIR`, then `~/.job-apply`. Initialize or clone only under the owned supervisor. Validate source/candidate digests under both Store locks immediately before same-parent renames.

- [ ] **Step 4: Implement explicit rollback**

Require unambiguous native-active/Python-retained state, quiesce the known process group and attempt broker, rename through `rollbackNativeWriter`, restart Python only after recovery, and retain the post-write native directory.

- [ ] **Step 5: Run focused cutover tests**

Run: `node --test --test-concurrency=1 tests_js/companion_default_cutover.test.mjs tests_js/native_writer_switch_rehearsal.test.mjs tests_js/process_owned_writer_quiescence.test.mjs`

Expected: PASS with no skips on supported POSIX hosts.

### Task 4: Installed and upgrade validation

**Files:**
- Modify: `scripts/smoke/native_activation.mjs`
- Modify: `scripts/smoke-plugin.sh`
- Modify: `config/test-matrix.json`
- Modify: `.github/workflows/validate.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/nightly.yml`
- Modify: `tests_js/ci-shadow.test.mjs`

- [ ] **Step 1: Make installed smoke use the no-flag default**

With an empty `PATH`, launch the installed supervisor without `--writer`, require Next HTML and native `/api/boot`, mutate representative Store and policy state, restart, and verify persistence.

- [ ] **Step 2: Exercise explicit rollback and retained native state**

Restore the exact Python tree, start Python only with the normal environment, verify native-only mutations are absent, and reopen the retained native Store to prove those mutations remain available.

- [ ] **Step 3: Add fresh-install and previous-version upgrade cases**

Verify exact installed bytes, no runtime download/build, bounded process cleanup, native startup failure without fallback, and upgrade preservation across the previous Python-default package.

- [ ] **Step 4: Register required Linux and macOS cells**

Add a `native-default-cutover` full/platform suite, map every test/support/smoke/launcher input, add installed cutover jobs to validate/release/nightly, and make the aggregate gate require them. Keep Windows explicitly deferred until the POSIX boundary changes.

### Task 5: Switch shipped routing and close migration metadata

**Files:**
- Modify: `skills/job-workspace/SKILL.md`
- Modify: applicable `skills/job-apply/**` and `skills/answer-memory/**` command references
- Modify: `README.md`
- Modify: `config/migration/python-runtime-closure.json`
- Modify: `tools/migration/python-runtime-closure.mjs`
- Modify: closure validator tests
- Modify: applicable `config/migration/source-catalog-*.json`
- Modify last: `config/migration/review-lock.json`
- Modify: `docs/migration/controlled-writer-routing.md`
- Modify: `docs/migration/python-runtime-closure.md`
- Modify: `docs/runtime-support.md`

- [ ] **Step 1: Route ordinary skill commands to installed native executables**

Keep explicit Python rollback instructions separate from normal operation. Preserve browser-open behavior formerly provided by `job-apply-workspace.py`.

- [ ] **Step 2: Extend the closure schema truthfully**

Add a state representing TypeScript-default with retained Python rollback, require the replacement to exist in installed inventory, and reject the state while an ordinary shipped caller still invokes Python. Keep `qa-replay.py` classified as repository/QA Python until the Python-free artifact tranche.

- [ ] **Step 3: Update source catalogs from exact final bytes**

Use repository migration tooling. Add new source/runtime/test ownership and refresh existing hashes only for actually changed files.

- [ ] **Step 4: Regenerate review lock last**

After every migration JSON is final, regenerate `config/migration/review-lock.json`; make no later catalog edit without regenerating it again.

- [ ] **Step 5: Update claims documents from observed evidence**

State supported OS/runtime scope, ordinary routing, rollback behavior, retained QA Python, and remaining Python-free release work. Do not claim live owner-Store activation or publication.

### Task 6: Final verification, review, PR, and staging merge

- [ ] **Step 1: Run focused and migration checks**

Run: `npm run typecheck && npm run companion:typecheck && npm run build:runtime && npm run build:check && npm run check:test-matrix && npm run check:migration && npm run check:size -- --base origin/staging`

- [ ] **Step 2: Run commit and deep verification on the immutable head**

Run: `npm run verify:commit`

Run: `npm run verify:deep -- --head <immutable-head> --base b4cdfe93e085f27edec8290186703062479b2e93`

Expected: every selected required suite passes; required host cells have zero skips.

- [ ] **Step 3: Run installed release validation**

Run: `npm run test:release -- --receipt ci-receipts/native-default-cutover-release.json`

Expected: installed no-flag native default, restart, explicit Python rollback, exact restored bytes, and retained native state all pass.

- [ ] **Step 4: Request independent code review and fix every validated blocker**

Review authority lifetime, process ownership, broker quiescence, default/fallback semantics, Store migration, privacy, installed bytes, and CI gates.

- [ ] **Step 5: Create and shepherd the staging PR**

Push `codex/native-default-cutover`, create a PR targeting `staging`, monitor every required job, repair genuine failures, merge only when green, then monitor Validate Plugin and Release Validation on the merge SHA.
