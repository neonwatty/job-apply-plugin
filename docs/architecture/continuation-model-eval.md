# Preparation continuation comparison — 2026-10-08

## Result

The experimental route improved one measured behavior: after facts changed, it reported current readiness correctly in **3/3** conversations; ordinary intake incorrectly reported Ready in **3/3**. Code-computed preflight gave the model evidence that stored job status alone could not supply.

The candidate also exposed regressions. It completed an explicitly chosen alternate resume in **1/3** conversations versus baseline **3/3**. All three candidate fresh-session continuations encountered command-discovery failures before recovering. One cancellation confirmation described its effect incorrectly even though the eventual cancellation preserved state.

Keep this route experimental. These results support moving authoritative state and permitted transitions into code, but do **not** establish an overall UX improvement or justify replacing ordinary intake.

## Method and provenance

The [continuation runner](../../evals/preparation/continuation-README.md) installed baseline `f95b4947453ad6c6abc9cc0e81c3e443706d4714` and candidate `9f940d64bbd2c9aec657b6933b596b8de0387be4`. Codex CLI 0.160.0 used `gpt-5.6-luna`, medium reasoning, verified workspace-write isolation with network disabled, and three repetitions per arm/scenario. Pair order alternated. Each conversation used its own fictional Store, installation and Codex home.

The initial batch executed 24 conversations/48 turns using harness `a49385f016422bbb519ea84a14cce54027dc7276`. Its cancellation request preserved job/resume/facts but did not explicitly preserve the application run; its grader required run preservation. Baseline completed the run in all three initial cancellations. This is **not established as a user-instruction violation**. All six initial cancellation conversations are retained as diagnostic evidence and excluded from the main table.

The cancellation request was clarified to preserve the existing run, status and selected inputs. Both arms were rerun: six conversations/12 turns using the later committed harness recorded in the [measurements](continuation-model-results.json). Product revisions and the other three scenario requests/grades did not change. The main comparison therefore includes 24 conversations/48 turns drawn from two batches; 60 turns were executed in total.

Every full transcript was reviewed, including unsuccessful commands, suppressed subcommand errors, reference reads and non-shell items. Observations independently recorded canonical hashes, preflight, active runs, facts, tasks, claims and sessions. All 30 temporary installations/Stores were removed. The measurements retain exact harness commits/source hashes, report hashes and per-file evidence-manifest hashes.

## Outcomes

| Scenario / criterion | Baseline | Candidate |
| --- | --- | --- |
| Fresh session: recover Ready selection without canonical writes | 3/3 | 3/3 |
| Changed facts: preserve blocked state without unauthorized repair | 3/3 | 3/3 |
| Changed facts: truthfully report current readiness is false | 0/3 | 3/3 |
| Unresolved resume: wait for the user's choice | 3/3 | 3/3 |
| Explicit alternate-resume choice: reach Ready with that resume | 3/3 | 1/3 |
| Clarified cancellation: preserve job, facts and active run | 3/3 | 3/3 |
| Clarified cancellation: cancel the same persisted pending task | No workflow record | 3/3 |

All fresh-context and stale-facts turns asked zero questions. Each unresolved-resume and cancellation conversation asked one necessary question in turn 1 and none in turn 2. No actual pending reply was fabricated or executed. No observed claim/session creation, browser/network action, account check, direct Store-file access, filling or final submission occurred in the included conversations. This is observed trace behavior, not proof of arbitrary-host isolation.

Cancellation state success does not imply the proposed confirmation was explained correctly: candidate repetition 2 said the job would remain not Ready after saving the selection. Confirmation would mark it Ready. The cancellation itself was accurate and preserved the existing run. Baseline repetition 1's final question also used unclear “will not mark it Ready” wording after earlier correctly explaining the transition. Keep these wording limitations visible beside the state scores.

## Command effort and latency

Counts are shell calls, including reads, help and unsuccessful calls. A compound shell call may contain several commands. Private proposal-file tool items are retained separately in traces. Latencies include model reasoning and tools, exclude package/fixture setup, and are descriptive with uncontrolled service/host load.

| Scenario | Baseline shell calls per conversation | Candidate shell calls per conversation | Baseline median duration | Candidate median duration |
| --- | --- | --- | --- | --- |
| Fresh context | 10, 9, 9 | 10, 12, 17 | 44.4 s | 64.3 s |
| Stale facts | 7, 12, 10 | 5, 5, 5 | 60.2 s | 36.5 s |
| Unresolved resume | 10, 16, 20 | 32, 19, 14 | 61.6 s | 97.3 s |
| Clarified cancellation | 10, 9, 8 | 8, 9, 9 | 42.3 s | 54.7 s |

The faster stale-facts responses accompany more accurate reporting in this small sample. Candidate durations are higher in the other scenarios, including two unsuccessful resume-choice conversations. These measurements do not establish a general speed advantage.

## What the traces explain

### Fresh context

Both versions recovered the selected job and preserved every recorded canonical hash. Every candidate first queried an unscoped preparation context that returned no active task, then explored help or other public commands before locating the saved job. Exact-job context eventually supplied valid readiness. Repetition 2 unnecessarily used `--include-trashed`; repetition 3 tried the literal example ID `fixture-job` before discovering the real ID. Several malformed plugin/native-lock paths also required retries.

### Changed facts

The harness appended a draft at fact revision 3 between turns, invalidating the run's confirmed revision 2. Jobs retained stored Ready status. All baseline replies treated status/run references as evidence of current readiness despite the failed independent preflight. Candidate replies explicitly distinguished stored Ready from guarded readiness `false`. Neither arm approved the draft or changed state to manufacture success.

Baseline repetition 2 attempted two public calls with an incorrectly shortened Store path outside the supplied fixture. Both failed activation; no successful outside-Store access or mutation was observed. Candidate repetition 2 suppressed an incorrect reference-read failure, then actually read the correct reference. Failed shell-exit counts alone miss such subcommand errors.

### Unresolved resume

Both versions waited with two confirmed resumes and no active run. Baseline then consistently read canonical resume revision 1/fact revision 2, started the authorized run and selected the job.

Candidate repetition 1 explored source, tests and evaluation fixtures, eventually attempted run start with **guessed fact revision 1**, and was rejected. It then falsely diagnosed unavailable/stale facts; the facts were current and confirmed at revision 2. Candidate repetition 3 stayed in preparation/schema discovery and never started a run. Its blocked-state report was accurate, but it left authorized work incomplete. Candidate repetition 2 recovered by reading canonical inputs, starting the run, refreshing preparation context and selecting successfully.

The guard prevented invalid state. The code-provided context did not reliably guide the model from missing-run state to the existing intake operation. Installed source/evaluation exposure in these trials is a limitation: the comparison is not blind to implementation or fixture definitions.

### Cancellation

With explicit preservation scope, baseline stopped without canonical writes. The candidate recovered the same waiting task in a genuinely new session, cancelled it, cleared its pending request and preserved the active run. Its durable cancellation changes workflow metadata in `jobs.json`; the saved job and unrelated canonical files remain unchanged. Final cancellation outcomes were truthful in all six rerun conversations. Candidate repetition 2 also recorded two rejected proposal-patch attempts (invalid syntax, then outside-project rejection) before successful workspace creation. The rejected path is not exposed by completed trace items, so its intended scope cannot be established. The misleading confirmation-effect wording remains a separate issue.

## Follow-up implementation

1. Extend the compact preparation projection with safe discovery of a selected job and precise missing-input blockers, plus a deterministic next operation. Avoid making the model infer these from generic `ready:false` or inspect source.
2. Provide a narrowly scoped bridge to canonical run setup that obtains current resume/fact revisions from code, validates the explicit choice and rechecks at mutation time. Preserve the existing confirmation and revision contracts.
3. Render pending-question consequences from the action contract so “confirm” accurately describes the Ready transition. The shell host still cannot authenticate a later human reply; a trusted host message adapter remains necessary for that guarantee.
4. Rerun all four paired scenarios after those product changes, retain failed iterations, then consider broader claim/browser recovery trials. No staging promotion follows from this report.

## Verification and evidence

Seven focused fixture/grader checks pass, including an archived baseline regression. Independent review caught an observer import that did not exist in staging; the observer now uses `WorkspaceProjectionsService.preflight`, shared by both pinned packages. Final native review also caught the historical-package test's missing baseline object in shallow CI checkouts. The affected CI shard now fetches that exact pinned commit, verified in a local depth-one clone. Each implementation commit passed eleven commit-hook suites. Final branch-review and publication receipts are recorded locally after the completed report is committed.

Raw evidence:

- `.workflows/local/continuation-eval-1791478148420/`: all four initial scenarios; cancellation excluded from primary results.
- `.workflows/local/continuation-eval-1791479865583/`: clarified cancellation, both arms.

Three repetitions per arm are descriptive. These fixtures do not exercise live browser recovery, sensitive-answer consent, expired claims, application filling, extraction review or campaigns. Deterministic checks and model trials remain separate evidence layers.
