# Installed workflow evidence

Run deterministic scenarios against a fresh copy of the current checkout's runtime and Companion command launcher:

```sh
node evals/workflows/run.mjs
node evals/workflows/run.mjs --scenario campaign-broker-restart
```

The runner records the checkout commit and dirty status in ignored `.workflows/local/installed-acceptance/<timestamp>/report.json`. It creates fictional Stores with the installed `native-jobs.js fixture-init` public command, then uses installed `apps/companion/command.mjs` commands for setup and workflow actions. It copies no source modules or runtime dependency links into the installation. Native lock compilation is the existing fixture mechanism. No applicant Store, owner browser, live model, or network service is used.

## Scenarios

- `campaign-blocked-queue`: resume extraction waits for host attestation, accepts the exact reply, replays without writes, rejects a changed reply, creates an actual application run from confirmed facts, prepares two jobs, then exercises campaign queue order, pause, stale resume rejection, exact handoff replay, process restart between jobs, and Needs Info queue guidance.
- `campaign-broker-restart`: follows the same public setup, acquires a claim, restarts the broker, and proves that the live claim cannot be resumed or bypassed without its lost private capability. It does not edit lease expiry or pretend to test expired recovery.

The fixture host deliberately supplies `--host-user-event` for the existing synthetic campaign/extraction routes. This flag is an attestation, not authenticated human approval. Protected browser-host tests exercise a separate host-owned decision channel. Run those separately with `node --test tests_js/workspace_installed_workflows_browser.test.mjs`; their 64 real synthetic mutations and reconciliation checks are acceptance evidence, not part of the two scenario metric reports.

## Interpretation

`grade.mjs` accepts a closed evidence shape and requires every named scenario invariant. Command invocations and command latency are measured from actual subprocesses, including setup and expected rejections. Broker startup/shutdown affects total elapsed time but is not counted as a command invocation. These counts are not model tool calls or a before/after UX comparison.

`modelToolCalls`, `unnecessaryQuestions`, and `modelLatencyMs` are explicitly null. No conversational completion rate or improvement is established by scripted command success. A later model evaluation must capture real transcripts, use an isolated host profile that permits only the fixture model channel, preserve the separate approval channel, and use blinded/manual question review before filling those metrics. Existing `evals/attempt` model runs are separate, version-pinned experiments; this runner does not silently invoke them.

The evidence assumes a trusted test harness and is not a cryptographic attestation. Edited receipt JSON cannot prove product behavior. Failed invariants abort the run and leave an incomplete report; the runner does not convert a failure into a success metric.

## Conversation evaluation controller

`model-runner.mjs` exports `runModelEvaluation` for a host-owned fixture and transport. It drives bounded, stateless JSON proposals through only the protected browser host's `model` methods: `context`, `event`, `observe`, `execute`, and `reconcile`. `model-contract.mjs` exports the structured output schema. An action contains an ID, one of those names, and JSON-encoded arguments; a null action ends the conversation. Duplicate call IDs abort before a second dispatch. The host port and canonical reader are never passed to the transport.

The controller records full raw transport traces, assistant messages, proposals, sanitized tool responses, measured transport/tool durations, and canonical snapshots before and after the conversation. Only the host's canonical grader determines state success; the assistant cannot award itself completion. Failed parsing, duplicate IDs, turn exhaustion, rejected tools, and incomplete transport remain in the report. A recorded transport always reports live model metrics as null. A blocked live transport also reports null metrics. CLI transport latency, when eventually measured, includes process startup and is not inference-only latency.

`model-report.mjs` produces transcript review packets without model/treatment metadata and validates human annotations against the transcript digest and exact assistant message indices. The harness does not infer unnecessary questions from punctuation. Randomized packet IDs, blinded assignment, and human review remain responsibilities of the evaluation operator; a packet alone does not establish that a review was blinded.

### Live readiness

```sh
node evals/workflows/model-cli.mjs --readiness
node --test tests_js/workspace_workflow_model_eval.test.mjs
```

The readiness command currently exits 2 with `ready:false`. No live model is launched. The default `unavailableLiveTransport()` fails before inference. The existing `tools/local-agent-acceptance.mjs` uses unrestricted execution and is **not** a fallback for this controller. The existing attempt evaluator's shell/socket sandbox does not establish an exclusively model-channel transport either.

On the inspected Codex CLI 0.160.0, `debug prompt-input` renders messages rather than a complete actual tool inventory. The [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) documents `features.shell_tool` and per-MCP-server `enabled_tools`, but those controls alone do not prove every other computer tool is inaccessible. Do not replace the missing proof with prompt instructions or a post-execution tool-call audit.

A future trusted transport can implement `kind:'live_model'`, `verifyIsolation()`, and `next({messages})`. `verifyIsolation` must return a receipt whose `kind` is `isolated_json_proposals`, whose `evidence` identifies the actual capability proof, and whose closed `checks` establish `noModelComputerTools`, `noModelStoreAccess`, `noModelApprovalAccess`, and `noModelNetworkTools`. The receipt validator checks shape and results; it does not itself enforce OS isolation. Only trusted, independently verified transport code may supply it. `next` returns `{text, rawTrace, completed}` and must enforce a deadline, preserve failure output, and finish descendant cleanup before returning. It must not resume with a changed capability surface. A direct API with only controller-dispatched JSON outputs is a possible future route, but requires configured credentials and provider validation; this change does not create or access them.

Recorded transport tests validate dispatch, evidence persistence, canonical failure, partial progress, and review bookkeeping. They establish neither real model behavior nor real browser behavior. Actual conversations and before/after UX comparisons remain unmeasured until that prerequisite is satisfied.

### Installed canonical fixture

`model-fixture.mjs` composes a fresh copied runtime installation and the existing private-IPC protected browser host. Fixture setup imports fictional resume facts, prepares jobs, and acquires a claim through the parent-owned approval channel. Only after acquisition does the controller receive its model-facing methods and value-free request text. Canonical reads never return bearer material.

`workspace_workflow_model_installed.test.mjs` runs the controller with recorded proposals through installed public browser commands. It observes a form, performs one upload, repeats the same durable operation, rejects a conflicting source, and saves a Needs Info handoff. The grader reads the committed ledger, claim status and jobs, observes final-action/control state, and compares private adapter write counts plus hashes of profile/managed-resume data. It requires exactly one write, the verified upload, an untouched final action, released claim, unchanged unrelated job, and preserved canonical inputs. Counterexamples for extra writes, submission/review claims, and changed inputs fail those checks.

This is an end-to-end **recorded transport** acceptance test with actual installed canonical mutations and a synthetic browser adapter. It is not an actual model conversation or live browser trial.
