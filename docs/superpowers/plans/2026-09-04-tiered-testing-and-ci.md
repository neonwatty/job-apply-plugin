# Tiered Testing and CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver fast local feedback and a parallel, deterministic PR gate while retaining every current safety proof in an appropriate tier.

**Architecture:** A manifest maps every executable/test path to suites. One runner exposes five tiers and produces sanitized selection/timing receipts; GitHub Actions fans selected suites out beneath one stable aggregate gate.

**Tech Stack:** Node runner, Python unittest, Node test runner, Playwright, Swift compiler, GitHub Actions

**Spec:** `docs/superpowers/specs/2026-09-04-codebase-modernization-design.md`

## Global Constraints

- No deterministic test is deleted; duplication is removed only after equivalence observation.
- Unknown paths select full testing.
- Current branch-protection checks remain required until `PR gate` is proven and deliberately substituted.
- No private Store, browser profile, resume, credential, or capture is cached or uploaded.
- Every runner/config/test file is <=500 lines.

---

### Task 1: Add the test inventory, ownership matrix, and timing runner

**Files:**
- Create: `config/test-matrix.json`
- Create: `tools/test-runner.mjs`
- Create: `tools/check-test-matrix.mjs`
- Create: `tests_js/test-runner.test.mjs`
- Modify: `package.json`

**Interfaces:**
- `node tools/test-runner.mjs <fast|affected|full|platform|release> [--base ref] [--receipt path]`.
- Receipt: `{schemaVersion,baseSha,headSha,changedPaths,selectedSuites,fallbackReason,timings,status}` with no command output or environment.

- [ ] **Step 1: Write failing tests for staged/unstaged/committed changes, rename/delete, union ownership, test self-selection, global files, unknown fallback, platform Python executable, failure streaming, and receipt redaction.**
- [ ] **Step 2: Implement matrix validation requiring every tracked executable/test path to have an owner and every suite command to exist.**
- [ ] **Step 3: Implement concurrent independent-suite execution with immediate prefixed output and deterministic exit aggregation.**
- [ ] **Step 4: Add the five package commands while retaining specialized debugging aliases; commit `test: add tiered test runner`.**

### Task 2: Establish the fast tier

**Files:** Modify `config/test-matrix.json`, `package.json`, and testing documentation.

**Interfaces:** `npm run test:fast`; temporary p95 <=60s, final p95 <=30s.

- [ ] **Step 1: Classify size, JSON/schema, compile, skill/docs, pure JS, and pure Python contract suites; reject Chromium, native effects, servers, long subprocesses, and real sleeps.**
- [ ] **Step 2: Run the fast tier ten warm times and store only timing/status receipts.**
- [ ] **Step 3: Split any p95 offender instead of weakening assertions; require first deterministic failure <=15s.**
- [ ] **Step 4: Document `test:fast` as the default pre-commit command and commit.**

### Task 3: Make the full deterministic tier parallel and exact-once

**Files:** Modify matrix/runner/package scripts; test splits come from the 500-line plan.

**Interfaces:** Four Python shards (core, workspace/contracts, QA, accounts) and browser shards (recorder, renderer, workspace/other).

- [ ] **Step 1: Capture the current complete Python/Node test-name inventory and specialized-command coverage.**
- [ ] **Step 2: Run Python shards concurrently and require their union to equal full discovery with no duplicates or omissions.**
- [ ] **Step 3: Change browser execution from global concurrency 1 to file concurrency 3; require 20 consecutive green runs or isolate files into separate processes.**
- [ ] **Step 4: Keep screening and auto-submit aliases for diagnosis but remove their second execution after containing suites only when inventory equivalence passes.**
- [ ] **Step 5: Require local p95 <=4m and CI p95 <=5m; commit `test: parallelize deterministic suite`.**

### Task 4: Introduce the PR workflow in shadow mode

**Files:**
- Modify: `.github/workflows/validate.yml`
- Create: `.github/workflows/nightly.yml`

**Interfaces:** Jobs `classify`, `policy`, Python/browser shards, Windows, deterministic Mac, package contract, and `PR gate`.

- [ ] **Step 1: Add read-only permissions, explicit timeouts, and concurrency cancellation:**

```yaml
concurrency:
  group: validate-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
permissions:
  contents: read
```

- [ ] **Step 2: Configure setup-node with the chosen supported version, npm cache, and lockfile key; cache versioned Playwright directories but never state/output.**
- [ ] **Step 3: Fan deterministic shards out after classification; keep legacy jobs running temporarily for equivalence.**
- [ ] **Step 4: Implement `PR gate` with `if: always()` and fail unless every selected job succeeds; an intentionally unselected job may skip, a selected skipped/cancelled job fails.**
- [ ] **Step 5: Observe at least 20 PR runs with zero unexplained legacy/new divergence before removing legacy execution.**

### Task 5: Correct platform-test ownership

**Files:** Modify workflows and `config/test-matrix.json`.

- [ ] **Step 1: Preserve the current Windows module set exactly once plus the resume onboarding oracle.**
- [ ] **Step 2: Combine required Swift typechecks and mocked/native deterministic Python modules in one Mac lane with no Node or Chromium installation.**
- [ ] **Step 3: Move `qa-account.py verify-all` and Oracle visible-browser observation to scheduled/manual advisory Mac evidence; preserve redacted output and deterministic required contracts.**
- [ ] **Step 4: Require Windows p95 <=5m and deterministic Mac p95 <=3m; commit.**

### Task 6: Split source-package and installed-package evidence

**Files:**
- Refactor: `scripts/smoke-plugin.sh` under the 500-line plan.
- Create: `.github/workflows/release.yml`
- Modify: matrix and package scripts.

**Interfaces:** Package suites: manifest/content, privacy exclusions, Store/CLI/workspace contract, Playwright journey, Claude install, Codex fresh install, Codex upgrade/byte parity.

- [ ] **Step 1: Give each smoke family an independent command and timing receipt.**
- [ ] **Step 2: Run source package contracts on relevant PR changes; run installed browser and fresh/upgrade proofs on staging/main candidates, tags, dispatch, and nightly.**
- [ ] **Step 3: Prove the split suite produces every legacy assertion before deleting embedded duplicates.**
- [ ] **Step 4: Require release p95 <=15m without weakening installed-byte coverage.**

### Task 7: Shadow and activate affected selection

**Files:** Modify test matrix, validate/nightly workflows, and README.

- [ ] **Step 1: For two weeks, record affected selection while still running full deterministic tests.**
- [ ] **Step 2: Fail the experiment if any failing full suite was omitted; add ownership and restart the observation window.**
- [ ] **Step 3: Activate affected PR gating only after zero misses, 100% path ownership, and rename/delete/global fallback tests pass.**
- [ ] **Step 4: Continue full tests on staging/main pushes, nightly, release candidates, matrix/runner/workflow changes, and all unknown paths.**

### Task 8: Migrate branch protection safely

**External state:** GitHub repository rulesets for `staging` and `main`.

- [ ] **Step 1: Verify the current required checks and capture ruleset JSON before mutation.**
- [ ] **Step 2: Confirm `PR gate` is emitted and green for every PR shape, including deliberately skipped platform/package jobs.**
- [ ] **Step 3: With explicit repository-owner authorization, require `PR gate`, require up-to-date branches, and retain the old four staging contexts during one overlap window.**
- [ ] **Step 4: Remove old required contexts only after the overlap window; verify a failing selected shard blocks merge through `PR gate`.**

### Task 9: Enforce performance and privacy acceptance

- [ ] **Step 1: Measure warm p95: fast <=30s, affected <=90s, full CI <=5m, PR green p50 <=5m/p95 <=8m.**
- [ ] **Step 2: Verify superseded runs stop consuming runners within two minutes.**
- [ ] **Step 3: Scan every retained artifact for synthetic and real secret canaries; require only selection/timing/status/package receipts.**
- [ ] **Step 4: Publish the final tier/ownership documentation and commit `ci: activate tiered PR gate`.**
