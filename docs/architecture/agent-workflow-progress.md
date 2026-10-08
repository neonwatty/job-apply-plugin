# Agent workflow implementation ledger

Started 2026-10-07 after owner authorization to begin the [implementation plan](agent-workflow-experiment-plan.md).

Integration branch: `codex/experimental-agent-workflows`, rooted at staging `f95b4947453ad6c6abc9cc0e81c3e443706d4714`. First implementation branch: `codex/agent-workflows-01-contracts`. All development and checks use the experiment worktree and disposable fixtures.

## Slice 1: typed workflow and proposal contracts

Merged in [PR #192](https://github.com/neonwatty/job-apply-plugin/pull/192) to the experimental integration branch at `3753b691`. Reviewed candidate: `def62a74e92f42bbe5d7f5ad9f4affeda6cd3030`.

| File | Implemented responsibility |
| --- | --- |
| `src/harness/contracts.ts` | Typed workflow definition, code-owned context, action/event/route contracts, execution profiles and redacted error codes |
| `src/harness/validation.ts` | Closed records, exact decimal revisions, bounded immutable proposal snapshots, schema-error redaction |
| `src/harness/proposals.ts` | Decode one route or action proposal; reject supplied state, authority, tool IDs, results and extra fields |
| `src/harness/registry.ts` | Exact workflow/version lookup, registered input schemas, enabled/authorized profile intersection, scoped tool lookup, strictest profile limits |
| `src/harness/router.ts` | Validate new/continue/change/cancel/clarify against current task, revision, capability access, safe-handoff flag and user-event schema |
| `src/harness/planner.ts` | Match a proposed action to code-provided allowed actions; check tool scope, child access/depth and terminal-state completion |
| `tests_js/workspace_harness_contracts.test.mjs` | Adversarial protocol and permission tests, stale revisions, route/handoff behavior, child scope, completion and mutation resistance |
| `tests_js/workspace_harness_support.mjs` | Fictional registry and context fixtures; no Store, host browser or model calls |

The six TypeScript modules have generated `runtime/harness/` counterparts. No installed skill or public command imports the new library yet. Tool registrations contain input schemas; execution handlers and mutation-time rechecks belong to slice 3. Operation IDs are validated references in this slice, not implemented deduplication. `maxSteps` and `maxToolCalls` are exposed configuration for the future run loop; child depth is already checked against the parent and child profiles' absolute nesting limits.

The new protocol uses decimal strings for exact revisions. It accepts bounded JSON-shaped proposal data and takes workflow context exclusively from the caller's canonical projection. Registrations and schema parsers are trusted program code. Parsers may decode arguments into internal types, and schema exceptions are replaced by fixed error codes. A successful validation does not grant execution authority, attest user approval, persist a pause, or prove browser state.

Final slice 1 verification: 242 emitted modules, eleven focused contract tests, all eleven commit-hook suites, native Codex review and five independent review roles passed. The explicit exit-after-revocation policy was reviewed again after its regression test. Clean staging baseline and candidate each passed 28 deep suites with the Windows suite skipped; this includes deterministic, installed Codex/Claude package and native platform checks. Both real pre-push hooks passed. Local evidence is in `.workflows/local/agent-workflow-experiment/validation-summary.json` and the referenced logs. No owner-browser or live model UX comparison was performed.

## Slice 2: shared application policy

Implementation is on `codex/agent-workflows-02-application`, based on merged integration `3753b691`. See the [file map and contract](application-policy-slice.md). Existing command services and experimental workflow inspection now share the application guards. Preflight depends on a narrow observation port; claim/session/restart contracts remain canonical. No public prompt or command consumes the experimental context yet.

Published as [PR #193](https://github.com/neonwatty/job-apply-plugin/pull/193), candidate `bbca17d951c05312d1e799ba53c7fd9106e86158`. Seven policy tests and 23 native/session/preflight tests passed, including the exhaustive direct status matrix and 97 Python differential session cases. Both commits passed eleven commit-hook suites. Native and five independent review roles completed; one validated documentation overstatement was corrected and re-reviewed. The deep gate passed 28 suites with Windows skipped, including installed release checks; the real pre-push hook passed its fresh native obligations. Evidence: `.workflows/local/agent-workflow-experiment/slice2-validation-summary.json`. PR #193 remains open at the start of slice 3a.

## Slice 3a: durable preparation and atomic selection

Implementation is on `codex/agent-workflows-03-durable`, stacked on slice 2. See the [durable protocol file map and contract](durable-preparation-slice.md). Optional Store metadata records one active task, scoped pending questions and replay receipts. Existing job selection and its receipt share one atomic `jobs.json` replacement. The experimental CLI requires an explicitly initialized fictional Store. The narrower scope separates single-document durability from the multi-document claim journal work in slice 3b.

Published as [PR #194](https://github.com/neonwatty/job-apply-plugin/pull/194), candidate `6182ae835b9440c97ee335beada271796f3a4bca`. Seventeen focused tests, eleven commit-hook suites, 28 deep suites and fresh native pre-push obligations passed; Windows was skipped. Native review and five independent roles found no actionable issues. Evidence: `.workflows/local/agent-workflow-experiment/slice3-validation-summary.json`. Claim acquisition, progress, recovery and handoff are deliberately unavailable through this gateway until slice 3b integrates the claim journal and broker.

## Slice 3b: durable claim lifecycle

Implementation is on `codex/agent-workflows-04-claims`, stacked on PR #194. See the [claim workflow file map and protocol](durable-claim-slice.md). The existing claim journal now carries workflow receipts through recovery, including session-only progress. An experimental host adapter uses the existing broker transport; private claim tokens remain in broker memory. Cancellation performs a Needs Info handoff before ending the task.

Published as [PR #195](https://github.com/neonwatty/job-apply-plugin/pull/195), candidate `f541095294b4bdffb7027a2abb2dda90908ed5be`. Forty-three new claim tests, eleven commit-hook suites, 28 deep suites and fresh native pre-push obligations passed; Windows was skipped. Native and independent review found two validated issues (nested exact revisions and terminal replay capability retirement); both were fixed and freshly validated. Evidence: `.workflows/local/agent-workflow-experiment/slice4-validation-summary.json`.

## Slice 4a: installed host route and focused prompt reference

Published as [PR #196](https://github.com/neonwatty/job-apply-plugin/pull/196), candidate `4551524d45fbe90ae52dd231cfe739a9b2a43bae`, stacked on PR #195. See the [host command file map and contract](host-workflow-slice.md). The public `workflow` surface composes the existing fixture-only preparation and claim protocols; the existing Job Apply skill gains an explicit experimental route. Code owns state and validates proposals, while host instructions describe invocation, user-event attestation and truthful outcome wording. Five focused checks (including three installed-layout tests), eleven commit-hook suites, 28 deep suites and fresh native pre-push obligations passed; Windows was skipped. Native review and five independent roles completed; a validated test-inventory contradiction was fixed and freshly validated. Evidence: `.workflows/local/agent-workflow-experiment/slice5-validation-summary.json`.

## Slice 4b: paired model preparation trials

Published as [PR #197](https://github.com/neonwatty/job-apply-plugin/pull/197), candidate `2c84277c975681de401cce85d252bb6cefd0e2c2`, stacked on PR #196. The local comparison runner installs pinned baseline and candidate packages into disposable Codex homes, resumes the same host conversation across three turns and records independent Store outcomes. See the [runner and file map](../../evals/preparation/README.md). Product prompts and runtime remain at the tested slice 4a revision. This slice measures exact-job selection and repeated confirmation; the rest of the acceptance matrix remains outstanding.

The [measured report](preparation-model-eval.md) covers three repetitions per arm (18 host turns). Both versions reached Ready without questions and preserved canonical bytes on repeated confirmation. The candidate had higher median latency and consumed its own newly created pending question in all three first turns. This is not a UX-improvement or promotion pass. An earlier batch with incorrect resumed sandbox settings was excluded and rerun; current harness settings are checked from persisted host context. Two validated capture/cleanup defects were fixed with regression tests. Publication gates are recorded in the slice 6 local receipt.

The first deep run passed 27 suites, skipped Windows and failed the historical S05 matrix comparison. The clean base passed the same assertion. Its comparison now validates and removes only the two new evaluation registrations before checking the unchanged historical digest; adversarial tests reject missing, duplicate or altered registrations. The failed receipt is retained separately from the subsequent publication gate.

Final slice 4b publication checks passed 28 deep suites with Windows skipped, plus fresh native pre-push obligations. Native and independent review resolved three validated findings. Evidence: `.workflows/local/agent-workflow-experiment/slice6-validation-summary.json`.

## Slice 4c: direct explicit selection

Published as [PR #198](https://github.com/neonwatty/job-apply-plugin/pull/198), candidate `9f940d64bbd2c9aec657b6933b596b8de0387be4`, stacked on PR #197. See the [file map and protocol](explicit-selection-slice.md). An exact choice can read one compact context and commit selection plus one finished-task receipt. The existing pending route remains for later decisions. Guarded readiness distinguishes current preflight from stored job status. The [repeated comparison](explicit-selection-model-eval.md) selected correctly with one task/receipt per candidate and no repeated-confirmation writes after a code guard fixed the first iteration's redundant-task behavior. Median first-turn latency remained above baseline (31.8 s versus 24.7 s); no speed improvement or staging promotion is claimed. 26 focused checks, 28 deep suites and fresh pre-push native checks passed; Windows was skipped. Native and independent review completed. The first publication attempt exposed a stale worktree base setting; after correcting it, deep and push checks ran together in one QA environment. Evidence: `.workflows/local/agent-workflow-experiment/slice7-validation-summary.json`.

## Slice 4d: continuation and interruption evaluation

Published as [PR #199](https://github.com/neonwatty/job-apply-plugin/pull/199), candidate `1d9b661b4410d29af137b2dcf658235e4ce638ac`, stacked on PR #198. The [scenario runner and file map](../../evals/preparation/continuation-README.md) cover fresh-session preparation, changed facts, unresolved resume choice and cancellation. Each scenario uses independent fictional Stores and before/after observations. Product revisions remain pinned. The [measured report](continuation-model-eval.md) includes 48 comparison turns plus 12 diagnostic cancellation turns. Candidate stale-readiness reporting passed 3/3 versus baseline 0/3, but alternate-resume completion regressed to 1/3 versus baseline 3/3. Fresh continuation and scoped cancellation preserve state; discovery and confirmation wording still need work. The cancellation request was clarified and both arms rerun because the original grader required a preservation condition not explicit in the prompt. Seven focused checks, 28 deep suites and fresh pre-push checks passed; Windows was skipped. Native and independent review resolved a missing baseline import and a shallow-CI historical-object dependency. Evidence: `.workflows/local/agent-workflow-experiment/slice8-validation-summary.json`.

## Slice 4e: preparation discovery and input guidance

Implementation is on `codex/agent-workflows-09-guidance`, stacked on PR #199. See the [file map and contract](preparation-guidance-slice.md). Read-only context now supplies discovery, canonical blockers and exact input references for existing run commands. A shared guard checks both advisory eligibility and actual run creation. Code defines the pending confirmation's Ready effect. The [paired comparison](preparation-guidance-model-eval.md) completed 48 turns at product `614a6484fae72344293ddd5045b69e5d65a19f8c`: all state checks passed; explicit alternate-resume completion improved from the prior candidate's 1/3 to 3/3, fresh-context discovery errors were absent, and changed-facts reporting remained 3/3 versus baseline 0/3. Command effort fell; latency was mixed. Three review findings were fixed with regressions. Final publication gates are recorded locally.

## Next slices

1. Complete publication of preparation guidance with its paired evidence and configured gates; keep ordinary-route replacement pending broader acceptance.
2. Reconcile the stacked experimental PRs and their integration receipts when authorized.
3. Extend model trials to interruptions, stale input, authority changes, task cancellation and browser-mediated recovery.
4. Demonstrate browser mediation where supported, then extend to extraction and campaigns and run cumulative acceptance.

There is no staging promotion, regular-plugin installation, live applicant Store mutation, or measured application UX improvement from these foundation slices alone.
