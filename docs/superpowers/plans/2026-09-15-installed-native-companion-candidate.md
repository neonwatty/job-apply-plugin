# Installed Native Companion Candidate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship and exercise a self-contained installed native Companion candidate on disposable canonical Store clones while rejecting prepared-candidate tampering.

**Architecture:** Version the canonical clone marker so it binds source and prepared-candidate digests, and revalidate both under Store locks immediately before the atomic rename. Build the Next.js standalone server inside the isolated marketplace fixture, include the Companion and native trees in exact installed-byte verification, and launch the installed Companion with Python unavailable during its native phase.

**Tech Stack:** TypeScript, emitted ESM JavaScript, Node.js test runner, Next.js standalone output, Python smoke helpers, POSIX Node-API lock provider, Codex marketplace fixture.

**Spec:** `docs/migration/installed-native-companion-candidate.md`

## Global Constraints

- Use only disposable canonical Store clones; do not access or switch live user data.
- Keep the ordinary Companion default and shipped skill commands on Python.
- Keep Python rollback confined to the transition rehearsal.
- Do not claim Python-free, host-matrix, publication, release, or live-activation acceptance.
- Preserve the single-writer rule and hold both Store locks during activation validation.
- Keep TypeScript source and checked-in runtime JavaScript emissions byte-equivalent through `tools/build-runtime.mjs`.

---

### Task 1: Bind and verify prepared candidate contents

**Files:**
- Modify: `src/store/native-store-layout.ts`
- Modify: `src/store/native-store-clone.ts`
- Modify: `src/store/native-writer-switch.ts`
- Modify: `runtime/store/native-store-layout.js`
- Modify: `runtime/store/native-store-clone.js`
- Modify: `runtime/store/native-writer-switch.js`
- Test: `tests_js/native_canonical_store_clone.test.mjs`
- Test: `tests_js/native_writer_switch_rehearsal.test.mjs`

**Interfaces:**
- Produces: clone marker `{mode:"canonical-store-clone",version:2,sourceTree,candidateTree}`.
- Produces: `nativeCloneTrees(bytes): {sourceTree: string; candidateTree: string}`.
- Produces: `canonicalStoreCandidateTreeLocked(root): Promise<string>`; caller holds the candidate Store lock.
- Consumes: existing `canonicalStoreSourceTreeLocked`, `withExclusiveFileLock`, and native marker validation.

- [ ] **Step 1: Write failing marker and tamper tests**

Assert the prepared marker uses version 2 and contains two SHA-256 digests. Mutate `candidate/jobs.json` after preparation and assert `activateNativeWriter` rejects with `native candidate content changed after preparation`, leaving the active Python Store and candidate directory unmoved.

- [ ] **Step 2: Run the focused tests and observe failure**

Run: `node --test tests_js/native_canonical_store_clone.test.mjs tests_js/native_writer_switch_rehearsal.test.mjs`

Expected: FAIL because the marker has no `candidateTree` and activation trusts only `sourceTree`.

- [ ] **Step 3: Implement candidate digest creation and validation**

Refactor the Store-tree digest loop so source hashing excludes `.store.lock`, candidate hashing additionally excludes `.native-store-clone`, and both retain the same filename/byte framing. Write the version-2 marker only after missing documents exist. During activation, parse both marker digests, recompute source and candidate trees while both locks are held, reject either mismatch before the first rename, and preserve the existing generic marker validation boundary.

- [ ] **Step 4: Emit runtime JavaScript and run focused tests**

Run: `node tools/build-runtime.mjs`

Run: `node --test tests_js/native_canonical_store_clone.test.mjs tests_js/native_writer_switch_rehearsal.test.mjs`

Expected: PASS with zero failures and no unexpected skips.

- [ ] **Step 5: Commit the integrity boundary**

```bash
git add src/store/native-store-layout.ts src/store/native-store-clone.ts src/store/native-writer-switch.ts runtime/store/native-store-layout.js runtime/store/native-store-clone.js runtime/store/native-writer-switch.js tests_js/native_canonical_store_clone.test.mjs tests_js/native_writer_switch_rehearsal.test.mjs
git commit -m "Harden native candidate activation"
```

### Task 2: Include the production Companion in installed artifact verification

**Files:**
- Modify: `src/package/installed-artifacts.ts`
- Modify: `runtime/package/installed-artifacts.js`
- Modify: `scripts/smoke/artifacts.py`
- Modify: `scripts/smoke-plugin.sh`
- Modify: `tests_js/installed_artifacts_ts_support.mjs`
- Modify: `tests_js/installed_artifacts_reference.test.mjs`
- Modify: `tests_js/installed_artifacts_ts.test.mjs`

**Interfaces:**
- Produces: critical recursive trees `apps/companion` and `native` in both Python and TypeScript artifact inventories.
- Produces: an isolated fixture containing `apps/companion/.next/standalone/apps/companion/server.js` and its traced dependencies before marketplace installation.
- Consumes: `npm ci`, `npm run companion:build`, existing fixture exclusion validation, and exact critical-byte comparison.

- [ ] **Step 1: Write failing inventory tests**

Extend synthetic inventory expectations with `apps/companion` and `native`, and add fixtures proving missing/tampered standalone or packaged-lock files fail exact inventory/byte verification.

- [ ] **Step 2: Run inventory tests and observe failure**

Run: `node --test tests_js/installed_artifacts_reference.test.mjs tests_js/installed_artifacts_ts.test.mjs`

Expected: FAIL because the current inventories omit both trees.

- [ ] **Step 3: Extend both inventories and build the isolated fixture**

Add the two recursive trees to the Python and TypeScript inventory constants. After copying the isolated marketplace fixture, run locked `npm ci`, build/package the Companion standalone output inside the fixture, remove only the fixture’s root development `node_modules`, package the host lock provider, and then run fixture verification.

- [ ] **Step 4: Emit runtime JavaScript and run inventory tests**

Run: `node tools/build-runtime.mjs`

Run: `node --test tests_js/installed_artifacts_reference.test.mjs tests_js/installed_artifacts_ts.test.mjs`

Expected: PASS with exact Python/TypeScript inventory agreement.

- [ ] **Step 5: Commit installed artifact closure**

```bash
git add src/package/installed-artifacts.ts runtime/package/installed-artifacts.js scripts/smoke/artifacts.py scripts/smoke-plugin.sh tests_js/installed_artifacts_ts_support.mjs tests_js/installed_artifacts_reference.test.mjs tests_js/installed_artifacts_ts.test.mjs
git commit -m "Package installed Companion candidate"
```

### Task 3: Exercise the actual installed Companion without Python

**Files:**
- Modify: `scripts/smoke/native_activation.mjs`
- Modify: `docs/migration/controlled-writer-routing.md`
- Modify: `docs/migration/python-runtime-closure.md`
- Modify: `docs/migration/installed-native-companion-candidate.md`
- Modify: `config/migration/source-catalog-native-lock-package.json`
- Modify: `config/test-matrix.json` only if affected ownership validation requires the new smoke inputs.
- Test: `tests_js/native_canonical_writer_rehearsal.test.mjs`
- Test: release suite through `npm run test:release`.

**Interfaces:**
- Consumes: installed `apps/companion/launch.mjs`, explicit `--writer native-clone`, packaged native lock resolution, activated disposable clone, and rollback controller.
- Produces: installed launch evidence proving HTML/API startup, native mutation persistence across restart, native phase independence from Python on `PATH`, exact Python rollback bytes, and retained native post-write state.

- [ ] **Step 1: Make the installed smoke require the real launcher**

Replace the raw native upstream launch in `native_activation.mjs` with the installed `apps/companion/launch.mjs`. During the native phase set `PATH` to a private empty directory, request the Next origin’s root and `/api/boot`, create a synthetic job, stop, restart, and require the job to persist. Keep Python initialization and rollback verification in separately scoped calls with the normal environment.

- [ ] **Step 2: Run the installed release smoke and observe the packaging/launch boundary**

Run: `npm run test:release`

Expected before the Task 2 fixture changes are applied: FAIL because the installed production standalone is absent. Expected after Task 2: the actual installed launcher starts without Python available.

- [ ] **Step 3: Update migration evidence and ownership manifests**

Record that the installed native Companion candidate is closed only for explicit disposable clones, that the ordinary default and shipped skills remain Python, and that process-owned quiescence plus attempt/policy/Store-command closure precede activation. Update the source catalog hashes/ownership using the repository migration tooling rather than hand-writing fabricated evidence.

- [ ] **Step 4: Run focused, affected, and release verification**

Run: `node --test tests_js/native_canonical_writer_rehearsal.test.mjs tests_js/native_writer_switch_rehearsal.test.mjs tests_js/installed_artifacts_reference.test.mjs tests_js/installed_artifacts_ts.test.mjs`

Run: `npm run test:affected`

Run: `npm run test:release`

Expected: all required suites pass; the installed native phase has Python unavailable, and rollback remains a separate Python-only rehearsal.

- [ ] **Step 5: Commit candidate evidence**

```bash
git add scripts/smoke/native_activation.mjs docs/migration/controlled-writer-routing.md docs/migration/python-runtime-closure.md docs/migration/installed-native-companion-candidate.md config/migration/source-catalog-native-lock-package.json config/test-matrix.json
git commit -m "Verify installed native Companion candidate"
```

### Task 4: Review and integration readiness

**Files:**
- Review: all files changed by Tasks 1-3.
- Test: repository commit and deep validation selected from the exact final diff.

**Interfaces:**
- Consumes: immutable final branch subject and all focused/release evidence.
- Produces: reviewer disposition and exact local validation receipt suitable for a staging PR.

- [ ] **Step 1: Run plan self-review**

Confirm every spec requirement maps to a task, search the plan for placeholders, and verify all named functions and marker fields agree across tasks.

- [ ] **Step 2: Run repository commit checks**

Run: `npm run verify:commit`

Expected: all selected commit checks pass.

- [ ] **Step 3: Request independent review**

Review candidate-integrity ordering, installed inventory completeness, Python-unavailable native launch, single-writer boundaries, and claims made in docs. Resolve every Critical or Important finding with a focused regression and rerun affected checks.

- [ ] **Step 4: Run exact deep validation**

Run the repository-required `npm run verify:deep -- --head <final-head> --base 7a180021705271a91f328c0f3fe69164b720fca4` after the final commit and review fixes.

Expected: every selected suite passes; platform deferrals remain explicit and hosted CI supplies the staging matrix.

- [ ] **Step 5: Create and shepherd the staging PR**

Push `codex/native-default-candidate`, create a PR targeting `staging`, monitor the required `PR gate`, repair failures, merge only when green, and monitor both post-merge staging workflows.
