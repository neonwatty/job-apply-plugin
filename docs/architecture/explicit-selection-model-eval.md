# Direct selection comparison — 2026-10-08

## Result

The revised route removes the start/question/reply sequence for an explicit choice. All three candidate conversations used one direct selection, retained one finished task and one receipt, and made no canonical writes on repeated confirmation. The previous route created three receipts and consumed its pending question without waiting for another turn in all three trials.

The revision has **not demonstrated faster UX than ordinary intake**. Both arms selected correctly and asked zero questions. The candidate used fewer total shell calls but had higher median latency. Keep the experimental route isolated while extending the acceptance scenarios.

## Method

The [same runner](../../evals/preparation/README.md) installed baseline `f95b4947453ad6c6abc9cc0e81c3e443706d4714` and candidate `deb6b4e59040d9a991e5e2e1f5e526a890874a25`. Codex CLI 0.160.0 used `gpt-5.6-luna` with medium reasoning. Three repetitions per arm alternated execution order. Each fresh fictional Store received the same exact-choice request and two identical confirmations. All 18 persisted host contexts were verified, and all six temporary installations/Stores were removed.

Store hashes, job revisions, task/receipt counts and claim/session observations came from the harness. Complete transcripts and tool traces were reviewed for questions, scope and outcome claims. [Aggregate measurements and source digests](explicit-selection-model-results.json) retain exact revisions and evidence hashes. The product implementation and prompts match the measured candidate; subsequent report edits do not change the tested route.

## Measurements

| Metric | Baseline | Direct selection |
| --- | --- | --- |
| Correct Ready selection after first turn | 3/3 | 3/3 |
| User questions across nine turns | 0 | 0 |
| Canonical JSON/JSONL changes on repeated confirmation | 0/6 turns | 0/6 turns |
| Shell calls per conversation | 8, 8, 7 | 5, 6, 6 |
| First-turn latency median (range) | 24.7 s (22.4–52.9) | 31.8 s (30.6–39.6) |
| Conversation latency median (range) | 51.9 s (49.8–113.5) | 57.8 s (54.4–63.7) |
| Observed claim/session creation or browser/final action | 0 | 0 |
| Claims of filled/reviewed/submitted completion | 0 | 0 |

Each candidate ended every turn with one finished task, one receipt and no pending question. All job revisions remained 2 after selection. Shell calls exclude proposal-file creation/deletion items, which are also retained. All shell exits were zero; one reference-read shell command included a fallback, so exit status alone is not proof that every subcommand succeeded. Its required reference was present in the trace.

Baseline repetition 1 unnecessarily called `store init` against the already initialized fictional Store. Baseline 1 and candidate 1 used no new tool call on their final confirmation. The independent observations still found unchanged state; this does not establish behavior after context loss or concurrent input changes.

## Evaluation-driven correction

The first complete batch tested `ddb361a36ccd9b63256eb55625b833080956116b`. Candidate repetition 2 created a second task and receipt on its final confirmation because Ready context still allowed selection with a new operation ID. That batch is retained at `.workflows/local/preparation-eval-1791472122339/` and is excluded from the final table.

The corrected code exposes no selection action for an already Ready job and rejects a fresh selection operation in that state before writing. Identical delivery retries still return their historical receipt. Service and installed-command tests verify the distinction, including unchanged Store bytes. This is a concrete example of moving a behavior requirement from prompt guidance into a deterministic guard.

## Limits and next step

Three repetitions are descriptive. Native read-only review ran concurrently during the beginning of the final batch; host/service load was not controlled. Earlier and current batches should not be used as a causal speed benchmark. The final raw evidence is `.workflows/local/preparation-eval-1791472759067/`, with per-file hashes and exact executed harness copies.

The shell prototype still cannot authenticate a later human reply: its model can invoke `--host-user-event`. The new path avoids needing that event for an already explicit choice; genuine pending questions still need transcript checks or a trusted host user-message adapter.

Next, test fresh-context continuation, changed inputs, cancellation and unresolved choices. Deterministic stale-scope, revocation and retry checks pass, but this model scenario does not cover those paths, application filling, browser recovery or broader acceptance. No staging promotion follows from these results.
