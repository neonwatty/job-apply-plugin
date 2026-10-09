# Attempt guidance comparison — 2026-10-08

## Result

The revised experimental route passed **9/9 paired conversations** and **3/3 candidate-only expired-recovery conversations**. Ordinary passed **9/9 paired conversations**. All **21 conversations / 42 turns** completed; no acquisition prerequisite failed and no continuation was skipped, excluded or replaced.

Experimental acquisition/checkpoint improved from **1/12** in the [previous candidate sample](attempt-continuation-model-eval.md) to **12/12** here. This time every recovery turn ran. In the nine paired conversations, experimental shell calls totaled **87** versus **211** ordinary; median conversation duration was **64.2 s** versus **99.8 s**. These are encouraging results for these synthetic tasks, not a population-level reliability or speed guarantee. The code-provided context resolved the observed entry confusion while canonical guards continued to protect state.

## Method

The ordinary product is pinned to `f95b4947453ad6c6abc9cc0e81c3e443706d4714`; the revised experimental product and executed harness are pinned to `b47e6b03c11b10298bbb7580615681c6b83118e1`. Both routes use installed packages, fictional Stores, harness-owned brokers and isolated Codex homes. Model: `gpt-5.6-luna`, medium reasoning, Codex CLI 0.160.0. The scenario requests, grader, alternating pair order and scoped host policy are unchanged from PR #201. The final 900-second ordinary-broker idle budget and pre-turn deadline check are now in the executed harness; the previous main batch preceded that fix.

Three repetitions schedule 21 conversations and at most 42 turns. Failed acquisition/checkpoint prerequisites remain failures and leave later turns explicitly unexercised. No replacement sample is permitted. All first-turn acquisition requests are identical; scenario labels describe later interventions. State checks do not replace transcript review.

The separate diagnostic pair `.workflows/local/attempt-eval-1791509721231/` passed both conversations (four turns). Ordinary used 30 shell calls / 125,070 ms; experimental used 10 / 65,295 ms. The ordinary trace had four nonzero shell results, one additional stderr-only host rejection and implementation inspection. The experimental trace had none of those. Neither asked clarification questions or accessed Store files directly. Both roots were removed and all proposal files were deleted. These observations are outside the main sample.

## Outcomes and effort

| Scenario | Ordinary passes | Experimental passes | Ordinary calls per conversation | Experimental calls per conversation | Median duration, ordinary / experimental |
| --- | --- | --- | --- | --- | --- |
| Fresh cancellation | 3/3 | 3/3 | 24, 20, 16 | 11, 10, 10 | 97.9 / 70.4 s |
| Changed-input handoff | 3/3 | 3/3 | 36, 31, 23 | 9, 11, 10 | 99.8 / 64.2 s |
| Broker loss, preserve live claim | 3/3 | 3/3 | 18, 24, 19 | 10, 8, 8 | 99.9 / 61.5 s |
| Expired recovery then cancellation | No public counterpart | 3/3 | — | 15, 15, 15 | — / 100.5 s |

All acquired jobs moved from Ready revision 2 to In Progress revision 3 with the supplied active/questions checkpoint and `resume_upload` checklist. Cancellation and Needs Info handoff retained the existing run and inputs, saved the checkpoint and released the claim at job revision 4. Changed-input models left the harness-created facts draft unchanged; preflight remained false. Broker-loss second turns preserved every recorded Store hash, claim, job, session, history, run and ledger. All three experimental broker-loss models read the saved checkpoint from one context call and accurately distinguished a connected broker from absent claim capability.

The [machine-readable results](attempt-guidance-model-results.json) record every run, timing, package fingerprint, actual harness source hash and evidence digest. Main raw evidence is `.workflows/local/attempt-eval-1791510001754/`; its 306-file manifest is `evidence-sha256.json`. All 21 main temporary roots were verified absent. The separate smoke adds two cleaned roots, for 23 product-trial roots in this slice.

A shell item can contain multiple commands. Completed nonzero shell items in the paired sample were **29 ordinary / 3 experimental**; those counts omit host-rejected requests and failures masked by later shell commands. Durations include model/tool work but exclude fixture installation, and host/service load was uncontrolled. Installed packages include source and tests, so this is not a blind comparison. The previous sample used the same model and scenario requests but an earlier harness timing budget; all its ordinary acquisitions were well inside that earlier deadline.

## Transcript qualifications

Full traces, stderr and canonical snapshots were reviewed alongside grades. No model asked a clarification question; all final recorded-outcome summaries agreed with state, subject to the future-action/narration qualifications below. No successful direct Store-content access, filename enumeration, raw-token use, browser work or model-controlled broker lifecycle operation was observed. All recorded proposal files were deleted. State preservation does not by itself prove complete inspection or adherence to instructions.

- Fresh candidate repetition 1 queried an invented job ID; code returned `different_active_job` and no actions. The model refreshed the correct scope before cancelling. Two `rm -f` requests were rejected by host policy and later cleaned up through file edits. Its narration called an action descriptor authorization, although the user prompt separately authorized acquisition; descriptors themselves grant no consent.
- Stale candidate repetition 2 corrected a missing reference path. Broker-loss candidate repetition 1 corrected command and native-lock paths. Other paired experimental command calls completed successfully. Broker-loss candidates 2–3 had three additional stderr-only failures: one failed proposal patch and two rejected cleanup commands; all were corrected.
- Ordinary runs repeatedly tried unsupported `attempt claim-status`, root help and misplaced arguments. Stale repetitions 1 and 3 and all broker-loss repetitions inspected installed implementation; experimental paired runs did not. Ordinary fresh repetition 1 renewed its owned claim before the requested handoff. Redundant initialization/Ready selection did not alter inputs.
- **Attempted scope violations:** stale baseline repetition 2 made four public reads against an abbreviated root outside its fixture (`turn-2-trace.jsonl:10–13`); broker-loss baseline repetition 1 attempted a public task selection at a malformed external root (`turn-1-trace.jsonl:11`). Activation rejected all of them. No successful external-state access is evidenced.
- Broker-loss baseline repetition 3 read job/claim state but did not reload the saved session in its fresh second turn. Its preservation grade is supported by snapshots, not complete session inspection. Its earlier assertion that acquisition omitted the required revision was misleading; the returned job revision was 3.

All three recovery conversations advanced the same task from revision 2 to 3 while retaining job revision 3 and its input fingerprint, then cancelled it at task/job revision 4. Each ledger contains exactly four unreplayed operation receipts and one task. Public context showed claim ownership restored before successful guarded cancellation. No intermediate recovered-claim fingerprint was retained; direct rotation evidence comes from deterministic tests.

Recovery still had friction: each conversation contained two nonzero shell items plus one hidden tool rejection. These included wrong reference/lock paths, unsupported acquisition flags, an unmatched quote, a generic rejected event and a malformed patch. All were corrected. No recovery run inspected implementation. Trial 1's future “recovery/resume” wording after release was imprecise—fresh preparation/acquisition is required then. Trial 2 incorrectly blamed the supplied path for a space it introduced. Trial 3's precise explanation of a generic acquisition rejection cannot be verified from the retained proposal evidence.

Proposal file-change traces retain paths but not proposal contents. Described template use is supported by visible context, narration, accepted receipts and resulting state; it is not a byte-for-byte comparison of proposal JSON. Expected references were visible despite some suppressed-error read chains. Generic rejected events do not prove a model's specific explanation of their cause.

## Product boundaries

The change adds code-returned broker/claim distinction, exact target/revision, guarded advisory action templates and checkpoint metadata. Canonical execution still validates events, revisions, profile access, session packets, private capability and transitions. Explicit user-event flags remain model-authored attestations. No browser interaction or final submission is authorized by a claim.

Simple templates retain saved step, checklist, answer-key references and closed agent blockers. Saved pending-question fingerprints cannot recreate original observations: those actions require a complete observed session packet and cannot be executed unchanged. Tests verify that an incomplete template rejects without clearing pending work. Model scenarios use the supplied simple checkpoint, so they do not establish usability for reconstructing pending-question sessions.

Review also confirmed an existing canonical executor limitation: explicit expired recovery can replace the attempt's input fingerprint with the current scope. The new guidance reports changed inputs before recovery but does not change that execution behavior. The recovery scenario keeps inputs unchanged. Recovery after changed inputs remains a separate follow-up; no result here establishes its safety for continued progress.

## Verification

Twenty-seven focused checks and eleven commit-hook suites passed for the product commit. Review fixed two introduced defects: missing task-count capacity and incomplete session templates that could discard pending fields/blockers. Both fixes were independently validated. Native review's sandbox could not run all socket/release checks; the final local publication gate provides that evidence separately.

## Next work

Resolve the existing changed-input recovery fingerprint boundary, then extend acceptance to observed pending-question sessions and a trusted human-event adapter. Browser-mediated filling and final-review acceptance remain separate. This result supports continuing the experimental stack; it is not a staging promotion or merge authorization.
