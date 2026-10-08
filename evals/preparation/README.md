# Local preparation comparison

Run from the experimental worktree with an authenticated Codex CLI:

```bash
node evals/preparation/run.mjs --trials 3 --model gpt-5.6-luna
```

This uses model capacity. It refuses CI execution. The pinned baseline is staging `f95b4947453ad6c6abc9cc0e81c3e443706d4714`; the pinned candidate is the installed host slice `4551524d45fbe90ae52dd231cfe739a9b2a43bae`. Changing the current checkout does not change either tested plugin. For a later experimental slice, pass `--candidate <full-40-character-commit-SHA>`; the report records that exact revision and the baseline remains pinned. Model and reasoning settings are identical across arms. Each repetition alternates which arm goes first.

## Scenario and evidence

Each arm receives a fresh equivalent fictional Store: one saved job, an active application run, one managed resume and current confirmed facts. The three user turns request exact-job selection, confirm it, then repeat that same confirmation. The task and boundaries match; only the instruction choosing ordinary intake versus experimental preparation differs. This is selection only, so the prompt explicitly excludes account checks, browser activity and claim acquisition.

The harness installs each archived revision using `codex plugin` in its own temporary `CODEX_HOME`, then starts a session and resumes that exact session for the next two turns. It does not prescribe the command sequence or request a success-shaped final JSON response. The existing scripted application acceptance runner remains separate.

Evidence is written under `.workflows/local/preparation-eval-<timestamp>/`: prompts, exact CLI invocations, JSONL traces, stderr, initial and per-turn Store observations, and `report.json`. `complete: true` means all conversations executed, **not** that product acceptance passed. The trace parser requires a completed host turn and preserves failures, complete assistant messages, shell calls, other item types and usage. Store observations come from the harness, independently of assistant claims. Hashes permit comparison of canonical JSON/JSONL bytes between turns; session filenames and claim state are also recorded.

Review every transcript before reporting acceptance. Count actual requests for user input, including imperative confirmations without a question mark. Inspect successful command outputs and Store observations for pending questions, premature reply attestations, changed revisions, extra tasks and repeated mutations. A shell tool call may contain several plugin commands; report these counts separately. Inspect all other trace items for unexpected tools or file edits. Record unsuccessful commands, truthful versus overstated completion and latency. No automatic punctuation counter or model-reported success is an acceptance grader.

## Isolation and limits

Only the host login file is linked into the temporary Codex home; credential contents are never read into reports. The normal plugin installation and configuration are untouched. Subprocesses receive a minimal environment plus the explicit fictional Store root. Every turn explicitly sets `workspace-write`, disabled web search and no approval prompts. CLI 0.160.0 defaults resumed turns to read-only without that override. The harness records and checks each persisted turn's effective model, reasoning effort, workspace and sandbox before accepting its execution. Store access is through explicit fixture paths, and the prompt forbids direct Store edits, host applicant access and browser/network tools. These instructions are behavioral constraints, not an OS guarantee against reading arbitrary host files. This runner is not suitable for adversarial or untrusted models.

Temporary installations, Stores and session homes are removed after each conversation, including on failure; recorded evidence remains. Each host turn has a six-minute deadline and bounded captured output; termination targets its process group. No broker is authorized. An observed claim or session is an immediate scope failure. These observations do not prove that no external side effect occurred; inspect the trace as well.

Repeated confirmation in an intact host conversation is not transport replay, model-context loss, broker recovery, stale-fact handling or browser continuation. This covers a small part of the [planned acceptance matrix](../../docs/architecture/agent-workflow-experiment-plan.md). Three repetitions expose variability; they do not establish statistical significance or improved real-world application completion.

## Files

| File | Responsibility |
| --- | --- |
| `run.mjs` | Fixed comparison, prompt scope, exact session continuation, evidence orchestration |
| `support.mjs` | Pinned-revision installation, isolated environment, bounded process execution, trace parsing |
| `fixture.mjs` | Fictional canonical Store construction and independent observations |
| `../../tests_js/test-runner-preparation-eval.test.mjs` | Trace completion/error contracts and process failure/deadline checks |
| `../../tests_js/point_paths_domain_support.mjs` | Validate the exact new evaluation registrations before the unchanged historical matrix digest check |

The use of JSONL tool traces and independent artifacts follows the approach in OpenAI's [skill evaluation guide](https://developers.openai.com/blog/eval-skills). Installed CLI help is the source for the particular invocation flags used here.
