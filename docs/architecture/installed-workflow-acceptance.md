# Installed workflow acceptance

The installed acceptance layer exercises the public command boundary in an isolated copy of the shipped JavaScript runtime and Companion launcher. It complements source-level domain tests and the full release artifact gate; it does not replace package-manifest, platform, or real-browser checks.

## Files

| File | Responsibility |
| --- | --- |
| `tests_js/workspace_installed_workflows_support.mjs` | Copied installation, fresh native fixture, public command execution, broker lifecycle, durable file snapshots |
| `evals/workflows/scenarios.mjs` | Executable extraction → preparation → campaign scenarios |
| `evals/workflows/grade.mjs` | Closed deterministic evidence validation and honest metric availability |
| `evals/workflows/run.mjs` | Local evidence report with commit/dirty identity |
| `tests_js/workspace_installed_workflows.test.mjs` | Deterministic installed command gate |
| `tests_js/workspace_installed_workflows_browser.test.mjs` | Installed protected browser commands, actual archival pressure, reconciliation and revocation |
| `tests_js/workspace_installed_workflows_browser_host.mjs` | Trusted synthetic host driver with private inherited IPC and adapter faults |
| `tests_js/workspace_installed_workflows_browser_support.mjs` | Host process and approval-channel lifecycle |
| `tests_js/workspace_installed_workflows_eval.test.mjs` | Reject incomplete or mislabeled grading evidence |

All fixture creation and mutations use public commands. Tests read Store files for exact preservation assertions but do not seed task receipts, invent acquired claims, mutate lease expiry, or manufacture completed states. Each command executes in a fresh process. Long-lived brokers are controlled by the harness, allowing restart tests to establish actual loss of the process-owned capability.

## Covered behavior

Extraction requires the exact pending reply and an explicit synthetic host attestation. An exact repeated reply is inert; a changed reply is rejected without durable writes. Confirmed facts feed an actual canonical run. Job preparation and campaign selection use that run. The campaign rejects out-of-order acquisition, unattested acquisition, progress while paused, and stale controls. Restart between jobs selects the next canonical Ready job. When both jobs need information, guidance exposes no action and asks for inspection. Restart during a live claim exposes no resumable capability and blocks a blind retry.

Preservation assertions include managed resume bytes and unrelated profile/resume metadata, as well as all durable files for rejected and replayed operations. The tests never assert browser draft preservation based on command-only scenarios. No final action or synthetic claim of review is introduced.

## Protected browser composition

The browser scenario imports the installed trusted host factory in a separate process. Only the fixture parent inherits its review/approval IPC channel. Public model commands cannot pass a host-event flag, mint approval, or attach an approval boolean. A host-approved exact acquisition succeeds; revoking that grant blocks acquisition replay. Canonical application authority separately governs browser operations.

The fixture makes 64 actual synthetic uploads through installed commands, causing terminal browser records to archive. An exact archived replay performs no new adapter call or durable write. A changed replay and a valid source aimed at an unconfigured target are denied. A deliberately interrupted readback leaves uncertainty; a new operation cannot bypass it, and explicit reconciliation confirms the prior effect without writing again. Canonical authority revocation blocks both a new request and historical replay. Needs Info handoff still releases the claim safely.

The adapter and source-to-control map are trusted fixture configuration. It never accesses a live browser and does not claim that an operating-system account or real person was authenticated. Reconciliation is tested in the same adapter lifetime; restarting a real browser requires an adapter that can observe its surviving draft.

## Scope and next evidence

The synthetic CLI attestation flag remains useful for existing fixture commands and does not authenticate a person. Protected browser host acceptance must keep human decisions on a separate host-owned channel. Browser adapter evidence remains synthetic. Real host approval UI, live ATS enforcement, expired-lease timing, and conversational quality require additional evidence.

See [the runner instructions](../../evals/workflows/README.md) for command-count and latency semantics. Scripted completion is not a measured improvement in model behavior. Question counts and model tool-call/latency metrics remain unavailable until actual conversations are captured and reviewed.
