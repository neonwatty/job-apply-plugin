# Local attempt continuation evaluation

This opt-in model evaluation compares pinned ordinary and experimental attempt routes using fictional Stores and harness-owned brokers. It is separate from deterministic CI and installed-release gates. No live browser or applicant data is used.

## Run

```bash
node evals/attempt/run.mjs --trials 3 --model gpt-5.6-luna
node evals/attempt/run.mjs --trials 1 --scenario fresh-cancel
```

The checkout must be clean and committed throughout a run. `--candidate` accepts a full commit SHA; the default is the published slice 4e product `0dfe2fb429770efc31436ac649ee2ff0afe66d2f`. The ordinary baseline remains `f95b4947453ad6c6abc9cc0e81c3e443706d4714`. The runner uses the existing isolated plugin installer, UTF-8 trace capture and session reading from `evals/preparation/support.mjs`. Model defaults remain `gpt-5.6-luna` with medium reasoning. The macOS-only `attempt_eval` host profile extends workspace filesystem restrictions and enables the sandbox network proxy with **no allowed domains** and exactly the fixture broker socket allowed. Before each conversation a real sandbox probe must connect to that socket while rejecting an unrelated Unix socket, direct local TCP, and a proxied HTTP destination. Persisted session/profile/filesystem context is validated after every turn. The network bit is true because the proxy is enabled; this differs explicitly from the earlier preparation harness. Host mismatches abort rather than silently falling back. This uses the [documented permissions profile and socket allowlist](https://learn.chatgpt.com/docs/config-file/config-reference).

Three repetitions schedule **21 conversations / at most 42 turns**: 18 paired conversations for the first three scenarios plus three candidate-only recovery conversations. Pair order alternates. When turn 1 does not establish the exact acquired/checkpointed attempt, the conversation fails its acquisition prerequisite and records turn 2 as **not exercised**; no intervention is fabricated and no replacement trial is added. A one-pair smoke run is separate diagnostic evidence and must not be silently mixed into the main sample.

| Scenario | Turn 1 | Turn 2 / intervention | Comparison |
| --- | --- | --- | --- |
| Fresh cancellation | Acquire exact Ready job; save supplied value-free checkpoint | New session cancels via Needs Info, preserving step/checklist and inputs | Both routes |
| Stale inputs | Acquire and checkpoint | Canonical facts gain a draft; same session checks and hands off safely without repairing inputs | Both routes |
| Broker loss | Acquire and checkpoint | Owned broker killed; replacement starts without bearer; new session inspects and preserves live claim | Both routes |
| Expired recovery | Acquire and checkpoint | Owned broker killed; harness expires only fictional lease; new session explicitly recovers same task then cancels | Experimental route only |

The ordinary attempt client has no recovery command. Do not invent an equivalent endpoint or force ordinary models to use raw bearer commands. Profile revocation is tested deterministically in `workspace_durable_claims.test.mjs`; the public fixture server currently enables its workflow profile unconditionally, so this report cannot claim a model-level revocation trial. No readiness packet or browser observation is fabricated.

## Files and boundaries

| File | Responsibility |
| --- | --- |
| `run.mjs` | Sequential trials, per-turn interventions, trace/state capture and cleanup receipts |
| `fixture.mjs` | Canonical Ready setup, locked durable snapshots, exact fictional lease-expiry intervention |
| `broker.mjs` | Owned process handles, readiness, termination/escalation and fixture socket cleanup |
| `baseline-broker.mjs` | Foreground ordinary broker using installed services; extends only idle startup timeout |
| `scenarios.mjs` | Equal user requests where supported, explicit trial boundaries and adversarial state grades |
| `host.mjs` | Scoped broker socket profile, rejection probes and persisted host-context validation |
| `timing.mjs` | Model deadline and baseline idle budget checked before model startup |
| `evidence.mjs` | Clean-checkout identity, installed-package fingerprints and executed-harness copies |
| `tests_js/workspace_attempt_eval_fixture.test.mjs` | Real public clients against current and archived baseline packages |
| `tests_js/test-runner-attempt-eval.test.mjs` | Counterexamples for lost progress, extra jobs/tasks, changed inputs and false recovery |

The harness supplies synthetic checkpoint metadata, owns every intentional broker process and kills/awaits it before deleting its fixture. It starts the experimental broker through the installed public `workflow attempt serve` entry point. The ordinary broker is composed from installed modules with a 900-second idle-before-acquisition timeout. Before each model turn that needs this idle broker, the runner verifies that its remaining lifetime exceeds the full 360-second model deadline plus ten seconds for termination. This prevents setup time from consuming the acquisition window. Ordinary clients still use their public `attempt` commands. The model is explicitly forbidden from launching/stopping brokers, using raw tokens or editing Store files.

After broker loss, a replacement process has no prior bearer. Recovery rotates that authority and advances the workflow task while preserving the canonical job revision; a later handoff increments the job revision. Lease expiry is an explicit harness-only intervention after the old broker exits, never a model edit. Models can observe canonical state only through installed public commands.

Cleanup checks for a live detached broker before removing unique fixture sockets/locks. If cleanup cannot establish termination, the temporary root is retained and the run remains incomplete. Successful runs remove temporary installations, Stores and owned socket artifacts. Raw evidence remains under `.workflows/local/attempt-eval-*`.

## Interpretation

Each receipt records full assistant messages, completed shell calls, other tool items, stderr, host context, canonical job/run/claim/session/history, durable hashes and package fingerprints. The snapshot redacts the stored claim-token hash to a one-way fingerprint; it never exposes a raw bearer. Heartbeat timestamps can change during active attempts; broker-loss preservation uses exact before/after hashes after the replacement starts with no capability.

State grades are not UX scores. Read every full trace and stderr for truthful availability/readiness, valid human-event interpretation, unnecessary questions, discovery failures, hidden rejected tool calls, unsupported authority changes and source inspection. Installed archives contain source/tests/evaluation files, so this is not a blind comparison. A passing claim or handoff is not evidence of browser mediation, form completion or safe final submission. No staging promotion follows automatically.

The initial smoke at `.workflows/local/attempt-eval-1791503892107/` used the preparation harness’s network-disabled sandbox. Both routes failed to acquire because their public clients could not reach the broker (2 conversations / 4 turns); no claim or checkpoint was saved. Retain that diagnostic evidence separately. An isolated socket probe confirmed `EPERM` without the scoped proxy configuration and a connection with it. Persisted turn context records the active profile and filesystem restrictions but not the complete proxy allowlist; exact invocation capture and the rejection probes supply that additional evidence.

The scoped-host smoke at `.workflows/local/attempt-eval-1791504422296/` passed ordinary acquisition/cancellation but failed candidate acquisition: the model interpreted the live context’s initial `brokerAvailable:false` (no claim capability yet) as an unavailable broker. Both conversations and all four turns are retained as diagnostics, outside the main sample. The runner now records this kind of missing prerequisite before attempting any second-turn lease intervention.

## Measured comparison

See the [21-conversation report](../../docs/architecture/attempt-continuation-model-eval.md) and [machine-readable measurements](../../docs/architecture/attempt-continuation-model-results.json). The immutable batch predates the final timing correction; failed prerequisites and unexercised recovery turns remain in its results.

The [attempt guidance follow-up](../../docs/architecture/attempt-guidance-model-eval.md) reruns the same scenarios against the committed guidance product, using `--candidate b47e6b03c11b10298bbb7580615681c6b83118e1`. It records all 21 conversations / 42 turns and separates its diagnostic pair from the main sample.

## Pending-checkpoint acceptance batch

```bash
node evals/attempt/run.mjs --suite pending --trials 3 --candidate 712582a541f9c0434edb0be0345dfee6f30d6fbb
```

This opt-in extension schedules **nine candidate-only conversations / at most 18 turns** at the saved-handoff product from PR #204. The default standard comparison and its pinned revisions remain unchanged; pass the candidate explicitly for this extension. Each scenario can also be selected with `--scenario`. The model and host policy remain the same as the earlier comparison.

| Scenario | Intervention before a fresh second session | Required outcome |
| --- | --- | --- |
| `pending-cancel` | Archive and clear model proposal workspace | Cancel through Needs Info, retaining every saved session field except its update timestamp |
| `pending-stale-handoff` | Clear workspace; create canonical facts draft | Needs Info handoff, checkpoint and original input scope preserved, draft still blocking |
| `pending-stale-recovery` | Clear workspace; create facts draft; stop broker; expire fixture lease; start replacement | Recover the same task with original input scope, then cancel while preserving the full checkpoint |

The first turn receives two explicitly synthetic unanswered observations, one sensitive, an outstanding resume-upload checklist and a required browser handoff. Acquisition is a prerequisite: missing or altered pending fields leave the second turn unexercised. Code grades normalized question/scope fingerprints, unique pending references, sensitivity, blockers, browser handoff and lack of invented readiness/approvals. Terminal grading compares the entire canonical session except `updatedAt`, input hashes and run, and both the recovery receipt and terminal task's original input scope.

For these scenarios the Store lives outside the writable model proposal workspace. Before turn two, the harness archives that workspace under the run evidence and recreates it empty. The new session receives neither the first prompt nor its proposal files. Public Store commands remain the required source of state. This is not a blind security test: installed packages contain source and the host profile still allows filesystem reads; full transcripts must be checked for unauthorized discovery or state access. The existing socket rejection probes and persisted host-context validation remain mandatory, following the [official permission-profile guidance](https://learn.chatgpt.com/docs/permissions).

`pending.mjs` owns the synthetic packets, fresh-session requests and additional checkpoint assertions; `scenarios.mjs` composes these with the common state grader. `run.mjs` owns the proposal-workspace boundary and the combined changed-input/expiry intervention. `evidence.mjs` captures the additional executed source. The existing fixture and grader test files exercise all three scenarios and counterexamples for dropped pending metadata and rebound recovery scope.

This batch is candidate acceptance evidence, not an ordinary-route comparison or a latency improvement claim. Human-event flags remain model-authored attestations; trusted host delivery, browser-mediated filling and final-review acceptance remain separate work. State grades require full trace/stderr review and do not establish genuine browser observations.

The [pending-checkpoint report](../../docs/architecture/pending-checkpoint-model-eval.md) records nine conversations / 18 turns at this product revision, all state checks passing, with complete transcript qualifications and [machine-readable measurements](../../docs/architecture/pending-checkpoint-model-results.json). The diagnostic smoke remains separate.
