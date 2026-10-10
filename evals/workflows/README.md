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
