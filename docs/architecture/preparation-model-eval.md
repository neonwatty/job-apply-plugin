# Preparation model comparison — 2026-10-08

## Decision

The new durable preparation route has **not demonstrated a better user experience** in this scenario. Both versions selected the correct job without asking a question and preserved it on repeated confirmation. The candidate needed more shell calls and had higher median latency. Its pending-question record did not enforce a pause for a later user reply: all three candidate conversations created and consumed that request in the same turn.

Keep the experimental route isolated. The next product slice should make explicit exact-job selection a direct deterministic operation, reserve pending questions for unresolved choices, and define which host component supplies user events. A model-controlled `--host-user-event` flag remains an attestation, not proof that a new human reply arrived.

This result supports retaining the code-owned state and revision guards while simplifying the host interaction. It does not establish an advantage for the candidate on continuation: both versions preserved the stored selection here, and the baseline already has deterministic, idempotent selection.

## Method and file organization

The [runner documentation and file map](../../evals/preparation/README.md) describe the executable comparison. The [machine-readable results](preparation-model-eval-results.json) record per-turn measurements, tested revisions, reviewed outcomes and evidence provenance.

- Baseline: staging `f95b4947453ad6c6abc9cc0e81c3e443706d4714`.
- Candidate: host slice `4551524d45fbe90ae52dd231cfe739a9b2a43bae` from PR #196.
- Host: Codex CLI 0.160.0, `gpt-5.6-luna`, medium reasoning; effective settings checked on every turn.
- Three repetitions per arm, three turns each: exact selection request, confirmation, identical confirmation again. Each conversation starts with an equivalent fresh fictional Store and installed plugin. Arm order alternates.
- The task is preparation only. Browser/account checks, filling, claims, final actions and real applicant data are excluded. The only arm-specific task instruction chooses the ordinary versus experimental preparation route.
- Questions, boundary behavior and outcome claims were reviewed from complete traces. Job state, revisions, claim/session state and canonical JSON/JSONL hashes were observed independently by the harness.

## Measured results

| Metric | Baseline | Candidate |
| --- | --- | --- |
| Correct Ready selection after first turn | 3/3 | 3/3 |
| User questions across nine turns | 0 | 0 |
| Canonical JSON/JSONL changes on repeated confirmation | 0/6 turns | 0/6 turns |
| Shell tool calls per three-turn conversation | 6, 10, 5 | 11, 7, 9 |
| Failed shell calls across three conversations | 2 | 2 |
| First-turn latency, median (range) | 23.9 s (19.1–30.5) | 52.8 s (35.9–59.1) |
| Three-turn latency, median (range) | 44.3 s (32.0–64.3) | 66.8 s (45.5–83.7) |
| New pending question consumed before a later user turn | Not applicable | 3/3 |
| Observed claim/session creation or browser/final action | 0 | 0 |
| Claims that selection meant filled, reviewed or submitted | 0 | 0 |

Latency is wall time for model turns, excluding package installation, fixture creation and user delay. A shell call can contain multiple plugin commands. Candidate proposal-file changes are also retained in the trace; the table is specifically shell calls. Three repetitions are descriptive, not statistically significant evidence of speed or reliability.

The baseline's two failed calls used incorrectly shortened temporary paths. The candidate attempted one relative skill read and one action with the command-file path mistakenly supplied as the Store root. Both recovered within the first turn. The candidate's invalid-root action was rejected; it did not write another Store. Successful canonical selection reached revision 2, and all later observations retained revision 2. Each candidate conversation retained one finished workflow task and three accepted operation receipts.

## What the pause result means

The candidate reference says preparation requires a scoped reply even when ordinary intake can infer selection from an exact-job request. In each measured first turn, the model invoked `newTask`, the `askUser` action, and then `prepare reply --host-user-event` without presenting a question and waiting for another message. The Store accepted the matching IDs and revisions. The model explicitly described the original exact-job request as the confirmation.

The user had authorized that job selection, so this is not evidence of unauthorized application filling or an incorrect selected job. It is evidence that a durable pending record plus a model-supplied flag does not enforce the conversational pause described by the prompt. Counting zero questions as an improvement would conceal that distinction; the baseline already asked zero.

For the next slice:

1. Represent an already explicit selection as one guarded operation using current run/job/input revisions, with a stable receipt for retries.
2. Keep `askUser` for a missing job/resume choice or changed scope. The host should supply a later user event tied to that pending request; the model should not manufacture the event merely to advance the workflow.
3. Provide one small preparation context with the current selection and allowed next action, reducing separate reads and hand-built lifecycle proposals.
4. Repeat this comparison and add fresh-context continuation, stale-input and cancellation scenarios before changing ordinary prompts.

## Evidence and limitations

The complete measured batch is `.workflows/local/preparation-eval-1791465485140/`; its report SHA-256 and executed harness source digests are in the committed results. `evidence-manifest.json` binds each local prompt, invocation, trace, stderr, state and receipt file. The recordings are fictional and remain local.

A pilot and an interrupted earlier comparison are excluded. They exposed a runner defect: `codex exec resume` reverted to read-only unless the sandbox was explicitly configured again. The corrected batch checks all 18 effective turn configurations. The excluded run directories and explanation are recorded in `.workflows/local/agent-workflow-experiment/slice6-excluded-runs.json`.

During review, the capture helper was hardened to decode split UTF-8 correctly and finish process-group timeout escalation before removing fixtures. Those fixes have focused regression tests. The measured conversations loaded the earlier capture helper; their exact executed sources are preserved. None timed out or hit capture limits, and none of the retained evidence contains a Unicode replacement character. The hardening did not change model prompts, plugin revisions or session settings.

This is an intact-conversation preparation comparison. It does not test transport replay, loss of model context, broker expiry, stale facts, revoked authority, sensitive consent, live forms, extraction or campaigns. No end-to-end browser or staging promotion claim follows from it. The [full acceptance matrix](agent-workflow-experiment-plan.md) remains outstanding.
