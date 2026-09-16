# Python Runtime Closure Cutover Plan

**Goal:** Route ordinary application attempts and final-action policy through their existing native TypeScript CLIs, with the already-shipped native-first Store and task commands, while preserving explicit whole-process Python rollback, isolated QA replay, and differential oracles.

**Architecture:** The shipped skills invoke `runtime/cli/native-attempt.js`, `runtime/cli/native-final-action-policy.js`, `runtime/cli/native-jobs.js`, and `runtime/cli/native-task.js`. The native attempt broker continues to own claim authority and the native policy service continues to own campaign/final-action authority. Python implementations remain available for explicit whole-process rollback, isolated QA replay, and differential oracles; this tranche does not claim a Python-free installed package.

**Tech Stack:** TypeScript/Node.js, Node test runner, Python unittest compatibility oracles, native POSIX flock addon, Markdown skill instructions.

**Spec:** `docs/migration/python-runtime-closure.md`

## Global Constraints

- Preserve all CLI JSON envelopes, exit codes, root precedence, revision checks, privacy guarantees, and human-only final submission.
- Never allow Python and TypeScript writers to mutate the same live Store.
- Keep Python differential oracles and QA fixtures isolated from ordinary shipped routing.
- Do not remove the Companion's durable Python rollback path in this tranche.
- Keep every scoped source and test file at or below 500 physical lines without adding source-size exceptions.

## Review ruling: atomic writer handoff

Review found that ordinary Store and task skill routes had already moved to the
native CLIs, beyond the original attempt/policy-only wording. This plan records
that handoff as atomic: an ordinary workflow chooses one complete native writer
process, while Python is entered only through an explicit whole-process rollback
or an isolated QA/differential path. A Python rollback never shares or resumes a
native Store mutation, so the retained package assets do not create dual-writer
routing or a Python-free-package claim.

### Task 1: Close native attempt ownership parity

**Files:**
- Modify: `tests_js/native_attempt_lifecycle.test.mjs`
- Modify: `src/cli/attempt-broker.ts`
- Verify generated output: `runtime/cli/attempt-broker.js`

**Interfaces:**
- Consumes: `runAttemptBroker(root, service, provider, options)` and the existing `<socket>.lock` ownership file.
- Produces: rejection of a hard-linked broker ownership file before flock acquisition or Store mutation.

- [ ] Add a lifecycle test that creates the expected broker lock file with mode `0600`, hard-links it, calls `runAttemptBroker`, and expects `attempt ownership unavailable` without Store mutation.
- [ ] Run `node --test tests_js/native_attempt_lifecycle.test.mjs` and confirm the new assertion fails because `nlink` is not checked.
- [ ] Require `info.nlink === 1` in `runAttemptBroker` alongside the existing type, uid, and mode checks.
- [ ] Rebuild the checked-in runtime with `npm run build:runtime`.
- [ ] Rerun the lifecycle test and confirm it passes.

### Task 2: Switch ordinary attempt routing to native

**Files:**
- Modify: `tests/test_answer_skill.py`
- Modify: `skills/job-apply/SKILL.md`
- Modify: `skills/job-apply/references/intake.md`
- Modify: `skills/job-apply/references/application.md`
- Modify: `skills/job-apply/references/recovery.md`
- Modify: `skills/job-apply/references/readiness.md`
- Modify: `skills/answer-memory/SKILL.md`
- Modify: `skills/answer-memory/references/storage-contract.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: `node "<plugin-root>/runtime/cli/native-attempt.js" [--root ...] <command>`.
- Produces: the same five documented commands: `start`, `restart-review`, `heartbeat`, `progress`, and `handoff`.

- [ ] Change `tests/test_answer_skill.py` to require the native attempt path and reject `job-apply-attempt.py` in loaded shipped skill text.
- [ ] Run the focused Python test and confirm it fails against current instructions.
- [ ] Replace every ordinary skill command and narrative reference with the native executable while preserving arguments, private temporary-file rules, response names, and no-fallback rules.
- [ ] Update the README runtime description without changing the documented authority model.
- [ ] Rerun the focused skill test and native attempt protocol/lifecycle suites.

### Task 3: Switch final-action policy routing to native

**Files:**
- Modify: `tests/test_answer_skill.py`
- Modify: `skills/answer-memory/references/policy.md`
- Modify: `skills/answer-memory/references/storage-contract.md`
- Modify: `skills/job-apply/references/account-canaries.md`

**Interfaces:**
- Consumes: `node "<plugin-root>/runtime/cli/native-final-action-policy.js"` with `status`, `activate`, `authorize`, `claim-final-action`, `record-outcome`, `kill`, and `revoke`.
- Produces: unchanged campaign, authorization, claim, outcome, kill-switch, and revocation behavior.

- [ ] Change the focused skill test to require the native policy executable and reject the Python policy facade from shipped skill text.
- [ ] Run the focused test and confirm it fails against current instructions.
- [ ] Replace the seven policy commands and policy-authority narrative with the native CLI/service.
- [ ] Run the focused skill test plus `final_action_policy_reference`, `final_action_policy_concurrency`, and `final_action_policy_cli` tests.

### Task 4: Reconcile installed runtime and migration inventory

**Files:**
- Modify: `tests_js/installed_artifacts_reference.test.mjs`
- Modify: `tests_js/installed_artifacts_ts_support.mjs`
- Modify: `tools/contracts/installed-artifacts/support.py`
- Modify: `tools/contracts/artifact-copy-order/support.py`
- Modify: `tools/contracts/artifact-copy-metadata/support.py`
- Modify: `tests_js/artifact_copy_order_reference.test.mjs`
- Modify: `tests_js/artifact_copy_metadata_reference.test.mjs`
- Modify: `tests_js/artifact_data_copy_reference.test.mjs`
- Modify: `src/package/installed-artifacts.ts`
- Modify: `scripts/smoke/artifacts.py`
- Modify: `scripts/smoke-plugin.sh`
- Modify: `config/migration/python-runtime-closure.json`
- Modify: `docs/migration/python-runtime-closure.md`

**Interfaces:**
- Consumes: critical installed-artifact inventory and migration discovery from shipped skill/routing files.
- Produces: native attempt smoke coverage; no critical-runtime claim for `scripts/job-apply-attempt.py`; removal of stale attempt and policy declarations after shipped callers disappear; QA replay remains explicitly Python-required; legacy Store/workspace Python trees remain inventoried for rollback.

- [ ] Update installed-artifact reference tests first so they require `runtime/cli/native-attempt.js` and no longer require the Python attempt script as a fixed critical file.
- [ ] Run the focused installed-artifact tests and confirm the expected inventory mismatch.
- [ ] Update TypeScript and Python artifact inventories plus smoke entry-point invocation.
- [ ] Remove the now-stale attempt and policy entries from `python-runtime-closure.json`; retain QA replay and all still-discovered rollback/compatibility entry points.
- [ ] Update the migration document to describe native-first ordinary routing, the atomic writer handoff, Python differential oracles, isolated QA replay, and the remaining rollback/package work without claiming a Python-free package.
- [ ] Run installed-artifact reference suites and `npm run check:migration`.

### Task 5: Validate and prepare delivery

**Files:**
- Verify all changed files and generated runtime output.

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: a reviewable branch proving native attempt/policy routing without claiming Python-free package completion.

- [ ] Run `npm run build:check`, `npm run typecheck`, `npm run check:size`, and `npm run check:test-matrix`.
- [ ] Run `npm run test:affected -- --base origin/staging`.
- [ ] Record the known baseline-only local Mac identity failure if it recurs unchanged: `Python alias and resolved executable disagree` in `tests_js/runtime-support.test.mjs`.
- [ ] Review the diff for accidental Python/TypeScript dual-writer routing and verify `git diff --check`.
- [ ] Commit the tested tranche. Create a staging PR only after all change-related gates pass.
