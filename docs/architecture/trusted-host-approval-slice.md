# Host-owned attempt approval (slice 4k)

Branch: `codex/agent-workflows-15-host-approval`, stacked on PR #205 at `b4fda9a6260195c56e9d6b09e1132040529d5d03`.

## Purpose and boundary

An embedding host can now retain an approval port outside the model command transport. In this mode, the model's `--host-user-event` flag cannot authorize acquisition, restart, recovery or cancellation. Code requires a host-issued grant for the exact event fingerprint and canonical input scope, then rechecks that grant immediately before starting the durable commit.

This is a tested host integration primitive. It does **not** authenticate a person, read trusted Codex/Claude user-message events, or connect an actual approval UI. The embedding host must authenticate and interpret the human decision and keep the approval methods outside model access. A model-callable approval endpoint, automatic approval of model requests, or a model-controlled broker launcher would defeat that boundary. The existing host filesystem/process restrictions remain necessary; this is not an OS security boundary against an unrestricted same-user process.

The existing public `workflow attempt serve` remains the explicitly attested fictional-Store prototype. Preparation replies are also unchanged. No default installation switches to trusted mode. Both modes remain part of this plugin and share its installed runtime, public client, canonical Store and durable executor.

## File organization

| File | Responsibility |
| --- | --- |
| `src/harness/user-events.ts` | Separate approval and verification ports, exact hash binding, bounded lifetime/capacity, revocation and closure |
| `src/app/claim-workflow.ts` | Read-only event review, original input-scope binding, approval checks before domain work/replay and at commit, trusted-mode context |
| `src/cli/experimental-claim-workflow.ts` | Optional in-process server composition port; no public grant flag or command |
| `src/integrations/host/trusted-attempt.ts` | Fixture-only embedding API composing one broker and one in-memory approval authority |
| `skills/job-apply/references/experimental-workflow.md` | Explain trusted-mode discovery and prohibition on self-authorizing or replacing the broker |
| `tests_js/workspace_host_approval.test.mjs` | Grant bounds, mutation/replay/revocation, changed inputs, interrupted staging and recovery scope |
| `tests_js/workspace_host_approval_commands.test.mjs` | Public installed client against a separately controlled host process |
| `tests_js/workspace_host_approval_process_support.mjs` | Test-only upstream decision simulator using parent-owned IPC |
| `tests_js/workspace_host_support.mjs` | Own and clean up either installed test broker |

TypeScript files have one-to-one generated `runtime/` counterparts. No persisted schema or ordinary command format changes.

## Trusted embedding sequence

1. Import `createTrustedAttemptHost` from the installed `runtime/integrations/host/trusted-attempt.js`, using the explicit fictional Store and native-lock paths. The trusted host owns this instance and calls `run()` once, retaining the process and promise.
2. Obtain `host.review(event)` after startup. This read-only method returns the parsed event and `{eventFingerprint, inputRevision}`. The event includes its operation ID, task/job IDs, exact decimal revisions and complete payload. Review checks task/revision consistency; it does not establish all execution prerequisites or grant permission.
3. Present/interpret that exact event through the host's authenticated human-event path. Only after a matching human decision, call `host.approvals.approve(review.binding, lifetimeMilliseconds)`. Retain the returned grant ID privately for revocation. Never infer approval from model prose, a tool result or page text.
4. The model sends the exact event through the existing public `workflow attempt event` client. No grant ID, secret or extra approval field belongs in its JSON. `userEventSource: "trusted_host"` in context identifies this mode; advisory action arguments omit the legacy flag.
5. Revoke an individual grant with `host.approvals.revoke(id)`, or close all grants with `host.approvals.close()`. The host still owns broker shutdown. Closing approvals does not abandon an active claim: ordinary scoped Needs Info handoff remains available without a human-event grant, under the existing claim/session guards.

The approval port is an in-process object, never a file, CLI command or model socket method. The test fixture alone adds private parent/child IPC to simulate its upstream caller; that simulator is not installed as a production approval channel. The host API rejects review before startup and after shutdown. A failed startup or terminated broker closes its authority; one host instance cannot restart with retained grants.

## Exactness, time and recovery

Grants hold only event/input hashes and expiry in memory. Lifetime is an explicit integer from 1 through 300,000 milliseconds; at most 64 unexpired grants may exist. Capacity failure does not evict active grants. A monotonic clock controls expiry, and invalid or backward readings close the authority. Each approval returns its own revocation ID; revoking one does not revoke separately issued grants for the same event.

A grant permits exact idempotent retries until expiry or revocation. A new operation ID, different payload, different task/job revision or different input scope cannot borrow it. Historical receipt replay still requires a live matching grant but never repeats domain work or restores a lost private claim capability. After expiry the host may explicitly approve the same reviewed historical event again. The durable receipt format remains unchanged and does not itself attest authenticated human provenance.

Fresh acquisition/restart bind the current preparation fingerprint. Existing attempt recovery/cancellation bind the original task fingerprint, preserving the earlier changed-input recovery contract. Current canonical policy still checks whether execution is valid. A grant cannot repair changed inputs, authorize progress, bypass readiness, acquire a private claim token, approve a sensitive answer or permit final submission.

Approval is checked before domain execution and again immediately before the Store's atomic/journaled commit begins. Revocation or expiry during asynchronous staging rejects without committing staged claim or task state. Once commit has begun, later revocation cannot roll it back. Replay checks the grant inside the Store transaction. Closing a workflow clears its approval authority; a replacement broker starts with no grants and needs a new host decision for recovery.

## Verification and remaining work

Focused tests exercise forged legacy flags, unsupported public approval commands and JSON fields, altered operation IDs/session payloads, cross-host grant isolation, exact retries, expiry/revocation, stale preparation scope, staged-write revocation, replacement-broker recovery, and exact historical replay after the job is trashed. The installed-layout test imports the packaged host API while separate ordinary CLI processes submit proposals; only the fixture parent can issue grants through its inherited test channel. Legacy workflow tests verify continued attestation behavior.

The slice adds deterministic and installed-layout evidence, not another model trial or real human-event acceptance. Final review, affected selection, package and native publication receipts are recorded in `.workflows/local/agent-workflow-experiment/slice15-validation-summary.json` when complete. The next step is an actual host-owned human-event adapter (including preparation replies), followed by separately scoped model and browser acceptance.
