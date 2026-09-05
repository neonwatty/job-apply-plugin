# 500-Line Policy and Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce a hard 500-line source/test limit immediately and reduce all 30 current violations to zero without changing behavior.

**Architecture:** A merge-base-aware baseline ratchets existing violations downward while rejecting every new violation. Compatibility facades remain at public paths; implementation and tests split by responsibility behind stable exports.

**Tech Stack:** Python 3 standard library, JavaScript/MJS, Swift, shell, Node test runner, GitHub Actions

**Spec:** `docs/superpowers/specs/2026-09-04-codebase-modernization-design.md`

## Global Constraints

- Maximum 500 physical lines for scoped source, tests, launchers, and runtime files.
- No behavior, persisted-byte, privacy, CLI, HTTP, or platform contract changes.
- No baseline ceiling increases and no new baseline entries after the first policy commit.
- One owner edits the Store facade and one owner edits the workspace bootstrap at a time.
- Test-only and leaf-module lanes may run concurrently; workers must not revert other lanes.

---

### Task 1: Land the monotonic source-size gate

**Files:**
- Create: `AGENTS.md`
- Create: `.source-size-baseline.json`
- Create: `scripts/check-source-size.py`
- Create: `tests/test_source_size_policy.py`
- Modify: `package.json`
- Modify: `.github/workflows/validate.yml`

**Interfaces:**
- Produces: `check-source-size.py [--base <ref>]` and `npm run check:size`.
- Baseline shape: `{ "version": 1, "maximumLines": 500, "files": { path: { ceiling, owner, reason, removalPhase } } }`.

- [ ] **Step 1: Write policy tests** covering an exact 500-line file, 501-line new file, unterminated final line, baseline growth, required ceiling reduction, deletion, rename, and an unmapped extension.

```python
def test_new_file_above_limit_fails(self):
    self.write_source("new.py", "pass\n" * 501)
    result = self.run_check()
    self.assertNotEqual(result.returncode, 0)
    self.assertIn("new.py: 501 > 500", result.stderr)
```

- [ ] **Step 2: Run `python3 -m unittest -v tests.test_source_size_policy`; require the missing checker failure.**
- [ ] **Step 3: Implement physical-line counting, tracked-extension scope, merge-base comparison, monotonic ceilings, deterministic redacted diagnostics, and JSON validation in under 500 lines.**
- [ ] **Step 4: Generate the one-time baseline from `origin/staging`; require exactly 30 entries and manually review every path.**
- [ ] **Step 5: Add `npm run check:size` and make it the first CI job/step; run the unit test and checker.**
- [ ] **Step 6: Add the architectural and `allowed_files` requirements to `AGENTS.md`; commit `build: enforce 500-line source limit`.**

### Task 2: Split test monoliths without rewriting assertions

**Files:**
- Create: `tests/support/{store_case,store_fixtures,replay_case,pdf_fixture,workspace_case,oracle_fixtures,running_replay_server,answer_cli_case,chrome_launcher_case,compiler_case}.py`
- Create: behavior files listed in the table below.
- Delete after parity: the ten oversized Python test files and three oversized MJS test files.

**Interfaces:**
- Test support may import production modules; test files may import support but never another test file.
- Produces: independently runnable modules with no file above 500 lines.

| Source | Split families |
|---|---|
| `test_job_apply_store.py` | profile, fact-groups, answers CRUD/query/merge, jobs CRUD/upsert/legacy, claims/attention/recovery/restart, resumes storage/registry, extraction requests/proposals, history/sessions/readiness, CLI/overview/accounts/trusted-fill |
| `test_qa_replay_cli.py` | prepare, lifecycle, security, cleanup, auto-submit, committed scenarios, PDF inspection |
| `test_job_apply_workspace.py` | security, startup, jobs, answers, resumes, profile, accounts, launcher |
| `test_qa_server_oracle.py` | server, oracle events/sessions/semantics, readiness |
| Other Python violations | answer CLI/claim/resume/skill, Chrome paths/control/lifecycle, QA fixture/observation/flow, compiler contract/privacy/artifacts, promotion candidate/transaction/security, policy campaign/authorization/outcomes |
| `recorder.test.mjs` | ATS safety files, PNG, broker, capture, lifecycle |
| `workspace.test.mjs` | helpers, automation, owner-beta, markup, activity, attention, facts, answers, browser CRUD |
| `renderer.test.mjs` | generic, Greenhouse, Ashby, Lever, LinkedIn |

- [ ] **Step 1: Record current test names and counts from Python and Node as immutable inventory receipts.**
- [ ] **Step 2: Extract support helpers only; run original tests and require identical names/counts.**
- [ ] **Step 3: Move tests by behavior in parallel lanes, preserving bodies and assertions; run each new module immediately.**
- [ ] **Step 4: Run full suites, compare inventories exactly, lower/remove every affected baseline ceiling, and commit each independent family.**

### Task 3: Split leaf QA contracts and just-over-limit modules

**Files:**
- Refactor: `qa/contracts.py`, `qa/oracle.py`, `qa/server.py`, `qa/recorder_fs.py`
- Refactor: `qa/resume_extraction_onboarding_oracle.py`, `scripts/qa-account.py`
- Create: `qa/contracts_{model,fixture,observation,flow}.py`, `qa/oracle_{io,history,session}.py`, `qa/server_{auth,events,final_action}.py`, `qa/recorder_{fs_ops,broker,guardian}.py`, `qa/resume_extraction_{companion,scenario}.py`, `qa/account_{environment,walkthrough}.py`

**Interfaces:** Existing modules remain import-compatible facades and re-export current symbols.

- [ ] **Step 1: Add import-contract tests for every externally imported public and private compatibility symbol.**
- [ ] **Step 2: Move leaf constants/value validation first; prohibit reverse imports into facades.**
- [ ] **Step 3: Move IO/history/session and broker/guardian responsibilities, replacing `_EXCLUSIVE_RENAME` hidden coupling with one public primitive.**
- [ ] **Step 4: Run QA/server/promotion/replay suites, size checker, and commit each leaf independently.**

### Task 4: Split policy and answer matching

**Files:**
- Refactor: `scripts/job_apply_policy.py`, `scripts/job_apply_answer_match.py`
- Create: `scripts/job_apply_policy/{model,storage,campaigns,authorization,outcomes,cli}.py`
- Create: `scripts/job_apply_answer_matching/{features,scoring,reuse,cleanup}.py`

**Interfaces:** Existing paths re-export `PolicyStore`, `PolicyError`, constants, matcher functions, and retain current CLIs.

- [ ] **Step 1: Freeze import, CLI JSON, exit-code, receipt, and one-winner race contracts.**
- [ ] **Step 2: Extract pure models/features, then storage/scoring, then mutation orchestration.**
- [ ] **Step 3: Run policy, answer-match, Store, oracle, auto-submit, and concurrency tests.**
- [ ] **Step 4: Remove baseline entries and commit `refactor: split policy and answer matching`.**

### Task 5: Split recorder, promotion, replay, and Chrome control

**Files:**
- Refactor: `qa/recorder.mjs`, `qa/promote.py`, `scripts/qa-replay.py`, `scripts/qa-chrome.py`
- Create: `qa/recorder/{errors,resources,png,broker-client,isolated-source,capture,checkpoint,record,cli}.mjs`
- Create: `qa/recorder/safety/{common,linkedin,greenhouse,ashby,lever,workday}.mjs`
- Create: `qa/promotion/{bindings,candidate,approval,destination,deletion,rollback,transaction,cli}.py`
- Create: `qa/replay/{auto_submit,secure_io,report,run_state,server_control,prepare,lifecycle,evaluate,cleanup_preflight,cleanup,cli}.py`
- Create: `qa/chrome/{paths,owner,discovery,control,supervisor,commands,cli}.py`

**Interfaces:** Existing executable/module paths remain facades; descriptor ownership and cleanup stay in the lowest-level secure IO modules.

- [ ] **Step 1: Freeze source exports, command outputs, cleanup tombstones, promotion rollback, and Chrome lifecycle contracts.**
- [ ] **Step 2: Extract recorder ATS predicates in parallel; then capture/checkpoint/record orchestration.**
- [ ] **Step 3: Extract promotion after recorder filesystem primitives, replay after contracts/oracle/server/policy, and Chrome independently.**
- [ ] **Step 4: Run focused browser/QA suites, filesystem adversaries, full QA, size, and package smoke before each facade commit.**

### Task 6: Split native Swift by security responsibility

**Files:**
- Replace: `native/macos/job_apply_account_flow_helper.swift`
- Create: `native/macos/{OracleExecutableIdentity,OracleAccountFlowFixtures,NativeEmailOnlyBinding,AccessibilityTree,ReviewedAccountForm,OracleBrowserIdentity,MacOSAccessibilityAccountFlowHelper}.swift`
- Modify: all workflow, Python test, and build invocations enumerating Swift sources.

**Interfaces:** Preserve every existing type/function name and compiled helper behavior.

- [ ] **Step 1: Add a source-list contract so every required Swift file is compiled in every lane.**
- [ ] **Step 2: Move value types and pure identity decisions, then bindings/AX utilities, then execution.**
- [ ] **Step 3: Run `xcrun swiftc -typecheck` plus all three Mac helper suites.**
- [ ] **Step 4: Remove the old file/baseline entry and commit `refactor: modularize macOS account flow helper`.**

### Task 7: Establish the Store compatibility facade and dependency rule

**Files:**
- Refactor: `scripts/job-apply-store.py`
- Create: `scripts/job_apply_store/{constants,errors,io,normalization,base}.py`
- Create: `scripts/job_apply_store/validation/{profile_answers,sessions,jobs_resumes,extraction,accounts}.py`
- Create: `tests/test_store_facade_contract.py`

**Interfaces:** `job-apply-store.py` remains executable and re-exports every symbol consumed by tests and dynamic loaders. Domain modules import only common primitives, never the facade.

- [ ] **Step 1: Generate an import/export inventory and CLI `--help` golden receipt.**
- [ ] **Step 2: Add a dependency test rejecting imports from package modules back into the facade.**
- [ ] **Step 3: Extract constants/errors/IO/normalization/validators in that order, running focused and full Store tests after each move.**
- [ ] **Step 4: Commit the stable facade before dispatching domain workers.**

### Task 8: Extract Store domains in controlled parallel waves

**Files:**
- Create under `scripts/job_apply_store/`: profile/fact groups; answer read/write/merge; job CRUD/overview/upsert/legacy; coordinator/claims/attention/restart; resume storage/registry; extraction requests/proposals; history/sessions/readiness/approval; account settings/operations/email/password/trusted fill; CLI parser/dispatch.

**Interfaces:** Each service receives Store paths/lock/clock/nonce collaborators explicitly or operates through `self`; no sibling implementation imports.

- [ ] **Step 1: Extract read-only profile, fact-group, and answer paths in parallel after Task 7.**
- [ ] **Step 2: Extract answer mutations and jobs; require cloned-Store byte equivalence.**
- [ ] **Step 3: Extract coordinator and journals with kill-point recovery tests before resumes/extraction.**
- [ ] **Step 4: Extract sessions/readiness/accounts and finally parser/dispatch tables.**
- [ ] **Step 5: Run all Store, task, attempt, workspace, Windows, package, privacy, and crash suites; require the facade <=500 lines.**

### Task 9: Split workspace server, browser application, and smoke harness

**Files:**
- Refactor: `scripts/job-apply-workspace.py`, `workspace/app.js`, `scripts/smoke-plugin.sh`
- Create: `scripts/job_apply_workspace/{projections,http,auth,queries,handler,cli}.py` and domain mutation modules.
- Create: `workspace/lib/{api,helpers,state,dom}.js`, `workspace/features/*.js`, `workspace/{bindings,bootstrap}.js`.
- Create: `scripts/smoke/{store_lifecycle,repository_contracts,fixture_build,upgrade_verify,workspace_verify,plugin_install_verify}.py`.

**Interfaces:** Workspace features receive `{api,state,dom,coordinators}` context and never import one another. The shell owns one temporary root and cleanup; smoke helpers accept explicit arguments.

- [ ] **Step 1: Freeze authenticated HTTP and browser helper exports; add explicit context tests.**
- [ ] **Step 2: Split server projections/auth/queries before mutations and handler.**
- [ ] **Step 3: Move pure UI helpers/state, then read-only views, mutation controllers, jobs/activity, and bootstrap.**
- [ ] **Step 4: Extract embedded smoke programs and compare installed-byte receipts exactly.**
- [ ] **Step 5: Run workspace Python/browser, package, upgrade, size, and accessibility suites.**

### Task 10: Close the ratchet

**Files:**
- Delete: `.source-size-baseline.json`
- Modify: `scripts/check-source-size.py`, `AGENTS.md`, CI documentation.

- [ ] **Step 1: Require the checker inventory to report zero exceptions and every scoped file <=500.**
- [ ] **Step 2: Remove baseline support so exceptions cannot silently return.**
- [ ] **Step 3: Run `test:fast`, `test:full`, `test:platform`, and `test:release` from the tiered plan.**
- [ ] **Step 4: Commit `build: make 500-line limit unconditional`.**
