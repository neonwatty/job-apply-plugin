# Workflow expiry, drift and dogfood readiness implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement the bounded tasks. User explicitly approved parallel execution; parent owns shared integration and serialized Git/publication gates.

**Goal:** Close genuine lease expiry and changed-input host-browser evidence gaps, and define the minimum owner dogfood path.
**Architecture:** Extend the existing isolated loopback evaluation fixture with two leaf scenario modules. Reuse installed production claim transitions and Store APIs; no new runtime, persisted format or ordinary route activation.
**Tech Stack:** TypeScript installed plugin, Node evaluation modules and tests, Codex existing host browser tools.
**Spec:** User-approved three-workstream design in this chat, plus `docs/architecture/agent-workflow-readiness.md` and `host-browser-recovery.md`.

## Global constraints

- Base PR #214 at b7fb790129ab0086d78bd21a959208bdd05bc91a; new experimental branch and stacked PR, no merge or staging promotion.
- Fictional isolated Store and loopback browser only. No owner Store, live ATS, final submission or ordinary route changes.
- Actual expiry evidence uses original lease and real time; never rewrite claim timestamps or shorten production TTL. Browser observations remain agent_attested.
- Preserve original inputs, historical confirmed facts, unrelated records and page drafts. Changed inputs invalidate progress while guarded safe exits remain available.
- Every source/test file <=500 lines. Each worker owns only its declared files. Parent alone changes shared fixture, CLI, routing and integration tests; no worker commits or broad suites.
- TDD for new behavior; focused worker checks, then parent integrated tests, required branch review and normal serial commit/deep/push gates.

### Task 1: Genuine expiry acceptance

**allowed_files:** `evals/workflows/host-browser-expiry.mjs`, `tests_js/workspace_host_browser_expiry.test.mjs`, `docs/architecture/host-browser-expiry.md`.
**Interfaces:** export `expiryScenarios`, `expiryCheckpoint(input, receipts, snapshot)`, `gradeHostBrowserExpiry(before, after)`.
- [ ] Write failing grader tests for genuine expiry ordered chain and early expiry, changed lease, missing authorization, wrong identity, malformed old report, duplicate browser writes.
- [ ] Implement exact `{kind: "claim-expired"}` checkpoint using server time and fresh post-loss context; capture observedAt and unchanged claim evidence.
- [ ] Grade original valid progress captured, owned broker loss, live rejection, real expiry, explicit authorized recovery, fresh observation, old report rejection, fresh Needs Info handoff. Require original task/input identity and preservation.
- [ ] Test module with Node test runner; document actual five-minute host trial separately from synthetic fast tests.

### Task 2: Input drift acceptance

**allowed_files:** `evals/workflows/host-browser-drift.mjs`, `tests_js/workspace_host_browser_drift.test.mjs`, `docs/architecture/host-browser-drift.md`.
**Interfaces:** export `driftScenarios`, `validateDriftInjection(input)`, `injectSourceInputDrift(state)`, `driftCheckpoint(input,receipts,snapshot,url)`, `driftReportNeedsObservation(input,receipts)`, `gradeHostBrowserDrift(before,after,scenario)`.
- [ ] Write failing tests for closed injection and grade tampering.
- [ ] Mutation accepts exactly `{kind: "source-input-drift"}`; installed `store resume-facts-draft` on source with exact current revisions and fixed fictional facts. Append one draft only.
- [ ] Return mutation/result/beforeFacts/afterFacts and before/afterDurableDigests; parent wraps canonical/page snapshots.
- [ ] Observe current context and DOM via exact drift-observation checkpoint; reject old valid progress with fresh operation ID before guarded Needs Info. Verify historical versions and every other durable file unchanged.
- [ ] Run focused tests and document evidence limits.

### Task 3: Dogfood readiness package

**allowed_files:** `docs/architecture/agent-workflow-dogfood-readiness.md`, `docs/architecture/agent-workflow-readiness.md`.
- [ ] Document verified existing implementation and remaining owner route blockers with source references.
- [ ] Define minimal opt-in selected-job scope, upload/current-readiness/manual-review acceptance, persistence horizon, rollback limitations and release/pilot gates.
- [ ] Carry PR214 facts with explicit provenance. Mark new scenario evidence pending until parent verifies it. No invented trial results or claim of staging readiness.
- [ ] Recommend two implementation slices plus release/pilot; no generic runner or authenticated host channel required for accurately labeled agent-attested pilot.

### Task 4: Shared integration and final candidate

**Owner:** parent. **Files:** host-browser-fixture.mjs, host-browser-cli.mjs, integration test module, progress docs, this plan.
- [ ] Stamp beforeAt/afterAt on command and injection receipts using server wall clock; preserve existing report schemas.
- [ ] Add narrow authenticated `/authorized-event` route for acquire/recover only with explicit host attestation; call installed event with --host-user-event, record receipt and authorizationEvidence. No arbitrary command/path/flags.
- [ ] Dispatch new injection/checkpoint/grade modules; canonical snapshot includes sourceFacts. Expose scenario instructions/obligations and CLI route.
- [ ] Baseline and integrated tests, no regression to prior recovery scenarios.
- [ ] Run actual native-host expiry and drift trials on final candidate, preserve failures and exact evidence, clean owned resources.
- [ ] Review, normal gates and push with SSH keepalive, publish/attach stacked PR and update coordination receipt.

## Review focus and stopping point

Check closed authorization, correct time ordering without clock surgery, exact old valid report identity, preservation around intended draft mutation, and no report before fresh observation. Readiness must distinguish fixture tests from actual host tools and owner pilot. Stop at a reviewed stacked experimental PR; owner opt-in implementation and real pilot are subsequent work.
