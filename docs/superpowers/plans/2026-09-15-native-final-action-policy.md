# Native Final-Action Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the campaign and human-only final-action authority to TypeScript with byte-compatible persistence, one-winner concurrency, and value-free public state.

**Architecture:** Implement closed models, persistence, campaign lifecycle, authorization, final-action claims, and outcomes as separate modules behind one service. Reuse the native POSIX lock, atomic JSON, private-filesystem, JSONL, and canonical serialization primitives. Keep Python and shipped callers unchanged until integration.

**Tech Stack:** TypeScript, emitted ESM JavaScript, Node.js crypto/filesystem, Node test runner, Python differential oracle.

**Spec:** `docs/migration/acceptance-contract.md`

## Global Constraints

- Preserve schema version 1 and reject unknown or malformed fields.
- Persist no raw URL, answer, resume, credential, browser, or session value.
- Keep the exclusive lock held through final-action callback invocation.
- Consume a final-action claim even when its callback fails.
- Require an independent trusted confirmation event for `confirmed_submitted`.
- Preserve Python canonical JSON/JSONL bytes, modes, fsync ordering, and repair behavior.
- Do not edit Store cloning, launcher, skills, QA server/replay, catalogs, or review lock.

---

### Task 1: Closed policy model and differential vectors

**Files:**
- Create: `src/final-action-policy/model.ts`
- Create: `tools/contracts/final-action-policy/reference.py`
- Create: `tests_js/final_action_policy_support.mjs`
- Create: `tests_js/final_action_policy_reference.test.mjs`

**Interfaces:**
- Produces: closed campaign, application, authorization, claim, outcome, and receipt documents.
- Produces: canonical digest and HMAC confirmation helpers.

- [ ] **Step 1: Add deterministic Python reference cases**

Load `scripts/job_apply_policy`, inject fixed UTC times, opaque IDs, capabilities, and trusted events, and emit only redacted results plus file bytes/modes/tree digests. Cover valid documents and every malformed, unknown-field, future-version, origin, ATS, reference, scope, and timestamp rejection.

- [ ] **Step 2: Write failing TypeScript differential tests**

Run: `node --test tests_js/final_action_policy_reference.test.mjs`

Expected: FAIL because the native policy modules are missing.

- [ ] **Step 3: Implement closed validators and cryptographic helpers**

Use branded opaque references, exact HTTP(S) origin normalization, strict UTC instants, SHA-256 fingerprints, and timing-safe HMAC comparison. Export explicit parse/serialize functions rather than permissive casts.

- [ ] **Step 4: Run model differential cases to green**

Run: `node --test tests_js/final_action_policy_reference.test.mjs`

Expected: model cases pass with no secret/value leakage.

### Task 2: Repository and campaign lifecycle

**Files:**
- Create: `src/final-action-policy/repository.ts`
- Create: `src/final-action-policy/campaigns.ts`
- Extend: `tests_js/final_action_policy_reference.test.mjs`

**Interfaces:**
- Consumes: `withExclusiveFileLock`, `atomicWriteJson`, private filesystem, JSONL, and persisted JSON helpers.
- Produces: locked reads/writes under `<Store>/auto-submit`.
- Produces: status, activate, archive recovery, kill, and revoke operations.

- [ ] **Step 1: Add failing persistence and campaign cases**

Cover `0700` directories, `0600` files/lock, default review-only state, maximum ten applications, maximum four-hour duration, exact acknowledged risk, immutable active rules/scope/revisions, corrupt state, expiry, sticky kill, revoke, interrupted archive repair, and conflicting archive rejection.

- [ ] **Step 2: Implement the repository**

Use atomic temp-write/flush/fsync/chmod/replace/parent-fsync ordering. Derive application paths only from validated opaque suffixes. Read and validate the complete campaign/application/attempt/receipt relationship while holding one Store lock.

- [ ] **Step 3: Implement campaign operations and rerun differential tests**

Run: `node --test tests_js/final_action_policy_reference.test.mjs`

Expected: campaign results and persisted bytes match Python.

### Task 3: Authorization, final-action claim, and outcomes

**Files:**
- Create: `src/final-action-policy/authorization.ts`
- Create: `src/final-action-policy/outcomes.ts`
- Create: `src/final-action-policy/service.ts`
- Create: `tests_js/final_action_policy_concurrency.test.mjs`

**Interfaces:**
- Produces: `FinalActionPolicyService` with status, activate, authorize, claim, outcome, kill, and revoke methods.
- Consumes: injected clock, opaque-reference generator, and activation callback.

- [ ] **Step 1: Write failing concurrency and recovery tests**

Use ten or more processes to prove unique contiguous slots, the application cap, idempotent identical authorization, one winning final-action claimant, kill-versus-claim linearization, consumed authority after callback failure, one uncertain retry, terminal exhaustion, trusted confirmation HMAC, and idempotent missing-JSONL projection repair.

- [ ] **Step 2: Implement authorization and reservation**

Require exact campaign, rule, resume revision, sensitive allowlist, capability, authorization digest, application, attempt, lease, and fresh observed state. Cap leases at five minutes and campaign expiry. Return review-only for missing/corrupt policy.

- [ ] **Step 3: Implement final-action claiming**

Persist `action_claimed` before invoking the callback, keep the same exclusive lock held during the callback, permit exactly one claimant, and leave the claim consumed on callback failure. Treat `claimProof` as informational only.

- [ ] **Step 4: Implement outcomes**

Require a separate `isolated_loopback` or `approved_real_canary` event for confirmation. Persist the canonical receipt in the application before a single-write/fsynced JSONL projection. Repair a missing identical projection without producing another receipt.

- [ ] **Step 5: Run reference and concurrency tests**

Run: `node --test tests_js/final_action_policy_reference.test.mjs tests_js/final_action_policy_concurrency.test.mjs`

Expected: PASS with no skips.

### Task 4: Seven-command native CLI

**Files:**
- Create: `src/cli/native-final-action-policy.ts`
- Create: `tests_js/final_action_policy_cli.test.mjs`
- Generate: `runtime/final-action-policy/*.js`
- Generate: `runtime/cli/native-final-action-policy.js`

**Interfaces:**
- Produces: `status`, `activate`, `authorize`, `claim-final-action`, `record-outcome`, `kill`, and `revoke` commands.

- [ ] **Step 1: Write failing CLI tests**

Cover every command, stdin/file input, explicit/environment/default root, sorted JSON stdout, safe stderr, exit 2 on rejection, Python absent from `PATH`, and lack of browser/QA imports.

- [ ] **Step 2: Implement the CLI and emit runtime JavaScript**

Resolve the packaged lock provider and instantiate `FinalActionPolicyService`. Keep activation as an injected internal callback boundary; the command must never obtain browser authority itself.

Run: `npm run build:runtime`

- [ ] **Step 3: Run all focused policy tests**

Run: `node --test tests_js/final_action_policy_reference.test.mjs tests_js/final_action_policy_concurrency.test.mjs tests_js/final_action_policy_cli.test.mjs`

Expected: PASS with no skips.

### Task 5: Verify and commit the independent tranche

- [ ] **Step 1: Run the existing Python policy oracle**

Run: `python3 -m unittest -v tests.test_job_apply_policy_campaign tests.test_job_apply_policy_authorization tests.test_job_apply_policy_outcomes tests.test_qa_server tests.test_qa_replay_auto_submit`

- [ ] **Step 2: Run source/runtime verification**

Run: `npm run typecheck && npm run build:check && npm run check:size -- --base origin/staging`

- [ ] **Step 3: Commit**

```bash
git add src/final-action-policy src/cli/native-final-action-policy.ts runtime/final-action-policy runtime/cli/native-final-action-policy.js tools/contracts/final-action-policy tests_js/final_action_policy_*.mjs
git commit -m "Add native final-action policy"
```

