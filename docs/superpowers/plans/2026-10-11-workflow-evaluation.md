# Repeated Codex Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a balanced fifteen-trial Codex study with complete failure accounting and unscored human-review packets.

**Architecture:** Extend the bounded batch runner additively, orchestrate three sequential batches, and derive reports from persisted receipts. A separate study CLI preserves the existing trial CLI behavior. Transport/fixture internals remain parent-owned.

**Tech Stack:** Node ESM, installed fictional workflow fixtures, recorded transports for tests, restricted Codex for parent-run live evidence.

**Spec:** [Approved design](../specs/2026-10-11-workflow-operator-controls-evaluation-design.md); publication is [P4](2026-10-11-workflow-integration.md).

## Global Constraints

- Preserve at most five sequential trials per batch and twenty turns per trial.
- Run fifteen planned trials, five for each existing scenario; batch offsets 0, 2, 1.
- Every trial uses a fresh installed fixture and the same clean committed revision.
- Never replace a failed attempt with a successful retry in the aggregate.
- Source/test/runtime files stay at or below 500 physical lines.
- Question-quality scores remain null until an actual reviewer supplies them.
- Synthetic decisions and fake-provider tests never count as live model or human evidence.
- No transport, process, model-runner, fixture, shared README, or matrix edits by this worker.

## Review Focus

1. Failure occurs before fixture creation finishes: keep a durable attempted slot (E1).
2. Cleanup fails after successful grading: stop later batches and mark cleanup failure (E1).
3. A failed live conversation has measured latency: include it, label partial observations (E2).
4. A receipt contains traversal paths or a mismatched revision/scenario: reject aggregation (E2).
5. Review packet mapping/digest mismatches: reject annotations and keep human metrics null (E2).

## Allowed files

Modify `evals/workflows/codex-model-trials.mjs` and its existing dedicated test.
Create `codex-model-study.mjs`, `codex-model-study-report.mjs`,
`codex-model-study-cli.mjs` in the same directory; create
`tests_js/workspace_workflow_codex_study{,_report,_cli}.test.mjs`.
Update `docs/architecture/codex-model-evaluation.md`. Existing trial CLI remains unchanged.

## E1: Balanced scheduling and durable attempts

**Interfaces:** Add `scenarioOffset=0` to `runCodexModelTrials`; accept integers
0..2 only. Add `attempts` (planned slots) to its existing summary while preserving
`trials` as existing per-conversation summaries for compatibility.
An attempt has `index`, `scenario`, `status`, `report` (relative or null),
`failure` (code or null), `cleanupConfirmed` (boolean or null).
Statuses: `not_started`, `started`, `passed`, `model_failed`, `setup_failed`,
`cleanup_failed`. Crash-preserved `started` means incomplete, never passed.

`runCodexModelStudy({transport,revision,outputDirectory,maxTurns=12,
fixtureFactory,assertRevision}) -> Promise<StudyManifest>` records all fifteen
slots before inference. `assertRevision(expected:string) -> Promise<void>` is
required and called before/after each batch and around fixture creation.
Manifest fields: `schemaVersion:1`, `revision`, `model`, `evidenceKind`,
`plannedTrials:15`, `maxTurns`, `batches`, `failure`, `complete`.
Each batch binds index, offset, five slot identities, and relative receipt path.
Each planned slot is `{slotId,globalIndex,batchIndex,trialIndex,scenario}`;
indices are one-based and slot IDs are `trial-01` through `trial-15`.
Unstarted slots retain `blockedBy` referencing the study/batch failure that
prevented execution, or null while still scheduled.

- [ ] Write schedule test asserting offsets `[0,2,1]`, scenario totals `[5,5,5]`, and max concurrent fixture count 1. Assert invalid offset and maxTurns 21 reject before setup.

  Assertions: `assert.deepEqual(offsets,[0,2,1]); assert.deepEqual(scenarioCounts,[5,5,5]); assert.equal(maxActiveFixtures,1); assert.equal(uniqueSlotIds.size,15);`.
- [ ] Write failure tests: first model failure retained while later trials run; setup failure recorded before batch stops; cleanup failure preserves fixture and prevents further batches; revision change prevents next fixture. Assert unstarted slots remain visible and aren't counted as attempted.
- [ ] Run existing trials test and new study test; confirm new assertions fail meaningfully.
- [ ] Implement additive attempts saved before setup and after every transition. Preserve initial failure if cleanup also fails in a separate cleanup diagnostic; expose cleanup failure as final status. Ordinary model/scenario failures continue; infrastructure, isolation, revision, or cleanup failure stops the study. Write the planned schedule before any probe/inference.
- [ ] Run both test files; require pass, unchanged existing default three-trial behavior, and no actual inference. Commit: `feat: retain balanced study schedules and all trial attempts`.

## E2: Aggregate evidence and review packets

**Interfaces:** `summarizeCodexStudy({manifest,batches,receipts}) -> StudyReport`
is pure. `writeCodexStudyReport({studyDirectory}) -> Promise<StudyReport>` loads
only validated contained paths and writes `study-report.json`, `study-report.md`,
randomized review packets, and a private packet mapping. Reuse
`blindedReviewPacket`, `transcriptDigest`, and `validateManualReview` from
`model-report.mjs`; do not change those shared interfaces.

Report includes planned/attempted/completed/passed counts, status counts,
per-scenario canonical/scenario/replay success counts with denominators,
proposal/rejection totals, measured latency sample counts/min/median/max,
failed-attempt references, `humanReviewStatus:'pending'`, and
`unnecessaryQuestions:null`. Completed counts only finished model conversations;
setup/cleanup status is separate from conversation completion. Percentages must
name their denominator; empty samples yield null, never zero milliseconds.

- [ ] Write report tests with fifteen slots including success, model failure, setup failure, cleanup failure, and unstarted. Assert denominators and per-scenario counts exactly match fixtures; canonical success alone cannot satisfy replay success.

  For 10 passed, 2 model failures, 1 setup failure, 1 cleanup failure after a finished conversation, and 1 unstarted: `assert.equal(report.planned,15); assert.equal(report.attempted,14); assert.equal(report.completed,13); assert.equal(report.passed,10); assert.equal(report.unnecessaryQuestions,null);`.
- [ ] Add partial live latency and recorded transport tests: measured failed-turn time participates with a partial flag; recorded model metrics stay null; no timings are invented for setup/unstarted slots.
- [ ] Add receipt-identity/path tests and packet tests: reject duplicate slots, mismatched revision/scenario, absolute/traversal/symlink escapes; packet IDs are unique and mapping binds transcript digest. Failed transcripts also receive packets; absent transcripts do not. Invalid manual-review binding rejects.
- [ ] Run new report test and verify failures, then implement validation and aggregation. Only consume existing bounded receipt fields; preserve expected source-conflict rejections as visible counts without treating them as conversation failure. Create report artifacts privately (0600 files, 0700 directories).
- [ ] Run study/report tests; require pass. Commit: `feat: report complete study outcomes and blinded review packets`.

## E3: Explicit study CLI and usage

**Interfaces:** `parseCodexStudyArguments(args) -> {binary,authHome,
outputDirectory,maxTurns}` accepts exactly binary/auth/output and optional
max-turns (default 12, 1..20); study size is fixed at fifteen. No `--trials`,
resume, retry, overwrite, model substitution, or auto-scoring flags.
`runCodexStudyCli(args,dependencies={}) -> Promise<{code:0|1|2,report}>` uses
the existing transport and `cleanCodexRevision` helper. Importing is inert.

- [ ] Write CLI tests: unknown/duplicate/count flags reject; existing evidence directory remains untouched; dirty checkout refuses; changed revision blocks next batch; transport closes exactly once; cleanup failure is nonzero and preserves artifacts.

  Representative assertions: `assert.equal(result.code,1); assert.equal(closeCalls,1); assert.equal(nextBatchFixtureCalls,0); assert.equal(evidencePreserved,true);`.
- [ ] Run new CLI test and confirm failures, then implement CLI. Create new ignored/external output, pin original HEAD, pass revision assertion to E1, run E2 even after a partial failed study where receipts permit. Retain report failure when aggregation or cleanup fails. Exit 0 requires fifteen passed trials and confirmed cleanup; argument error exits 2; all other failures exit 1.
- [ ] Run all three study tests plus existing trial/CLI regression tests and size/matrix checks. Require pass; return any registration need to parent.
- [ ] Document command `node evals/workflows/codex-model-study-cli.mjs --binary /absolute/native/codex --auth-home /existing/auth-home --output .workflows/local/new-study --max-turns 12`, exact evidence limits, partial/failure interpretation, and human review pending state.
- [ ] Commit: `feat: expose bounded repeated Codex study command`. Return revision and tests; parent runs actual model trials once on the integrated clean candidate.
