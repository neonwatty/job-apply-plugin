# macOS Employer-Account Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a private, disabled-by-default, production-capable Workday employer-account seam on macOS, explicitly classify reviewed Greenhouse applications as accountless, and keep future ATS/platform adapters additive and fail-closed.

**Architecture:** Extend the existing realm, protected credential, T007 authority, native Accessibility, and Store-journal boundaries instead of creating a parallel subsystem. Portable Python contracts validate closed requests and receipts; a reviewed macOS helper performs exact page/control binding and compound secret delivery; Store orchestration owns revision checks, at-most-once authority, lifecycle, typed attention, recovery, and same-realm reuse. No public CLI or HTTP route can execute a live account operation.

**Tech Stack:** Python 3 standard library and `unittest`; Swift with Security.framework, ApplicationServices, AppKit, and CryptoKit; existing authenticated loopback Companion; GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-02-macos-employer-account-automation-design.md`

## Global Constraints

- Start from `origin/staging`; target the unmerged PR to `staging`.
- Do not bump the plugin version, install or replace the plugin, merge, promote, tag, or release.
- Do not access the owner's Store, Keychain, browser profile, or a live employer portal.
- Do not create a real account or activate an application final action.
- Do not expose live account execution through CLI, HTTP, Companion, or ordinary skill routes.
- Keep `unique_per_realm` as the only live-capable Workday password strategy.
- Preserve `shared`, `custom`, and `ask_each_time` settings but route them to human attention; document shared-password automation as follow-up.
- Greenhouse is accountless only for reviewed ordinary application URLs; unknown/login/candidate-home surfaces remain unresolved.
- Tests must be written and observed failing before production changes.
- Local verification must exclude the Keychain-mutating integration test and visible-browser tests; gated macOS CI supplies those proofs on runner-owned state.

---

### Task 1: ATS-neutral flow decisions and Greenhouse accountless classification

**Files:**
- Modify: `scripts/job_apply_accounts.py`
- Modify: `scripts/job-apply-store.py`
- Modify: `tests/test_job_apply_accounts.py`
- Modify: `tests/test_job_apply_store.py`

**Interfaces:**
- Produces: `classify_account_flow(portal_url: str) -> dict[str, Any]`
- Produces: `Store.employer_account_flow_decision(job_id: str) -> dict[str, Any]`
- Decision states: `create_required`, `reuse_active`, `account_not_required`, `human_attention_required`

- [ ] **Step 1: Write failing resolver tests**

  Add literal-table tests proving exact reviewed Greenhouse board/application URL families return `account_not_required`; login, candidate-home, query credentials, malformed, and unknown Greenhouse paths remain unresolved. Prove existing Workday and Oracle realm identities do not change.

- [ ] **Step 2: Run resolver tests and confirm RED**

  Run: `python3 -m unittest -v tests.test_job_apply_accounts`

- [ ] **Step 3: Implement the minimal registry/classifier**

  Add explicit flow adapters and a narrow Greenhouse accountless adapter. Keep realm normalization responsible only for credential-bearing/stored realms.

- [ ] **Step 4: Run resolver tests and confirm GREEN**

  Run: `python3 -m unittest -v tests.test_job_apply_accounts`

- [ ] **Step 5: Write failing Store decision tests**

  Exercise real temporary Store records for discovered Workday, active Workday, reviewed Greenhouse, unresolved pages, and terminal employer-account states. Assert value-free outputs and zero mutation for Greenhouse.

- [ ] **Step 6: Run Store decision tests and confirm RED**

  Run: `python3 -m unittest -v tests.test_job_apply_store.JobApplyStoreTests.test_employer_account_flow_decisions_are_value_free_and_fail_closed`

- [ ] **Step 7: Implement Store flow decision**

  Reuse canonical job URL and account metadata under the Store lock. Do not return URL, email, descriptor, credential reference, or provider details.

- [ ] **Step 8: Run focused and adjacent tests**

  Run: `python3 -m unittest -v tests.test_job_apply_accounts tests.test_job_apply_store.JobApplyStoreTests.test_employer_account_flow_decisions_are_value_free_and_fail_closed`

- [ ] **Step 9: Commit Task 1**

  Run: `git add scripts/job_apply_accounts.py scripts/job-apply-store.py tests/test_job_apply_accounts.py tests/test_job_apply_store.py && git commit -m "feat: classify employer account flows by ATS"`

### Task 2: Portable Workday password-flow contract

**Files:**
- Create: `scripts/job_apply_password_account_flows.py`
- Create: `tests/test_job_apply_password_account_flows.py`
- Modify: `scripts/job_apply_credentials.py`
- Modify: `tests/test_job_apply_credentials.py`

**Interfaces:**
- Produces: `PasswordAccountAutomationProvider.prepare(request: dict) -> dict`
- Produces: `PasswordAccountAutomationProvider.execute(request: dict, private_email: Callable[[], str]) -> dict`
- Produces: `validate_password_preparation_request`, `validate_password_execution_request`, `validate_password_receipt`
- Consumes: existing `credential_reference("unique_per_realm", realm_ref)`

- [ ] **Step 1: Write failing portable contract tests**

  Prove exact fields/revisions/fingerprints, strict HTTPS Workday realm binding, unique-per-realm-only strategy, closed effects, no final action, at-most-one account activation, and value-free receipts. Reject shared/custom/ask strategies, query/userinfo/fragment URLs, wrong realms, extra fields, and secret-shaped outputs.

- [ ] **Step 2: Run contract tests and confirm RED**

  Run: `python3 -m unittest -v tests.test_job_apply_password_account_flows`

- [ ] **Step 3: Implement the minimal portable contract**

  Keep browser and credential implementations injected. Separate read-only preparation from effectful execution and use literal closed outcome/reason sets.

- [ ] **Step 4: Run contract tests and confirm GREEN**

  Run: `python3 -m unittest -v tests.test_job_apply_password_account_flows tests.test_job_apply_credentials`

- [ ] **Step 5: Commit Task 2**

  Run: `git add scripts/job_apply_password_account_flows.py scripts/job_apply_credentials.py tests/test_job_apply_password_account_flows.py tests/test_job_apply_credentials.py && git commit -m "feat: add portable password account flow contract"`

### Task 3: T007 binding, Store orchestration, typed handoffs, and reuse

**Files:**
- Modify: `scripts/job_apply_account_canary.py`
- Modify: `scripts/job_apply_account_canary_executor.py`
- Modify: `scripts/job-apply-store.py`
- Modify: `tests/test_job_apply_account_canary.py`
- Modify: `tests/test_job_apply_account_canary_executor.py`
- Modify: `tests/test_job_apply_store.py`

**Interfaces:**
- Produces: password-flow final/preparation T007 scopes using existing durable ledger
- Produces: `LiveAccountCanaryExecutor.execute_approved_password(...)`
- Produces: `Store.revalidate_live_password_*`, `prepare_live_password_account_execution`, `execute_live_password_account`
- Consumes: Task 2 request/receipt contract

- [ ] **Step 1: Write failing authority/executor tests**

  Prove domain-separated Workday preparation/final scopes, exact claim rebinding, one-attempt concurrency, expiry, binding drift, and that no final application action can be represented.

- [ ] **Step 2: Run authority/executor tests and confirm RED**

  Run: `python3 -m unittest -v tests.test_job_apply_account_canary tests.test_job_apply_account_canary_executor`

- [ ] **Step 3: Extend authority and private executor minimally**

  Reuse the durable ledger and stable-to-claim execution binding. Branch only on validated `flowKind`; expose no new CLI/HTTP entry point.

- [ ] **Step 4: Run authority/executor tests and confirm GREEN**

  Run: `python3 -m unittest -v tests.test_job_apply_account_canary tests.test_job_apply_account_canary_executor`

- [ ] **Step 5: Write failing Store orchestration tests**

  Use temporary Stores and a strict fake native provider. Cover global email/per-realm override, unique-realm credential reference, new/reused credential metadata, active-realm no-op, shared/custom/ask attention, typed email/CAPTCHA/MFA/reset/ambiguous blockers, terminal no-retry states, value-free persistence, one-winner concurrency, and crash points before/after journal, authority, native entry, activation, handoff, and clear.

- [ ] **Step 6: Run focused Store tests and confirm RED**

  Run the newly added `test_live_workday_*` and `test_workday_*` methods explicitly with `python3 -m unittest -v`.

- [ ] **Step 7: Implement Store orchestration**

  Add conservative helpers alongside the Oracle implementation. Write the journal before authority/native effects, consume authority before browser effects, never retry an effect, map typed reasons to existing value-free blocker structures, and retain backwards-compatible account records.

- [ ] **Step 8: Run focused Store tests and confirm GREEN**

  Run: `python3 -m unittest -v tests.test_job_apply_store tests.test_job_apply_account_canary_executor`

- [ ] **Step 9: Commit Task 3**

  Run: `git add scripts/job_apply_account_canary.py scripts/job_apply_account_canary_executor.py scripts/job-apply-store.py tests/test_job_apply_account_canary.py tests/test_job_apply_account_canary_executor.py tests/test_job_apply_store.py && git commit -m "feat: orchestrate private Workday account canary"`

### Task 4: Reviewed macOS Workday native adapter

**Files:**
- Create: `native/macos/job_apply_workday_account_flow_helper.swift`
- Create: `scripts/job_apply_password_account_flows_macos.py`
- Create: `tests/test_macos_workday_account_flow_helper.py`
- Modify: `native/macos/job_apply_browser_bridge.swift`
- Modify: `native/macos/job_apply_credential_helper.swift`
- Modify: `native/macos/job_apply_credential_helper_main.swift`
- Modify: `native/macos/job_apply_credential_helper_tests.swift`
- Modify: `tests/test_macos_credential_helper.py`

**Interfaces:**
- Produces: `NativeMacOSWorkdayAccountProvider.from_reviewed_sources(...)`
- Implements: Task 2 `prepare` and `execute`
- Consumes: existing Security.framework realm-slot helper and signed-browser validation

- [ ] **Step 1: Write failing Python/native behavior tests**

  Add a provider-construction test that compiles only reviewed sources, pins binary digest/device/inode, uses a private email descriptor, and returns value-free JSON. Add executable adversarial fixtures for wrong realm/page/browser/control cardinality, unknown actions, hidden/disabled controls, wrong secure subrole, fingerprint drift, and all closed outcomes.

- [ ] **Step 2: Run tests and confirm RED without Keychain/browser access**

  Run: `python3 -m unittest -v tests.test_macos_workday_account_flow_helper`

- [ ] **Step 3: Implement read-only native preparation**

  Factor signed-browser/page helpers only where behavior is identical. Enumerate and fingerprint exact Workday controls through Accessibility. Preparation must contain no write, focus, activation, Keychain, email, or password operation.

- [ ] **Step 4: Run preparation tests and Swift typecheck**

  Run focused Python tests, then `xcrun swiftc -typecheck` over the complete reviewed source set.

- [ ] **Step 5: Write failing compound execution tests**

  Add silent in-memory native fixtures proving email/private descriptor handling, unique realm slot parity, password direct-fill, buffer cleanup, exact reattestation, one Create Account activation, no effect retry, and causal outcome classification. Tests must not call Security.framework item APIs against the owner Keychain.

- [ ] **Step 6: Run execution fixtures and confirm RED**

  Run the new fixture command from a temporary compiled helper.

- [ ] **Step 7: Implement compound execution**

  Deliver email and Keychain-owned password directly to exact Accessibility controls, activate the exact account control once, observe without effect retry, and emit a value-free attestation over the authenticated local native channel.

- [ ] **Step 8: Run native tests and confirm GREEN**

  Run Swift typecheck, silent adversarial fixture commands, and every non-Keychain/non-visible test in `tests.test_macos_credential_helper` and `tests.test_macos_workday_account_flow_helper` explicitly.

- [ ] **Step 9: Commit Task 4**

  Run: `git add native/macos scripts/job_apply_password_account_flows_macos.py tests/test_macos_credential_helper.py tests/test_macos_workday_account_flow_helper.py && git commit -m "feat: add reviewed macOS Workday account boundary"`

### Task 5: Capability, UX truthfulness, documentation, and CI gates

**Files:**
- Modify: `scripts/job_apply_credentials_macos.py`
- Modify: `scripts/job-apply-workspace.py`
- Modify: `workspace/app.js`
- Modify: `workspace/index.html`
- Modify: `tests/test_job_apply_workspace.py`
- Modify: `tests_js/workspace.test.mjs`
- Modify: `skills/job-apply/SKILL.md`
- Modify: `README.md`
- Modify: `.github/workflows/validate.yml`
- Modify: `package.json`

**Interfaces:**
- Produces: side-effect-free capability distinguishing `productionSeamReady`, `liveExecutionEnabled`, and `syntheticOperationsReady`
- Consumes: Task 1 flow decisions and Task 4 macOS provider discovery

- [ ] **Step 1: Write failing capability and workspace tests**

  Assert macOS reports a reviewed Workday seam but live execution disabled; Linux/Windows remain unsupported; Greenhouse accountless status is clear; the UI offers settings/recovery only and contains no live execution control.

- [ ] **Step 2: Run tests and confirm RED**

  Run: `python3 -m unittest -v tests.test_job_apply_workspace tests.test_job_apply_credentials && node --test --test-name-pattern='automation|account' tests_js/workspace.test.mjs`

- [ ] **Step 3: Implement capability and copy changes**

  Keep settings and recovery shared between CLI and Companion. Update product language to distinguish a reviewed disabled seam from production-enabled account creation.

- [ ] **Step 4: Add CI-only native commands**

  Extend the existing macOS job to typecheck and run silent Workday fixtures. Keep any visible-browser or isolated Keychain command behind the existing explicit CI environment gate; do not add a local default-on route.

- [ ] **Step 5: Document follow-up scope**

  Record shared-password automation and additional ATS account adapters as follow-ups. Reiterate that ordinary flows pause and a real canary requires fresh sequential owner approval.

- [ ] **Step 6: Run focused verification**

  Run workspace, account, credential, canary, native safe, and JavaScript automation tests plus documentation checks.

- [ ] **Step 7: Commit Task 5**

  Run: `git add .github/workflows/validate.yml README.md package.json scripts/job_apply_credentials_macos.py scripts/job-apply-workspace.py skills/job-apply/SKILL.md workspace tests/test_job_apply_workspace.py tests_js/workspace.test.mjs && git commit -m "docs: expose truthful employer automation capability"`

### Task 6: Full safe verification and unmerged PR

**Files:**
- Verify all changed files
- No version files may change

- [ ] **Step 1: Run the full Python suite except the owner-Keychain integration method**

  Enumerate tests explicitly or generate a temporary unittest suite that excludes only `MacOSCredentialHelperTests.test_compiled_isolated_keychain_integration_is_silent_and_cleans_up`. Do not run `scripts/qa-account.py` visible-browser commands locally.

- [ ] **Step 2: Run full JavaScript and package checks**

  Run: `npm run test:qa-browser`, `npm run test:qa-screening`, `npm run test:auto-submit`, `bash scripts/smoke-plugin.sh`, and `bash scripts/check-links.sh`.

- [ ] **Step 3: Run safe native verification**

  Run Swift typecheck and silent pure fixture executables only. Confirm no process accessed a live portal or owner Keychain.

- [ ] **Step 4: Audit requirements and repository state**

  Run `git diff --check origin/staging...HEAD`, inspect changed paths, confirm no plugin version change, no secret-bearing output/files, no live route, and no unrelated UX/data-entry reliability edits.

- [ ] **Step 5: Push and create the unmerged PR**

  Push `codex/macos-employer-account-hardening`, create a PR into `staging`, and include exact local verification plus explicitly skipped owner-state gates.

- [ ] **Step 6: Monitor CI**

  Wait for every check, investigate failures, push bounded fixes through test-first cycles, and report the exact final head, PR URL, check results, and remaining limitations. Do not merge.
