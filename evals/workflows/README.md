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

The generic readiness command exits 2 with `ready:false` because it selects no transport. The default `unavailableLiveTransport()` still fails before inference. The experimental [Codex transport](../../docs/architecture/codex-model-evaluation.md) now provides an explicit supported configuration for the inspected CLI 0.160.0 and bundled `gpt-6.1-sol` metadata. It uses the existing Codex sign-in, a pinned executable/catalog/schema, disabled ambient capabilities, and an actual outbound request probe against a fake provider before real inference. An injected execution-tool call must be rejected. Capability equivalence with the built-in OpenAI provider is inferred from the same pinned runtime and configuration; this is not captured live-provider wire evidence or OS isolation. The existing unrestricted `tools/local-agent-acceptance.mjs` remains a separate lane and is not a fallback.

`verifyIsolation()` returns a closed evidence receipt; its shape validator does not itself enforce isolation. The Codex transport supplies the actual probe evidence, bounds subprocesses and output, confirms process-group termination before cleanup, and returns full private traces for completed and failed attempts. Only controller-dispatched JSON proposals reach the fixture; no host approval port, canonical reader, or Store path is passed to the model.

`codex-model-trials.mjs` runs three scenarios by default, one each for missing-input handoff, source-conflict rejection, and prompted interrupted-operation replay. The scenario grader requires the exact verified replay and the requested rejected conflict in addition to canonical invariants. The replay scenario is a conversation instruction, not an actual process kill; separate [process recovery tests](../../docs/architecture/browser-process-recovery.md) supply that evidence. Three scenarios are a small sample, not a statistical before/after UX comparison.

Recorded transport tests validate dispatch, evidence persistence, canonical failure, partial progress, and review bookkeeping. They establish neither real model behavior nor real browser behavior. Actual Codex conversations are a separate explicit run. Before/after UX comparisons and human question-quality review remain separate evidence requirements.

### Installed canonical fixture

`model-fixture.mjs` composes a fresh copied runtime installation and the existing private-IPC protected browser host. Fixture setup imports fictional resume facts, prepares jobs, and acquires a claim through the parent-owned approval channel. The installed host now uses the operator approval session: the fixture creates an immutable challenge, supplies a simulated exact decision, executes acquisition, and revokes that challenge’s grant before inference. This is synthetic operator input, not evidence of human approval. Only after acquisition does the controller receive its model-facing methods and value-free request text. Canonical reads never return bearer material.

`workspace_workflow_model_installed.test.mjs` runs the controller with recorded proposals through installed public browser commands. It observes a form, performs one upload, repeats the same durable operation, rejects a conflicting source, and saves a Needs Info handoff. The grader reads the committed ledger, claim status and jobs, observes final-action/control state, and compares private adapter write counts plus hashes of profile/managed-resume data. It requires exactly one write, the verified upload, an untouched final action, released claim, unchanged unrelated job, and preserved canonical inputs. Counterexamples for extra writes, submission/review claims, and changed inputs fail those checks.

This is an end-to-end **recorded transport** acceptance test with actual installed canonical mutations and a synthetic browser adapter. It is not an actual model conversation or live browser trial.
