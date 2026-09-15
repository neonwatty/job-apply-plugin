# Native Policy Tree Clone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task.

**Goal:** Safely include optional final-action policy state in canonical Store cloning and activation digests.

**Architecture:** A bounded policy-tree walker validates the exact `auto-submit` filesystem grammar, locks it during snapshots, copies exact bytes into private targets, and contributes framed relative paths and entry types to Store digests. Canonical clone/layout/writer-switch call the walker; policy content authority remains in the existing policy service.

**Files owned by this tranche:**
- Create `src/store/native-policy-tree.ts`
- Modify `src/store/native-store-clone.ts`
- Modify `src/store/native-store-layout.ts`
- Modify `src/store/native-writer-switch.ts`
- Generate matching `runtime/store/*.js`
- Create `tests_js/native_policy_store_clone.test.mjs`
- Create one new writer-switch policy tamper test file

**Do not modify:** CLI dispatcher, `src/store/native-jobs.ts`, existing tests, catalogs, matrix, review lock, launcher, or skills.

## Task 1: Write failing filesystem-safety tests

- [ ] Cover the exact optional shapes: `.lock`, `campaign.json`, `campaigns/<64-hex>.json`, `applications/<64-hex>/<64-hex>.json`, and `receipts.jsonl`.
- [ ] Reject symlinks, hard links, FIFOs/special files, loose permissions, stale temporary files, unknown names, and excessive depth/count/file/aggregate bytes.
- [ ] Prove a rejected tree leaves no target and missing `auto-submit` remains valid.

## Task 2: Implement the bounded walker and copier

- [ ] Validate path components and entry types with descriptor-relative identity checks where required by repository conventions.
- [ ] Hold `auto-submit/.lock` while inventorying, copying, or hashing an existing policy tree.
- [ ] Copy exact bytes into `0700` directories and `0600` files.
- [ ] Frame digests with complete relative paths and entry types to avoid ambiguity.

## Task 3: Compose clone, layout, and writer switch

- [ ] Allow `auto-submit` as an optional known root entry while preserving rejection of every other unknown entry.
- [ ] Include policy entries in source and candidate tree digests.
- [ ] Prove source or candidate policy mutation after preparation aborts activation before either Store directory moves.
- [ ] Prove concurrent policy mutation waits on the policy lock and both tamper failures preserve inode identities.

## Task 4: Verify

- [ ] Show a valid policy tree copies byte-for-byte and can be opened by `PolicyRepository`.
- [ ] Generate runtime JavaScript and run focused clone/writer-switch tests, `npm run typecheck`, `npm run build:check`, `npm run check:size`, and `git diff --check`.
- [ ] Commit only owned files and write an implementation report with commands and results.

