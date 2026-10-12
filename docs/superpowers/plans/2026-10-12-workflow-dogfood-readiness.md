# Experimental dogfood readiness implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development. The owner approved these three parallel workstreams; the parent owns shared contracts, integration, and testing.

**Goal:** Make the successful Reddit pilot repeatable through a packaged experimental plugin, explicit interruption recovery, and clearer browser verification instructions.

**Architecture:** Preserve the current finite ledger, exact-revision owner broker, managed-resume guard, and readiness validator. Extend the owner policy to permit an explicitly requested reviewed restart only with the original current input scope. Package committed artifacts into a fresh verifiable local marketplace; host applications continue to supply browser tools.

**Tech stack:** TypeScript, checked-in ESM runtime, native Store, Node package tooling, Codex/Claude host plugins.

**Spec:** `docs/architecture/agent-workflow-dogfood-readiness.md`; continuation approved after the Reddit live pilot and PR #217.

## Global constraints and shared contracts

- Base: PR #217, `c62d736db726e6b222057826ae266bcd53f95487`; no staging merge or global plugin replacement.
- All implementation checks use isolated fictional Stores. Do not touch the pending Reddit application or real applicant Store.
- No new persisted schema, final submission capability, browser automation transport, or model endpoint.
- Explicit owner events remain required for acquire, recover, and restart. Live claims cannot be stolen.
- Restart requires an unambiguous finished application task at the current reviewed job revision and unchanged `preparationScope`, plus current confirmed managed resume/facts.
- Existing expired-task recovery retains the original task inputs. Drift still permits a guarded Needs Info exit, never silent rebinding.
- Historical review evidence remains intact but cannot satisfy readiness for a new attempt. A fresh session with accepted `resume.file` is required.
- Package verification proves artifact integrity, not host UI activation or live ATS behavior. Native artifact portability is limited to its built platform/architecture.
- Redacted readback is not a mismatch or successful verification. Supported visual verification or a blocked handoff is required.
- Each worker edits only its declared files; parent owns runtime generation, test matrix, installed integration, shared docs, and Git operations.

## Parallel work packages

### 1. Packaging

Allowed: `tools/dogfood-package.mjs`, `tests_js/dogfood_package.test.mjs`, `docs/dogfood-package.md`.

- [x] Test committed-ref packaging, dirty/untracked exclusion, new output directory, provenance, and tamper rejection.
- [ ] Build and verify the disposable local marketplace; record installed registration separately from unverified desktop discovery.
- [x] Document opt-in installation and rollback without executing an agent CLI or changing the real Store.

### 2. Recovery

Allowed: `src/app/owner-workflow-policy.ts`, `src/app/owner-workflow-recovery.ts`, `src/integrations/host/owner-claim-broker.ts`, `tests_js/workspace_owner_workflow_recovery.test.mjs`.

- [x] Test explicit reviewed restart, missing/ambiguous prior identity, stale inputs/revisions, live claim refusal, expiry recovery, and safe exit after drift.
- [x] Add the narrow owner policy and expose existing canonical restart descriptors without weakening native guards.
- [x] Preserve checkpoint history and reject copied readiness from the preceding attempt.

### 3. Pilot friction

Allowed: `skills/job-apply/references/browser.md`, `skills/job-apply/references/host-browser-workflow.md`, `evals/workflows/pilot-friction.mjs`, `tests_js/workspace_host_browser_pilot_friction.test.mjs`.

- [x] Prefer a visible Attach control in the observed resume group over a hidden input.
- [x] Distinguish redaction from actual mismatch; prohibit blind retyping and redaction-as-success.
- [x] Cover guidance and synthetic evaluation counterexamples without claiming fresh live-model acceptance.

### 4. Parent integration

- [x] Add installed-process review/restart/fresh-review regression and receipt/claim-release assertions.
- [x] Update owner recovery guidance, architecture progress, test ownership, generated runtime, and installed artifact checks.
- [ ] Complete installed release tier and normal hooks (focused checks and both affected selections completed).
- [ ] Finish final review and push a PR stacked on #217. Independent roles completed; corrected Companion bootstrap packaging finding.

## Review focus

1. A live claim or a different task must never be adopted by a replacement broker.
2. A changed queue/run, resume, or facts must not be silently accepted by reviewed restart.
3. A saved checkpoint or redacted field must never be promoted into fresh browser evidence.
4. A package must contain the reviewed committed bytes and no applicant data, local receipts, or dependency caches.
5. Documentation must distinguish installed synthetic checks, historical Reddit evidence, and untested current host activation.
