# Attempt continuation comparison — 2026-10-08

## Result

The ordinary route completed **9/9 paired conversations**. The experimental route completed **1/9 paired conversations**, plus **0/3 candidate-only recovery conversations**. Its acquisition/checkpoint prerequisite succeeded in only **1/12** first turns. Eleven later turns were therefore **not exercised**, rather than counted as successful cancellation, interruption or recovery.

The main problem is entry guidance. Before acquisition, a successful experimental context returns `brokerAvailable:false` and `task:null`: it means the broker owns no claim capability yet. Models repeatedly interpreted that response as an unavailable broker or inability to acquire. One run acquired after discovering the canonical job revision, correcting the user-event flag and correcting progress serialization. That run then handled stale inputs correctly.

These results do **not** support replacing the ordinary route or promoting the stack to staging. Code-owned guards protected state, but the model-facing attempt interface needs clearer state and action descriptions. The experiment remains a plugin with an additional deterministic workflow layer.

## Method and provenance

The [runner and file map](../../evals/attempt/README.md) used fictional Stores, installed packages, separate Codex homes and harness-owned brokers. Baseline: `f95b4947453ad6c6abc9cc0e81c3e443706d4714`. Experimental product: `0dfe2fb429770efc31436ac649ee2ff0afe66d2f` (PR #200). No product code or prompts changed in this slice.

The main batch ran from clean, committed harness `f6847f6bac2c4c93b3f1109b2f835a19889b13e0`, using Codex CLI 0.160.0, `gpt-5.6-luna` and medium reasoning. Three repetitions per arm were scheduled for cancellation, stale inputs and broker loss; expired recovery was candidate-only because the ordinary public client has no recovery command. Pair order alternated. Every first turn used the same acquisition/checkpoint request; the scenario label determines the later intervention, not a distinct acquisition task.

The batch completed **21 conversations / 31 turns**. No main-sample run was excluded or replaced. Failed acquisition/checkpointing records a failed conversation and an unexercised second turn. Only the ten successful first turns proceeded to an intervention. Fresh cancellation and broker loss use new sessions; stale-input continuation resumes the original session. No model recovery turn actually ran.

The macOS `attempt_eval` profile extends workspace filesystem permissions and enables the command network proxy with no allowed domains and only the fixture broker socket added to its Unix allowlist. Every conversation passed a real probe: fixture socket connected, unrelated Unix socket and direct TCP rejected with `EPERM`, and proxied HTTP rejected with 403. Persisted host profile, filesystem restrictions, model and reasoning were checked after each turn. The persisted network bit is true because the proxy is enabled; complete proxy policy is evidenced by invocation capture and probes, not by that bit alone. Workspace permissions still allow host reads; the no-owner-data rule is an instruction, not a read-denial sandbox.

The [measurements](attempt-continuation-model-results.json) record revisions, executed harness hashes, package fingerprints, per-run metrics and evidence hashes. Raw evidence is `.workflows/local/attempt-eval-1791504751229/`. Full traces, stderr and canonical snapshots were reviewed separately from state grades. All 21 temporary roots were verified absent after broker cleanup.

## Outcomes and actual coverage

| Scheduled scenario | Ordinary state passes | Experimental state passes | Experimental second turns exercised |
| --- | --- | --- | --- |
| Fresh-session cancellation | 3/3 | 0/3 | 0 |
| Changed facts and Needs Info handoff | 3/3 | 1/3 | 1; passed |
| Broker loss, inspect without recovery | 3/3 | 0/3 | 0 |
| Expired recovery then cancellation | No public counterpart | 0/3 | 0 |

All ten acquired attempts moved from Ready revision 2 to In Progress revision 3 and saved the supplied active/questions checkpoint with `resume_upload` outstanding. The seven exercised cancellations/handoffs preserved the checkpoint and original run/inputs, moved the job to Needs Info revision 4 and released the claim. The experimental handoff retained the same persisted task and ended it as finished. No final-review or submitted state was produced.

All four exercised changed-input continuations truthfully reported the confirmed facts as stale. Only the harness changed `resume-facts.json`; models did not approve the draft, repair facts or replace/complete the run. All three ordinary broker-loss continuations preserved every recorded Store hash, claim, job and session, and accurately reported inability to continue with the replacement broker. One of those runs failed to retrieve the saved session successfully, so a preservation pass does not establish complete inspection UX.

All eleven failed experimental acquisitions preserved every recorded Store hash and created no claim, session or workflow task. Their finals accurately reported that acquisition/checkpointing had not occurred, but generally drew an unsupported inability-to-acquire conclusion from the initial context. No model asked a clarification question in the reviewed trials.

## Transcript findings

### Experimental entry and payload discovery

The context field describes **claim capability**, not transport liveness. The broker was running and answered successfully. The harness's initial context call also clears the candidate transport's startup idle timer; these failures were not candidate startup timeouts.

The sole successful experimental conversation, stale-input repetition 3, used preparation context before any active attempt existed to obtain Ready job revision 2. Its first acquisition omitted `--host-user-event` and was rejected. Three progress proposals were rejected before the model corrected the payload. It inspected installed implementation and tests extensively. Turn 2 used four shell calls, including one rejected continuation event before the accepted Needs Info handoff. The generic rejection alone does not identify a specific blocker; canonical snapshots establish the changed facts and blocked preflight.

Other experimental runs tried unsupported help or context arguments and often searched installed implementation. Fresh-cancel repetition 3 attempted acquisition without user-event attestation, received rejection, and stopped. Error recovery and syntax discovery remain costly even though the guards reject invalid writes.

### Ordinary route

All nine conversations passed state checks, with substantial discovery friction. Examples include unsupported `attempt claim-status`, root-level help failures, malformed paths, invalid facts-list arguments and implementation searches. Fresh-cancel repetition 1 initially confused managed-resume revision 1 with attempt revision 3; two progress writes were rejected before correction. Broker-loss repetition 1 initially blamed a malformed proposal path on session shape.

Broker-loss repetition 2 encountered four process-creation failures and an activity call missing `--id`; it never successfully loaded the saved session in turn 2. It nevertheless correctly reported inability to continue, and harness observations confirmed preservation. No ordinary broker-loss second turn attempted renewal, acquisition, recovery, progress, release or handoff.

Some proposal cleanup commands were rejected by host policy in stderr and later completed through file edits. Completed shell-item failure counts omit those hidden rejections and failures masked by a later successful shell command. The raw stderr and full tool outputs are part of the evidence. Expired-recovery candidate repetition 3 recorded 209 bytes of stderr for an initial process-creation failure; its identical retry reached the broker. Those infrastructure failures are not product-command failures.

### Scope exceptions

Fresh-cancel candidate repetition 3 recursively searched the fixture workspace and returned lines from `store/jobs.json` (`turn-1-trace.jsonl:18`, item 8). This is a **direct Store-content read**, contrary to the trial instructions, despite unchanged Store bytes. Broker-loss candidate repetition 3 enumerated fixture Store filenames and attempted a sandbox-rejected process inspection. These exceptions must remain visible alongside the state scores.

No observed direct Store-content writes, raw-token use, browser/account operations, submission, installed-file edits, unauthorized fact/run repair or model-controlled broker launch/termination occurred. Installed archives include source, tests and evaluation files; this is not a blind comparison, and implementation inspection was observed.

## Effort and latency

| Ordinary scenario | Shell calls per conversation | Median duration |
| --- | --- | --- |
| Fresh cancellation | 24, 26, 24 | 99.8 s |
| Changed inputs | 22, 30, 27 | 89.2 s |
| Broker loss | 29, 27, 31 | 118.4 s |

The sole completed experimental conversation used **28 shell calls / 149.9 seconds**, including 24 calls / 112.6 seconds before the initial checkpoint. Shorter failed experimental runs did less work; their durations are not a speed improvement. Measurements include model/tool time, exclude fixture installation and reflect uncontrolled host/service load. A shell item can contain multiple commands. The sample supports a concrete entry problem, not a general performance conclusion.

## Diagnostics and harness corrections

Two smoke batches precede and remain separate from the main sample:

- `.workflows/local/attempt-eval-1791503892107/`: two conversations / four turns using the earlier network-disabled preparation sandbox. Neither route could acquire through its broker client. Both fixtures were removed.
- `.workflows/local/attempt-eval-1791504422296/`: two conversations / four turns with scoped socket access. Ordinary acquisition/cancellation passed; experimental acquisition failed after a successful initial context. Both fixtures were removed. The runner then gained explicit failed-prerequisite handling before recovery interventions.

A separate one-turn host probe verified the scoped profile; it is not a product trial. The raw diagnostics are retained. All **25** product-trial temporary roots across main and smoke batches were verified absent.

Native and independent review identified a real harness timing defect: the ordinary broker's original 360-second idle deadline began before the model's separate 360-second deadline. The published harness extends idle time to 900 seconds and checks that a full model deadline plus ten seconds remains before starting an acquisition-capable turn. A boundary regression covers insufficient lifetime.

That correction was applied **after** the immutable main batch, without rerunning or replacing its sample. All nine observed ordinary acquisitions occurred within an upper bound of **27–46 seconds** from the earlier Ready-selection timestamp, well inside the original idle deadline. Broker-loss interventions killed the retained owned process with SIGKILL. The timing defect therefore did not affect these observations. Executed-harness copies remain pinned to the actual main-batch revision; the final harness additionally captures its timing module.

Thirteen final focused tests passed, covering public clients against current and archived baseline packages, stale-input rejection, broker replacement, exact expired recovery, cancellation, adversarial grading, host-context drift and the acquisition deadline. Existing deterministic claim tests cover profile revocation; the public fixture host enables its workflow profile unconditionally, so no model revocation result is claimed. Publication-gate receipts are maintained separately in `.workflows/local/agent-workflow-experiment/slice10-validation-summary.json`.

## Next change

Add code-returned attempt entry guidance that distinguishes a reachable broker from existing claim capability, exposes the exact canonical job/revision and describes the available event shape. Keep the existing revision, input, permission and claim guards. Then rerun this unchanged scenario comparison against the revised product.

Trusted human-event delivery remains a separate host-adapter task: model-authored `--host-user-event` is still an attestation, not authenticated human provenance. Browser-mediated recovery, filling and final-review acceptance remain untested here.
