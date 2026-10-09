# Pending-checkpoint model acceptance — 2026-10-09

## Result

The experimental route passed **9/9 conversations / 18 turns**. Every acquisition/checkpoint prerequisite passed; all nine fresh-session safe exits preserved the complete saved checkpoint, and all three changed-input expired recoveries retained the original task input scope. No turn was skipped, excluded or replaced.

This sample exercises the saved-checkpoint safe exit and preserved recovery scope added in PRs #203–204. It supports continuing the experiment; it does not compare ordinary-route usability or establish a latency improvement.

## Method

The installed experimental product is pinned to `712582a541f9c0434edb0be0345dfee6f30d6fbb`; the executed harness is `b3d4737b83e9a1ac710e8863b745f8ab81ec6ba4`. Model: `gpt-5.6-luna`, medium reasoning, Codex CLI 0.160.0. The checkout stayed clean at that harness revision throughout the batch. All packages, Stores and broker processes were isolated fixtures.

Three repetitions per scenario schedule nine candidate-only conversations, each with two independent model sessions. Turn one explicitly supplies synthetic unanswered fields (one sensitive), an outstanding resume-upload checklist and a required login browser handoff. The model acquires the exact Ready job and records that packet. Before turn two, the harness archives and clears its writable proposal workspace; the new session receives neither the original observation packet nor prior proposals. The Store is outside that workspace. Installed public context is the required source of saved state.

The first scenario cancels through Needs Info. The second changes canonical resume facts to a draft, then asks for a Needs Info handoff. The third combines changed facts with harness-controlled broker loss and fictional lease expiry, then asks the fresh session to recover the same task and cancel. The harness stops the old broker before expiring the lease and starts the replacement without its predecessor's private capability. Failed first-turn prerequisites remain failures with an unexercised second turn; no replacement sample is permitted.

Code independently grades normalized pending-question/scope fingerprints, sensitivity, unique canonical references, derived blockers, explicit browser handoff and absence of invented approvals/readiness. It compares the entire canonical checkpoint except `updatedAt` after the safe exit, preserves unrelated records and inputs, and checks original input scope in both the intermediate recovery receipt and terminal task. Full transcripts and stderr are reviewed separately.

## Outcomes and effort

| Scenario | State passes | Shell calls per conversation | Median conversation duration |
| --- | --- | --- | --- |
| Fresh-session cancellation | 3/3 | 10, 11, 12 | 94.8 s |
| Changed-input Needs Info handoff | 3/3 | 15, 14, 11 | 90.2 s |
| Changed-input expired recovery, then cancellation | 3/3 | 13, 17, 13 | 81.9 s |

All nine ended at Needs Info with the claim released, the original run retained, and unanswered/sensitive metadata, checklist, browser handoff, empty approvals and null readiness preserved. Facts drafts in all six changed-input cases remained unchanged and blocking. All three recovery receipts preserved the original task input fingerprint before cancellation.

The [machine-readable results](pending-checkpoint-model-results.json) retain each grade, timing, package fingerprint, executed-source hash and transcript qualification. Raw main evidence is `.workflows/local/attempt-eval-1791582617674/`, with a 139-file SHA-256 manifest. All nine main temporary roots were verified absent; the diagnostic adds one cleaned root. All proposal workspaces were reset before turn two and every recorded proposal file was deleted by the model. All broker cleanup receipts completed.

The main sample used **116 completed shell items**, including **seven nonzero items**, plus **three stderr-only tool rejections**. One successful shell chain masked two missing-reference errors; three successful context queries used invented job IDs and returned no actions for that scope.

A shell item may contain multiple commands. Nonzero completed items omit host-rejected requests and errors masked by later commands. Durations include model/tool work but exclude installation; host/service load was uncontrolled. These are three observations per scenario, with no ordinary comparison arm. The unchanged standard-suite baseline revision remains recorded by the runner but was not executed in this batch.

## Transcript qualifications

All full traces, stderr and recorded state were inspected. No clarification questions, installed implementation inspection, direct Store-content access, raw-token use, browser work, question reconstruction, extra answers/consent or model-controlled broker lifecycle operation were observed. Final accepted-outcome reports agreed with canonical state. These observations do not establish instruction adherence beyond the recorded traces.

- Fresh cancellation repetition 1 corrected one rejected malformed proposal patch. Repetition 2 made an unnecessary preparation-context read. Repetition 3 corrected a wrong native-lock path (one nonzero shell item).
- Changed-input handoff repetition 1 corrected truncated command/lock paths and a missing skill-reference path (three nonzero items), then corrected an invented `fixture-job` query using unscoped public context. A cleanup/context chain using `rm -f` was rejected; file edits completed cleanup.
- Handoff repetition 2 corrected a reference-read chain whose successful exit masked two missing-file errors, an invented job ID, and a truncated command path (one nonzero item). Repetition 3 only repeated a reference read.
- Recovery repetition 1 completed without recorded invocation errors. Repetition 2 corrected two malformed native-lock paths (two nonzero items) and an invented job ID. Its first-turn narration attributed the lack of required browser evidence to context; the supplied packet was explicitly synthetic, and advisory context cannot establish a genuine observation.
- Recovery repetition 3 made an unnecessary preparation-context read. A rejected `rm -f` cleanup was replaced with file edits.
- **Attempted out-of-scope paths:** cancellation repetition 3, handoff repetitions 1–2 and recovery repetition 2 used malformed external path prefixes. The commands failed; no successful external-state access is evidenced. Raw spellings and outputs are retained. The seven nonzero items, three hidden rejections and masked read failures are not erased by successful retries.

The separate diagnostic recovery conversation at `.workflows/local/attempt-eval-1791582396479/` passed all state checks in two turns: 13 shell calls and 130,200 ms. It corrected an invented job ID, inaccurately called that alias supplied, and described an advisory action as authorization even though the user prompt separately authorized the operation. Its proposal workspace was reset and temporary root removed. This smoke is excluded from the nine main conversations and their metrics.

Proposal file-change events retain paths, not the complete contents of deleted proposals. Accepted outcomes and preserved metadata are supported by canonical snapshots and receipts; they are not a byte-for-byte audit of every proposed JSON object. Public templates remain advisory, and generic rejected commands do not independently establish the model's explanation of their cause.

## Boundaries and next work

The checkpoint contains explicitly synthetic observations. Preserving it demonstrates historical-state continuity, not fresh browser evidence, answered questions or application readiness. The required login handoff remains unresolved. No live applicant Store, owner browser, real login, upload or final submission was used.

The host profile allows reads beyond the proposal workspace and installed archives contain source and tests, so this is not a blind security evaluation. The recorded socket rejection probes and persisted host-context checks passed. Human-event flags remain model-authored attestations; this sample does not establish trusted event delivery.

The next implementation boundary is trusted human-event delivery, followed by separately scoped browser-mediated acceptance and cumulative integration. Stacked PR reconciliation and staging promotion require their own authorization.

## Verification

Eighteen focused grader and public-fixture checks passed, including all three pending scenarios, dropped checkpoint metadata and intermediate recovery-scope counterexamples. The harness commit passed eleven commit-hook suites and source-size checks. Native Codex review and independent correctness, tests, contracts, silent-failure and documentation reviews found no actionable harness defects before the batch. Native review could not complete broader checks in its restricted environment; the corresponding base failures are retained, and publication gates are recorded separately in the slice 14 local receipt.
