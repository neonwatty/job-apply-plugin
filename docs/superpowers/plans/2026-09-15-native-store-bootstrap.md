# Native Store Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task.

**Goal:** Implement Python-compatible native `init` and `paths` command leaves without changing the shared dispatcher.

**Architecture:** A bootstrap service owns ordinary first-run directory/document creation, existing-document preflight validation, legacy-profile migration, and exact path projection. The CLI leaf parses only these commands. Shared dispatcher and repository composition remain integration-owned.

**Files owned by this tranche:**
- Create `src/store/native-store-bootstrap.ts`
- Create `src/cli/native-store-bootstrap.ts`
- Generate `runtime/store/native-store-bootstrap.js`
- Generate `runtime/cli/native-store-bootstrap.js`
- Create `tests_js/workspace_native_store_bootstrap_cli.test.mjs`

**Do not modify:** `src/cli/native-jobs.ts`, `src/store/native-jobs.ts`, `src/store/native-store-layout.ts`, `src/store/native-store-clone.ts`, generated counterparts, catalogs, matrix, review lock, launcher, or skills.

## Task 1: Pin the Python contract with failing differentials

- [ ] Add focused tests for the exact 18-field `paths` envelope and prove it does not create an absent root.
- [ ] Add `init` tests for empty root, repeat idempotence, private modes, legacy-profile migration, and exact result envelope.
- [ ] Add preflight cases where corrupt or unsupported existing state causes zero writes.
- [ ] Add interruption/restart cases and reject symlink, identity-swap, loose-mode, and special-file inputs.

## Task 2: Implement pure path projection

- [ ] Port the path names and root precedence from Python `StorePaths` without initializing the filesystem.
- [ ] Preserve exact JSON field names and ordering used by the Python CLI oracle.

## Task 3: Implement ordinary initialization

- [ ] Validate all existing documents and directory identities before the first mutation.
- [ ] Create root, sessions, and resume directories with private modes and create missing core documents through crash-safe writes.
- [ ] Import the legacy profile with Python-compatible precedence and report whether migration occurred.
- [ ] Repair only the Python-compatible pending recovery states; make restart idempotent.
- [ ] Keep synthetic `fixture-init` behavior separate.

## Task 4: Add the CLI leaf and verify

- [ ] Export an explicit command set and a leaf dispatcher for `init` and `paths`.
- [ ] Generate runtime JavaScript from TypeScript.
- [ ] Run focused tests, `npm run typecheck`, `npm run build:check`, `npm run check:size`, and `git diff --check`.
- [ ] Commit only owned files and write an implementation report with commands and results.

