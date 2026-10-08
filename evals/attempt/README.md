# Local attempt continuation evaluation

This opt-in model evaluation compares pinned ordinary and experimental attempt routes using fictional Stores and harness-owned brokers. It is separate from deterministic CI and installed-release gates. No live browser or applicant data is used.

## Run

```bash
node evals/attempt/run.mjs --trials 3 --model gpt-5.6-luna
node evals/attempt/run.mjs --trials 1 --scenario fresh-cancel
```

The checkout must be clean and committed throughout a run. `--candidate` accepts a full commit SHA; the default is the published slice 4e product `0dfe2fb429770efc31436ac649ee2ff0afe66d2f`. The ordinary baseline remains `f95b4947453ad6c6abc9cc0e81c3e443706d4714`. The runner uses the existing isolated plugin installer, model invocation, UTF-8 trace capture and persisted host-context validation from `evals/preparation/support.mjs`. Model defaults remain `gpt-5.6-luna`, medium reasoning, workspace-write and network disabled. A host-configuration mismatch aborts the run; do not silently relax it.

Three repetitions produce **21 conversations / 42 turns**: 18 paired conversations for the first three scenarios plus three candidate-only recovery conversations. Pair order alternates. A one-pair smoke run is separate diagnostic evidence and must not be silently mixed into the main sample.

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
| `evidence.mjs` | Clean-checkout identity, installed-package fingerprints and executed-harness copies |
| `tests_js/workspace_attempt_eval_fixture.test.mjs` | Real public clients against current and archived baseline packages |
| `tests_js/test-runner-attempt-eval.test.mjs` | Counterexamples for lost progress, extra jobs/tasks, changed inputs and false recovery |

The harness supplies synthetic checkpoint metadata, owns every intentional broker process and kills/awaits it before deleting its fixture. It starts the experimental broker through the installed public `workflow attempt serve` entry point. The ordinary broker is composed from installed modules with a longer idle-before-acquisition timeout so reference-reading time does not kill it. Ordinary clients still use their public `attempt` commands. The model is explicitly forbidden from launching/stopping brokers, using raw tokens or editing Store files.

After broker loss, a replacement process has no prior bearer. Recovery rotates that authority and advances the workflow task while preserving the canonical job revision; a later handoff increments the job revision. Lease expiry is an explicit harness-only intervention after the old broker exits, never a model edit. Models can observe canonical state only through installed public commands.

Cleanup checks for a live detached broker before removing unique fixture sockets/locks. If cleanup cannot establish termination, the temporary root is retained and the run remains incomplete. Successful runs remove temporary installations, Stores and owned socket artifacts. Raw evidence remains under `.workflows/local/attempt-eval-*`.

## Interpretation

Each receipt records full assistant messages, completed shell calls, other tool items, stderr, host context, canonical job/run/claim/session/history, durable hashes and package fingerprints. The snapshot redacts the stored claim-token hash to a one-way fingerprint; it never exposes a raw bearer. Heartbeat timestamps can change during active attempts; broker-loss preservation uses exact before/after hashes after the replacement starts with no capability.

State grades are not UX scores. Read every full trace and stderr for truthful availability/readiness, valid human-event interpretation, unnecessary questions, discovery failures, hidden rejected tool calls, unsupported authority changes and source inspection. Installed archives contain source/tests/evaluation files, so this is not a blind comparison. A passing claim or handoff is not evidence of browser mediation, form completion or safe final submission. No staging promotion follows automatically.
