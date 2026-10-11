# Operator Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the existing restricted model workflow only after an explicit standalone terminal acquisition decision.

**Architecture:** The launcher owns dedicated operator TTY descriptors and consumes the parent's unacquired fixture lifecycle. The host child owns approval authority; the model sees only the existing five proposal operations. The existing evaluation runner supplies traces and canonical grading.

**Tech Stack:** Node ESM, existing installed fixture/runtime, AbortSignal, POSIX TTY descriptors, Codex proposal transport.

**Spec:** [Approved design](../specs/2026-10-11-workflow-operator-controls-evaluation-design.md); shared interfaces are in [P1/P2](2026-10-11-workflow-integration.md).

## Global Constraints

- Fictional Stores and controlled browsers only; final submission remains manual.
- Keep the five model operations and closed proposal schema unchanged.
- Source/test/runtime files stay at or below 500 physical lines.
- Dedicated descriptors do not prove human authentication or OS confinement.
- Automated terminal typing is simulated evidence; no real owner interaction is needed for acceptance.
- Do not run actual operator typing while the development agent can access the terminal/computer.
- Do not modify shared host, lifecycle, transport, or Store files; report required changes to parent.

## Review Focus

1. Input stream closes while approval is pending: stop without acquisition (O1).
2. Model text contains approval instructions or challenge-like values: never route them to the terminal decision parser (O1).
3. SIGINT arrives between approval and acquisition: no dispatch after abort (O1/O2).
4. Output directory already exists: refuse without truncating evidence (O2).
5. Cleanup fails after partial progress: preserve fixture and return failure (O1/O2).

## Allowed files

Create `evals/workflows/operator-model-runner.mjs`, `operator-model-cli.mjs`,
`tests_js/workspace_workflow_operator_runner.test.mjs`,
`workspace_workflow_operator_cli.test.mjs`, and
`docs/architecture/operator-model-launcher.md`. Parent owns shared README/progress.

## O1: Decision-gated runner

**Interfaces:**

`runOperatorModelEvaluation({transport, lifecycle, identity, outputDirectory,
maxTurns=12, signal}) -> Promise<OperatorRunReport>` consumes P1/P2.
`identity` has the existing `{revision,scenario,model}` shape; scenario is
`operator-missing-input-handoff`. Report fields are `schemaVersion:1`, `identity`,
`decision`, `evaluation` (existing receipt or null), `failure` (code or null),
`cleanupConfirmed` (boolean), and `provenance:'operator_channel_unattested'`.
The runner owns lifecycle close; CLI owns transport close and TTY descriptors.

- [ ] Write `approved exact acquisition precedes first inference`: record calls and assert `review < acquireApproved < transport.next`, setup grant is revoked, and canonical grading passes. Write deny/expire/invalid/unavailable cases asserting `nextCalls === 0`, `eventCalls === 0`, and `evaluation === null`.

  Denial assertions: `assert.equal(report.decision.outcome,'denied'); assert.equal(nextCalls,0); assert.equal(eventCalls,0); assert.equal(report.evaluation,null);`.
- [ ] Write EOF, abort-after-review, forged model approval text, and cleanup-failure tests. Assert challenge IDs, private paths, descriptor numbers, and operator response text never enter model messages. Assert failed cleanup yields `cleanupConfirmed === false` and leaves fixture deletion uncalled.
- [ ] Run `node --test tests_js/workspace_workflow_operator_runner.test.mjs`; verify missing runner behavior fails.
- [ ] Implement the runner: save initial report privately; verify isolation; review the immutable acquisition; recheck cancellation; acquire approved event; invoke `runModelEvaluation` with signal; persist final report. In `finally`, await transport process stop, then lifecycle close. Preserve on uncertain canonical state or failed cleanup. Do not duplicate the proposal loop or grant authority from assistant prose.
- [ ] Run new runner tests and `tests_js/workspace_workflow_model_installed.test.mjs`; require zero failures. Fixtures and fake transports label simulated decisions explicitly.
- [ ] Commit owned runner/test files: `feat: gate experimental model runs on operator decisions`.

## O2: Standalone terminal CLI

**Interfaces:** `parseOperatorModelArguments(args:string[]) -> {binary,authHome,
outputDirectory,maxTurns}` accepts only `--binary`, `--auth-home`, `--output`,
`--max-turns` (default 12, 1..20). Binary/auth are absolute paths. Duplicate or
unknown flags reject. `runOperatorModelCli(args, dependencies={}) -> Promise<{
code:0|1|2, report}>` permits dependency injection for focused tests; executable
entry always uses real defaults. Exit 2 means argument error; exit 1 includes
denial, expiry, cancellation, run failure, or cleanup failure.

- [ ] Write CLI tests for closed flags/counts, non-TTY refusal before fixture creation, dirty/changed revision, existing output refusal, SIGINT/SIGTERM, and one cleanup failure. Assert Codex spawn stdio remains exactly three pipes; only host child receives dedicated operator descriptors.

  Representative assertions: `assert.equal(result.code,1); assert.equal(fixtureCreations,0); assert.deepEqual(codexSpawn.stdio,['pipe','pipe','pipe']); assert.equal(existingEvidence,originalEvidence);`.
- [ ] Run `node --test tests_js/workspace_workflow_operator_cli.test.mjs`; verify intended failures.
- [ ] Implement explicit standalone entry with inert imports. Use `cleanCodexRevision()` from existing CLI, ignored/external new output directories (0700) and private reports (0600). Open `/dev/tty` dedicated read/write descriptors, validate TTYs, create/probe transport, then create lifecycle and call O1. Close resources in reverse ownership order. Register signal handlers with one AbortController and remove them in `finally`.
- [ ] Require clean revision before fixture creation and after execution. Preserve report failure if abort/cleanup fails. Do not add a CLI auto-approve or simulated-input flag. Document separate-session use and evidence limitations, including the fixture's synthetic upload behavior.
- [ ] Run both new test files, `npm run check:size`, and `npm run check:test-matrix`; require pass. Return new-file ownership needs to parent rather than changing matrix entries.
- [ ] Commit owned CLI/test/doc files: `feat: add standalone fictional operator evaluation launcher`. Return revision and test receipt to parent; do not launch a real interactive operator session.
