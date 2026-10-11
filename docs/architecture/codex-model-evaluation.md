# Codex proposal evaluation

The experiment uses the installed **Codex runtime**, with its existing sign-in. It does not require Ollama, LM Studio, a local model server, or separate API credentials. The CLI runs locally; its configured OpenAI model inference is hosted. No credential file is read, copied or printed by the harness.

## Capability boundary

`codex-model-transport.mjs` supports the inspected Codex CLI **0.160.0** and `gpt-6.1-sol`. A different CLI version fails closed pending another capability review. The transport pins the native executable hash, the exact bundled model catalog, and the proposal JSON schema. It checks those hashes before each invocation. There is no session resume, ambient project, user configuration, hook, plugin or MCP workflow.

Each invocation has an empty temporary working directory and HOME, ephemeral mode, ignored user configuration/rules, disabled project documents and host skill discovery, `read-only` shell sandbox and `never` approval policy. Explicit feature settings disable shell, computer/browser use, apps, plugins, image generation, agents, goals, sleep, hooks, memory, code mode/host, discovery and workspace dependencies. The live invocation supplies the existing authentication home only to Codex's ordinary credential handling. The model receives fictional transcript text and the closed proposal output schema; it receives no Store path, canonical reader, browser handle or operator channel.

These switches alone are insufficient evidence. Before inference, `codex-model-probe.mjs` launches that same executable/catalog/capability configuration against an unauthenticated loopback **fake Responses provider**. It inspects the actual outbound request, requiring no provider tools and the exact proposal schema. It then returns an injected `exec_command` call and requires a subsequent unsupported-call response, still with no tools, followed by a completed synthetic JSON response. This exercises actual registration and dispatch rather than relying on `debug prompt-input`, which exposes messages without the tool inventory.

For the inspected runtime/model, disabling the code-mode host causes code mode to fail closed. Unknown fallback model metadata can instead advertise `request_user_input`; this transport does not accept that inventory or substitute a different model. Strict configuration on 0.160.0 rejects the documented `tools.view_image` field, so the inspected feature switch is used.

The probe changes the provider configuration to capture the request. Live requests use Codex's built-in OpenAI provider. Equivalence of capabilities across those providers is an **inference from the identical pinned executable, model catalog and capability configuration**, not captured live-provider wire evidence or an OS confinement proof. The fake provider tests perform no model inference. System-enforced settings still apply; unexpected tool inventory fails the probe.

## Controller and evidence

`createCodexModelTransport({binary, authHome, timeoutMs})` takes the absolute native CLI executable and existing Codex authentication home. It returns `verifyIsolation`, `next`, `diagnostics`, `assertStopped` and `close`. Call `verifyIsolation` before `next`; call `close` after trials. The trusted controller exclusively dispatches `context`, `event`, `observe`, `execute` and `reconcile` proposals and grades canonical state.

`runCodexModelTrials` performs at most five sequential fictional installed-fixture runs, at most twenty proposals each. Its default is three runs: missing-input handoff, source conflict and interrupted-operation replay, one run per scenario. This is a small scenario sample, not repeated statistical comparison. A model completion statement never overrides canonical checks. Human transcript review is still needed for unnecessary-question counts and other UX judgments.

Every Codex process has a bounded deadline (at most 120 seconds) and output budget (1 MiB in the transport). The controller bounds transcript input to 256 KiB. Processes run in a separate process group. On exit, timeout or output overflow the group is killed; cleanup requires the process group to disappear. Unconfirmed cleanup blocks fixture removal and preserves the runtime directory for investigation. Windows process-tree cleanup has not been established, so this transport rejects Windows.

Failed and incomplete attempts return a durable trace containing exit/signal/failure data, public event types, full bounded stdout/stderr, their hashes and accepted proposal text. Existing report files are private (`0600`) in private directories. Keep those raw diagnostic files private: model and runtime output are untrusted text. Hashes are integrity references, not substitutes for traces. The parser rejects unsuccessful processes, incomplete turns, malformed proposals and execution-bearing event items.

Live trials are a separate explicit operation; focused tests use recorded transports and the no-inference fake provider. They must retain null live metrics. Actual trials preserve every failed run, canonical before/after snapshots, measured transport/controller durations, and human-review packets. No owner Store, owner browser, live ATS or submission is involved.

## Running the experiment

Commit the candidate first. The trial CLI requires a clean checkout and checks
the exact revision around each installed fixture and after the batch. Use a new
ignored or external output directory; reports are not overwritten.

```sh
node evals/workflows/codex-model-cli.mjs --readiness --binary /absolute/path/to/native/codex
node evals/workflows/codex-model-cli.mjs --binary /absolute/path/to/native/codex --auth-home /existing/codex/home --output .workflows/local/codex-trial-batch --trials 3 --max-turns 12
```

Readiness uses a fresh empty authentication home and fake provider only. The
second command makes actual Codex model requests with the existing sign-in. It
exits nonzero if any trial is incomplete or fails canonical/scenario checks, or
if process cleanup cannot be confirmed. Exact replay and the source-conflict
rejection are graded from controller receipts, independently of saved state.
The prompted interruption scenario does not kill a process; separate browser
process recovery tests exercise that fault.

## Focused verification

```sh
node --test tests_js/workspace_workflow_codex_model.test.mjs
JOB_APPLY_CODEX_PROBE_BINARY=/absolute/path/to/native/codex node --test tests_js/workspace_workflow_codex_model.test.mjs
```

The optional binary variable enables only the real-runtime fake-provider probe; it never uses existing auth or real inference. The installed runtime and bundled catalog are version-specific evidence. Re-run the probe and review the boundary when upgrading either.

Sources: inspected local `codex exec --help`, `codex features list`, `codex debug models --bundled`, and generated app-server schemas; [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) for provider/catalog/config settings and [CLI reference](https://learn.chatgpt.com/docs/cli/reference) for execution/output options. The runtime probe takes precedence where local strict-config behavior differs from documentation.
