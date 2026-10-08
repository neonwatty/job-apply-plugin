# Preparation guidance comparison — 2026-10-08

## Result

The new code-provided guidance completed the explicit alternate-resume choice in **3/3** conversations, compared with **1/3** for the prior experimental candidate. Its paired baseline also completed **3/3**. Candidate fresh-session continuation used the saved selection directly, with no command-discovery failures in all three repetitions. Current-readiness reporting after changed facts remained correct in **3/3**, versus baseline **0/3**.

These results support the bounded preparation change. They do not establish a general UX or speed advantage, and do not authorize staging promotion. The plugin still uses model interpretation for intent and question presentation; the shell's user-event attestation is not authenticated human provenance.

## Method and provenance

The unchanged [continuation harness](../../evals/preparation/continuation-README.md) compared baseline `f95b4947453ad6c6abc9cc0e81c3e443706d4714` with candidate `614a6484fae72344293ddd5045b69e5d65a19f8c`. Harness and product were committed and clean at the candidate revision throughout execution. Codex CLI 0.160.0 used `gpt-5.6-luna`, medium reasoning, workspace-write isolation and disabled network. Persisted host context was checked after every turn. Pair order alternated, with three repetitions per arm/scenario: **24 conversations, 48 turns**.

Every conversation used a separate fictional Store, installed package and Codex home. Fresh-context and cancellation turn 2 used new sessions; other scenarios resumed their original sessions. Cancellation used the clarified preservation request from the [previous comparison](continuation-model-eval.md). No trial was excluded or rerun in this batch. Historical candidate results are a separate earlier batch, not an additional concurrent randomized arm.

All full transcripts, stderr and canonical observations were reviewed. The [measurements](preparation-guidance-model-results.json) record revisions, executed harness hashes, package fingerprints, per-run metrics and evidence hashes. All 24 temporary roots were verified absent after cleanup. Four baseline-created `/tmp/ja_*` reference copies were checked against the pinned source and removed separately.

## Outcomes

| Scenario / criterion | Paired baseline | New candidate |
| --- | --- | --- |
| Fresh session: preserve Ready selection without canonical writes | 3/3 | 3/3 |
| Changed facts: preserve blocked state without unauthorized repair | 3/3 | 3/3 |
| Changed facts: truthfully report current readiness is false | 0/3 | 3/3 |
| Unresolved resume: wait for explicit choice | 3/3 | 3/3 |
| Explicit alternate-resume choice: reach Ready with chosen inputs | 3/3 | 3/3 |
| Cancellation: preserve job, facts and active run | 3/3 | 3/3 |
| Cancellation: cancel the same persisted pending task | No workflow record | 3/3 |
| Cancellation: explicitly explain confirmation marks Ready | 1/3; other two omit effect | 3/3 |

No claims or application sessions were created. The fresh-context and changed-facts scenarios asked no questions. Resume-choice and cancellation scenarios asked one necessary question in turn 1 and none in turn 2. State success and accurate explanation are distinct criteria.

## Command effort and latency

Shell calls include reference reads, help and failed calls; a compound call may contain multiple commands. Durations include model and tool time, exclude installation/fixture setup, and reflect uncontrolled service/host load.

| Scenario | Baseline shell calls | Candidate shell calls | Baseline median duration | Candidate median duration |
| --- | --- | --- | --- | --- |
| Fresh context | 8, 9, 8 | 6, 5, 5 | 42.9 s | 33.7 s |
| Changed facts | 7, 6, 8 | 5, 5, 5 | 26.4 s | 32.9 s |
| Unresolved resume | 16, 15, 12 | 8, 7, 7 | 54.3 s | 39.2 s |
| Cancellation | 9, 15, 31 | 11, 9, 9 | 47.3 s | 45.9 s |

Candidate median command counts are lower in each scenario; candidate median latency is lower in three of four. The sample is small, and changed-facts candidate responses were slower despite being more accurate. No general speed claim follows.

## What changed in the traces

### Discovery and fresh context

Every candidate continuation used one unscoped public context call to recover the exact selected job, guarded `ready:true` and `report_ready`. No candidate discovery errors, help probing or implementation inspection occurred. Baseline repetition 2 failed a top-level help call before recovering; repetition 3 had a process-creation failure before successful selection. Some baseline runs redundantly initialized the fixture.

### Changed facts

The intervention appended a draft at fact revision 3, invalidating the run's confirmed revision 2 while stored job status remained Ready. Both arms preserved every Store hash in turn 2. All baseline finals incorrectly treated stored status and old run references as current readiness. Candidates distinguished that status from current guarded readiness and named the unconfirmed-facts blocker. Each candidate follow-up used one context call; none confirmed or repaired the facts. Baseline repetition 3 recovered from two incorrect-path invocation failures.

### Unresolved resume

All candidates consumed code-returned resume revision **1** and confirmed fact revision **2**, started the explicitly authorized run, refreshed context, and selected using its current revision/scope. They did not guess revisions, fabricate a reply or inspect implementation source. The earlier candidate's missing-run failures were absent in these three repetitions.

Baseline repetition 3 recovered from unsupported `resume-facts-list --resume-id` syntax. Baseline repetition 2 encountered a rejected `rm -f` proposal cleanup: stderr records the host policy requiring a safer approach. This rejection is absent from completed JSONL command items; a later file-change item removed the proposal. Baseline repetition 1 copied four references into fixed `/tmp` files, which were separately verified and removed. Candidate repetition 1 omitted `--native-lock` on ordinary run-start; the public command succeeded through its default artifact resolution, while workflow calls used the supplied artifact.

### Cancellation

All three candidates accurately asked whether to save the selection as Ready, waited for the later real cancellation request, then cancelled the same persisted task in a new session. The task advanced from waiting revision 2 to cancelled revision 3; pending and active-task pointers cleared. Only workflow metadata changed. Final cancellation and preservation claims were supported. This correct Ready-effect wording contrasts with one incorrect candidate explanation in the previous batch.

Candidate repetition 1 recovered from a wrong reference path before cancellation. Baseline repetition 2 failed two discovery calls and incorrectly used an empty answer-cleanup preview to infer there was no pending preparation; the endpoint does not establish that. Its eventual conversational stop and preservation were correct. Baseline repetition 3 made 31 shell calls, expanding into answer/extraction/authority help and installed Companion source search; it made no authority changes. Its final proposal link named an incorrect nonexistent path, while the actual file addition stayed inside the fixture. Baseline repetition 1 explained the Ready effect; repetitions 2/3 did not explain that effect, without making a false future-effect promise.

No candidate fabricated a confirmation or decline reply. No observed direct Store access, browser/account actions, filling or submission occurred. Proposal files remaining inside fixtures were removed with those fixture roots.

## Product verification and remaining limits

The [implementation file map](preparation-guidance-slice.md) separates advisory guidance, shared canonical run-input guards, existing mutation services and prompt instructions. Seven guidance regressions cover exact inputs, read-only behavior, drift, ambiguous discovery, revoked access, cross-job pending scope, stale pending confirmation and unreadable default/alternate resumes. Installed-command tests execute the advertised descriptor and compare code-defined confirmation outcomes with actual receipts.

Independent and native review found three concrete problems: cross-job confirmation leakage, incorrect file-error classification and loss of alternate guidance when the default file was unreadable. Each was fixed, regression-tested and freshly validated. Final product review found no further actionable defects. Sandbox-limited review test failures are retained separately from the configured publication gates; final gate receipts are recorded locally.

The runner installs archives that include implementation and evaluation files, so the experiment is not blind to them even though no candidate implementation reads were observed. Model-generated shell attestation and model-rendered wording remain limitations. These trials do not cover live browser recovery, filling, sensitive-answer consent, expired claims, extraction review or campaigns. Keep the stacked branches experimental and expand acceptance before considering ordinary-route replacement.

Raw evidence: `.workflows/local/continuation-eval-1791487130935/`. Extra cleanup receipt: `.workflows/local/agent-workflow-experiment/slice9-extra-cleanup.json`.
