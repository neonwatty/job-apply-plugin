# Slice 22 Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate operator decisions, richer controlled browser writes, and fifteen repeated Codex trials in an experimental PR stacked on #212.

**Architecture:** The parent supplies shared lifecycle and cancellation seams, then three workers implement separate subsystems in isolated worktrees. Parent integrates their commits and runs combined installed acceptance. Existing durable schemas and the five model operations stay stable.

**Tech Stack:** TypeScript, checked-in ESM runtime, Node test runner, pinned Playwright/Chromium, native Store locking, installed Codex 0.160.0 with gpt-6.1-sol.

**Spec:** [Approved design](../specs/2026-10-11-workflow-operator-controls-evaluation-design.md).

## Global Constraints

- Base PR #212: `42759e072f850a2512db322d308d278f7696bc3f`; integration branch `codex/agent-workflows-22-operator-controls-evaluation`.
- All executions use fictional Stores and controlled browsers. Final submission remains manual.
- No staging promotion, existing PR merge, production install, owner browser/Store, or live ATS.
- Source/test/runtime files stay at or below 500 physical lines. No new size exceptions.
- Preserve at most five sequential trials per batch and twenty turns per trial.
- Run fifteen planned trials, five per existing scenario; batch offsets are 0, 2, 1.
- Keep the five model operations and closed proposal schema unchanged.
- Dedicated descriptors do not prove OS confinement or human authentication. Automated operator input is simulated evidence.
- Workers own only declared files; they are not alone and must not revert others' edits.
- Existing commit/push hooks, independent branch review, and installed-package gates are mandatory.

## Review Focus

1. Abort arrives after a proposal completes but before dispatch: execute nothing further (P1).
2. Operator child times out during canonical re-review: late completion cannot issue usable authority (P2).
3. Cleanup fails after a browser effect: retain evidence and uncertainty; never claim rollback (P3).
4. Worker runtime output drifts from TypeScript: reject the candidate before packaging (P3).
5. HEAD changes between live batches: prevent subsequent fixture creation and preserve earlier results (P4 and evaluation E1).

## File ownership and execution graph

| Package | Plan | Files and dependencies |
| --- | --- | --- |
| Parent | This document | Lifecycle, host IPC/terminal cancellation, transport cancellation, integration tests, registration and publication |
| Operator | [Operator plan](2026-10-11-workflow-operator.md) | New operator modules/tests/docs; consumes P1/P2 |
| Browser | [Browser plan](2026-10-11-workflow-browser-controls.md) | Local adapter/page types, fixture driver/tests/docs; independent of P1/P2 |
| Evaluation | [Evaluation plan](2026-10-11-workflow-evaluation.md) | Trial scheduling/accounting, study/report/CLI and tests/docs; consumes existing fixture API preserved by P2 |

Start browser and evaluation workers while parent implements P1/P2. Dispatch
operator implementation after the P1/P2 contract commit; then all three lanes
can run concurrently. No two owners edit the same file. Integrate each lane only
after its focused checks and independent review. Parent runs broad gates and
live trials serially, after all lanes are integrated.

Use native managed-worktree tools from the exact contract revision. Preserve the
existing integration worktree and reuse its configured dependencies/hooks. Each
worker gets the approved spec, this plan, its lane plan, an exact base commit,
and `allowed_files`. Worker receipts contain revision, changed files, commands,
test results, and remaining limitations. No worker pushes or creates a PR.

## P1: Cancellation through model execution

**Files:** modify `evals/workflows/codex-model-process.mjs`, `codex-model-transport.mjs`, `model-runner.mjs`; create `tests_js/workspace_workflow_model_cancellation.test.mjs`.

**Interfaces:** Add optional `signal: AbortSignal` to `boundedCodexProcess` options, `transport.next({messages, signal})`, and `runModelEvaluation({...existing, signal})`. Existing callers and result fields remain valid. Cancellation failure code is `codex_process_cancelled`; unconfirmed cleanup retains precedence. `transport.close()` still requires no active invocation; callers abort and await it first.

- [ ] Write failing tests `pre-aborted process never spawns`, `abort reaps resistant descendants`, `abort after proposal before dispatch prevents mutation`, and `cancelled turn keeps raw trace`. Assert spawn/write counts 0 where applicable; `cleanupConfirmed === true` only after group disappearance; cancellation never marks a run complete.

  Representative assertions: `assert.equal(spawnCount,0); assert.equal(dispatchCount,0); assert.equal(result.failure,'codex_process_cancelled'); assert.equal(receipt.summary.complete,false);`.
- [ ] Run `node --test tests_js/workspace_workflow_model_cancellation.test.mjs`; require failures at the missing cancellation behavior, not fixture setup.
- [ ] Implement optional cancellation in the three named modules. Register/remove listeners on every exit path, handle abort racing process spawn/close, retain bounded output, and check the signal immediately before each controller dispatch. Preserve uncertain results from already-dispatched effects.
- [ ] Run the new file plus `tests_js/workspace_workflow_codex_model.test.mjs` and `tests_js/workspace_workflow_model_eval.test.mjs`; require zero failures. POSIX process assertions explicitly skip unsupported Windows evidence.
- [ ] Commit only these files through ordinary hooks: `feat: cancel restricted model execution with confirmed cleanup`.

## P2: Unacquired fixture and private operator channel

**Files:** create `evals/workflows/model-fixture-lifecycle.mjs`; modify `model-fixture.mjs`, `src/integrations/host/terminal-approval.ts` and matching runtime, `tests_js/workspace_installed_workflows_browser_support.mjs`, `workspace_installed_workflows_browser_host.mjs`; create `tests_js/workspace_workflow_operator_lifecycle.test.mjs`.

**Interfaces:**

- `createInstalledModelFixtureLifecycle({operatorFds} = {}) -> Promise<Lifecycle>` prepares a fresh installed fictional campaign, without acquiring its claim. `operatorFds` is absent or `{inputFd:number, outputFd:number}`; both must be actual dedicated TTY descriptors in terminal mode.
- `Lifecycle.acquireEvent` is an immutable exact event. `Lifecycle.reviewAcquisition({signal, lifetimeMs=60000}) -> Promise<Decision>` privately presents it; `Decision` is `{outcome:'approved'|'denied'|'expired'|'cancelled'|'invalid'|'unavailable'}` with no grant/challenge IDs.
- `Lifecycle.acquireApproved() -> Promise<ModelFixture>` executes the snapshotted event only after successful review, derives binding/prompt from its canonical receipt, and revokes the private setup grant in `finally`. The returned ModelFixture has the existing `model/prompt/readCanonical/gradeCanonical/cleanup` interface. Repeated calls reject.
- `Lifecycle.acquireSimulated() -> Promise<ModelFixture>` is the explicit private compatibility path for existing unattended trials; never expose it to model operations or the operator CLI.
- `Lifecycle.close({preserve=false}={}) -> Promise<void>` idempotently closes operator authority before host teardown. Preserve the Store on uncertainty or unconfirmed shutdown. `ModelFixture.cleanup()` delegates to this lifecycle with automatic uncertainty detection.
- Extend `installedBrowserHost(state, grant, {operatorFds}={})`. Add `reviewOperator(event,{signal,lifetimeMs=60000})`, `closeOperator()`, and existing `trusted/stop`; private challenge IDs remain inside the lifecycle/host boundary.
- Extend terminal `review(raw,lifetimeMilliseconds=60000,{signal}={})`. Preserve existing return contracts for existing callers; map stopped outcomes in the new host/lifecycle layer.

- [ ] Write failing tests asserting no active claim before acquisition; denied/expired/cancelled review causes zero event dispatch; changed canonical revision rejects acquisition; grant revocation happens after both successful and failed dispatch; original auto-acquired fixture still passes its existing oracle.

  Representative assertions: `assert.equal(before.claimActive,false); assert.equal(dispatchCount,0); await assert.rejects(lifecycle.acquireApproved()); assert.equal(outstandingGrants,0);`.
- [ ] Add a deferred canonical-review test: cancel while review is pending, resolve it late, then assert no usable grant and no subsequent acquisition. Add child-close and repeated-close cases.
- [ ] Run `node --test tests_js/workspace_workflow_operator_lifecycle.test.mjs`; verify meaningful failures.
- [ ] Extract lifecycle without changing default fixture behavior: `createInstalledModelFixture()` uses `acquireSimulated()`. Keep synchronous session/terminal methods in host child, fd3 private IPC and dedicated fd4/5 operator streams. Do not let terminal mode accept synthetic approve IPC commands.
- [ ] Implement review timeout as validated lifetime (1..300000 ms) plus 5000 ms cleanup allowance. On timeout/cancel, close the review session and await acknowledgement; if acknowledgement fails, stop the host and preserve the fixture. Late replies cannot restore authority. `stop()` closes operator state before terminating the host, never after `host.run()` clears its private facade.
- [ ] Build runtime, then run the lifecycle tests, `workspace_host_approval_session.test.mjs`, `workspace_workflow_model_installed.test.mjs`, and `workspace_installed_workflows_browser.test.mjs`. Require zero failures and unchanged default fixture grades.
- [ ] Commit through hooks: `feat: expose unacquired fixture and private terminal decisions`. Publish the exact contract revision to workers, not GitHub.

## P3: Combined installed acceptance

**Files:** create `tests_js/workspace_workflow_operator_controls.test.mjs`, `tests_js/workspace_workflow_operator_controls_support.mjs`; modify parent-owned `tests_js/workspace_browser_process_child_support.mjs`, `workspace_browser_process_support.mjs`; create `tests_js/workspace_browser_controls_process_recovery.test.mjs`. Parent may update `config/test-matrix.json` only if existing ownership patterns cannot cover new files. Do not edit historical ownership rows unnecessarily.

**Interfaces:** Consume browser B1 `LocalFixtureTarget`, operator O1 runner, and P2 lifecycle. Add a separate installed Chromium fixture in the new support module; retain the existing synthetic upload fixture and its oracle. Parameterize existing process harness by private control mapping/target, preserving its old defaults.

- [ ] Write failing combined tests: simulated terminal approval acquires exact claim then performs one checkbox/select write; revoking current recovery authority prevents reconciliation; abort after an effect preserves uncertain original intent; restarted host with fresh authority reconciles without another write. Assert unrelated drafts and final-action state are unchanged.

  Representative assertions: `assert.equal(operation.state,'uncertain'); assert.equal(after.stats.writes,1); assert.equal(after.observation.finalAction,'untouched'); assert.deepEqual(after.unrelatedDrafts,before.unrelatedDrafts);`.
- [ ] Add SIGKILL before/after mutation for both select and checkbox; assert original request fingerprint equality, writes at most one, and repeated reconciliation adds zero writes. Include checkbox false.
- [ ] Run the two new test files and verify the missing composition fails before implementing the support seam.
- [ ] Implement installed fixture composition using copied runtime modules and controlled loopback Chromium. Reuse production durability and private approval paths; do not introduce synthetic shortcuts in assertions about real DOM writes.
- [ ] Run new integration/process tests plus the original browser process-recovery file. Run `npm run typecheck`, `npm run build:check`, `npm run check:size`, and `npm run check:test-matrix`; require all pass.
- [ ] Commit: `test: verify operator controls and process recovery in installed fixtures`.

## P4: Evidence, review, and experimental publication

**Files:** update `evals/workflows/README.md`, `docs/architecture/agent-workflow-progress.md`; write ignored receipts under `.workflows/local/agent-workflow-experiment/`.

- [ ] Confirm all lane receipts and exact integrated revision. Run the repository review toolkit as a branch review against `origin/codex/agent-workflows-21-process-approval-model`; independently validate findings, fix accepted defects, and rerun affected checks/review as required.
- [ ] Record affected selection against both `origin/staging` and the intended base using `npm run test:affected -- --base <ref>` under the evidence-bound QA environment. Use successful unchanged suite receipts where the existing runner permits; do not bypass hooks or forge receipts.
- [ ] Run the ordinary deep gate, including installed release/package checks, under `qaHostEnvironment()` from `tools/run-qa-browser.mjs`. Confirm the release-package result passes; if not covered by the gate, run `npm run test:release` in the same environment. Preserve any red run and investigate candidate versus clean base.
- [ ] On a clean committed candidate, run the E3 study CLI once with a new ignored output directory, the inspected native Codex binary, and existing auth home. It executes fifteen planned runs serially. Never read/copy credentials. Verify original HEAD before/after every fixture and batch.
- [ ] Summarize all fifteen planned slots and failures. A failed ordinary model conversation remains evidence; fix an implementation defect if established, then run a separately identified study after relevant behavior changes. Do not replace failed runs or imply human UX scores exist. Report incomplete study/cleanup as a blocker to claiming the study complete.
- [ ] Update progress documentation with observed evidence and limitations, commit through hooks, and bind model evidence to its actual execution commit. Documentation-only changes may retain earlier model evidence with both revisions stated; behavior changes require new affected evidence.
- [ ] Once required deterministic/release/review gates pass, push normally and create one experimental PR with `gh pr create --base codex/agent-workflows-21-process-approval-model --head codex/agent-workflows-22-operator-controls-evaluation --body-file <receipt-body>`. Attach its URL to this chat using the app artifact tool. No merge or staging promotion.

## Plan handoff

Execution method is already selected: three parallel agents with parent-owned
shared contracts, integration, and testing. User review of this written plan is
the next checkpoint required by the writing-plans skill. Implementation and live
trials have not begun. The original design approval is recorded separately.
