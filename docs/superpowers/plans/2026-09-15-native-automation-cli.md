# Native Account and Automation CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose ten already-implemented account and automation operations through a native Store CLI leaf with Python-compatible arguments, envelopes, persistence, and redaction.

**Architecture:** Add one leaf command dispatcher over the existing automation, accounts, synthetic-account, and repository services. Test the leaf directly so this branch never edits the shared `native-jobs.ts` dispatcher; the integration owner composes it later.

**Tech Stack:** TypeScript, emitted ESM JavaScript, Node test runner, Python Store CLI differential oracle.

**Spec:** `docs/migration/acceptance-contract.md`

## Global Constraints

- Preserve exact Python command names, options, result/error envelopes, and optimistic revisions.
- Reuse existing native services and repository transactions; do not duplicate domain logic.
- Preserve value redaction and leave durable state unchanged on denial.
- Keep synthetic execution explicitly synthetic.
- Do not edit attempt, claims, trusted-fill, policy, sessions, replay, shared dispatcher, skills, catalogs, or review lock.

---

### Task 1: Differential command contract

**Files:**
- Create: `tests_js/workspace_native_automation_cli.test.mjs`
- Extend or create: `tests_js/workspace_native_automation_cli_support.mjs`

**Interfaces:**
- Covers: `automation-settings-get`, `automation-settings-update`, `automation-settings-copy-profile-email`, `automation-capability`, `account-realm-resolve`, `employer-account-list`, `employer-account-get`, `employer-account-create`, `employer-account-update`, and `employer-account-execute-synthetic`.

- [ ] **Step 1: Build independent Python/native test roots**

Seed equivalent profile, settings, and account state. Invoke `scripts/job-apply-store.py` for expected results and the future leaf dispatcher for actual results. Compare canonical envelopes, revisions, persisted documents, modes, and redaction.

- [ ] **Step 2: Encode exact option coverage**

Exercise:

```text
automation-settings-get
automation-settings-update --input FILE --expected-revision N
automation-settings-copy-profile-email --expected-profile-revision N --expected-settings-revision N
automation-capability [--platform PLATFORM]
account-realm-resolve --url URL
employer-account-list
employer-account-get --realm-ref REF
employer-account-create --url URL [--input FILE]
employer-account-update --realm-ref REF --input FILE --expected-revision N
employer-account-execute-synthetic --input FILE
```

Include missing, duplicated, malformed, stale-revision, unknown-field, conflict, no-op, and unsupported-platform cases.

- [ ] **Step 3: Run and observe the missing leaf failure**

Run: `node --test tests_js/workspace_native_automation_cli.test.mjs`

Expected: FAIL because the native leaf dispatcher is absent.

### Task 2: Native command leaf

**Files:**
- Create: `src/cli/native-automation-commands.ts`
- Generate: `runtime/cli/native-automation-commands.js`

**Interfaces:**
- Consumes: `AutomationService`, `AccountsService`, `SyntheticAccountService`, native automation projection/capability, and `NativeJobsRepository.automationTransaction`.
- Produces: `nativeAutomationCommandNames` and `runNativeAutomationCommand(command, args, context)` for later composition by `native-jobs.ts`.

- [ ] **Step 1: Define the closed command map**

```ts
export const nativeAutomationCommandNames = new Set([
  'automation-settings-get', 'automation-settings-update',
  'automation-settings-copy-profile-email', 'automation-capability',
  'account-realm-resolve', 'employer-account-list', 'employer-account-get',
  'employer-account-create', 'employer-account-update',
  'employer-account-execute-synthetic',
]);
```

Return `null` only for an unknown command so the shared dispatcher can continue to other command families. For recognized commands, reject unknown or extra arguments before entering a transaction.

- [ ] **Step 2: Bind existing services without duplicating policy**

Use one repository transaction per mutation. Preserve no-op revision behavior, conflict semantics, and public redaction. Gate `employer-account-execute-synthetic` through the existing synthetic service rather than the live account adapter.

- [ ] **Step 3: Emit runtime JavaScript and run focused tests**

Run: `npm run build:runtime`

Run: `node --test tests_js/workspace_native_automation.test.mjs tests_js/workspace_native_accounts.test.mjs tests_js/workspace_native_synthetic_account.test.mjs tests_js/workspace_native_automation_integration.test.mjs tests_js/workspace_native_automation_cli.test.mjs`

Expected: PASS with no skips.

### Task 3: Verify and commit the independent leaf

- [ ] **Step 1: Run repository checks that do not require catalog integration**

Run: `npm run typecheck && npm run build:check && npm run check:size -- --base origin/staging`

- [ ] **Step 2: Confirm the shared dispatcher remains unchanged**

Run: `git diff --exit-code origin/staging -- src/cli/native-jobs.ts runtime/cli/native-jobs.js`

Expected: no diff.

- [ ] **Step 3: Commit**

```bash
git add src/cli/native-automation-commands.ts runtime/cli/native-automation-commands.js tests_js/workspace_native_automation_cli*.mjs
git commit -m "Add native account automation CLI commands"
```

