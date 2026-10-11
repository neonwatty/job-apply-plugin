# Session recovery and readiness implementation plan

> **For agentic workers:** Use isolated context and disjoint ownership; parent owns integration, real host trials, and publication.

**Goal:** Verify fresh-agent continuation and interruption recovery using Codex's existing browser tools, and map remaining staging blockers.

**Architecture:** Extend PR #213's installed fictional acceptance fixture. Canonical workflow state stays in the existing Store/broker. Evidence indices validate recorded outcomes without promoting agent-attested browser observations to trusted proof.

**Base:** PR #213, `fd5b18146ccf2a08a52ec7c346ba4e5654e0ca22`.

**Design authorization:** User approved the three proposed workstreams and parent integration/testing. This is bounded acceptance work over existing interfaces; any production schema change requires a concrete demonstrated gap and an updated design.

## Constraints and shared contracts

- Codex host browser tools only for actual UI trials. HTTP event simulation tests the fixture only.
- Fictional loopback data and task-owned tabs/processes. Manual final submission.
- Closed fixture-owned broker restart injection accepts no arbitrary PID. Preserve failure evidence.
- Read canonical context and observe current DOM after interruption before new report/action.
- Tab closure may destroy an unsaved draft. Reconstruct from fresh observation; do not claim persisted browser state.
- Exact candidate revision and externally retained host/session traces bind acceptance receipts.
- Fresh-agent trials use no inherited conversation. Harness labels alone cannot establish independence or actual host execution.
- Human UX ratings remain null absent human review. Code may measure repeated events, not infer question quality.
- No staging merge or promotion in this slice.

## Parallel ownership

### A: Fresh-session evidence

Files: `evals/workflows/host-browser-session-evidence.mjs`, `tests_js/workspace_host_browser_session_evidence.test.mjs`, `docs/architecture/host-browser-fresh-sessions.md`.

- [ ] Write failing validator tests for missing traces, reused sessions, wrong candidate, unordered context/observation, failing fixture evidence.
- [ ] Implement `gradeFreshSessionEvidence({candidateRevision, trials})` over independently graded snapshots and indexed actual receipts.
- [ ] Report passing focused tests. Preserve external trace review as a separate requirement.

### B: Interruption recovery

Files: existing `host-browser-fixture.mjs`, `host-browser-cli.mjs`, `host-browser-page.mjs`; new `host-browser-recovery.mjs`, `workspace_host_browser_recovery.test.mjs`, `docs/architecture/host-browser-recovery.md`.

- [ ] Write failing tests for real broker restart, malformed fault injection, missing observation, failed recovery, and replacement-child cleanup.
- [ ] Add authenticated restart and separately labeled tab/tool loss checkpoints; expose fresh installed context without implicit reacquisition.
- [ ] Grade actual broker receipts and ordered context/observation. Keep fixture gating distinct from production enforcement.
- [ ] Test observer correctness when a closed tab reloads initial field values.

### C: Cumulative readiness audit

File: `docs/architecture/agent-workflow-readiness.md`.

- [ ] Map original design against exact file responsibilities and code/prompt ownership.
- [ ] Separate inspected tests, reported host trials, and unverified UX/platform behavior.
- [ ] Produce a finite staging-readiness checklist and remaining blockers.

## Parent integration and testing

- [ ] Run existing harness baseline before integration and retain results.
- [ ] Review interfaces and run focused integrated tests, matrix, types, size, and runtime consistency.
- [ ] Commit a clean exact candidate with ordinary hooks.
- [ ] Run fresh no-history host agents serially on independent fixtures; retain host traces and grade results, including failures.
- [ ] Run task-owned tab closure/reconnection and real broker restart acceptance; never restart the owner's browser/app.
- [ ] Perform repository-required independent branch review and resolve validated findings.
- [ ] Run required affected/release/deep gates and push within one QA environment lifetime to preserve receipt identity.
- [ ] Publish a stacked PR, attach it, and record exact evidence and remaining limitations.
