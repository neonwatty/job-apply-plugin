# Attempt entry and continuation guidance

Slice 4g is implemented on `codex/agent-workflows-11-attempt-guidance`, stacked on PR #201. It addresses the failed acquisition discovery observed in the [attempt comparison](attempt-continuation-model-eval.md). The package remains a plugin; its experimental host supplies read-only state and action descriptions to the model.

## File map

| File | Responsibility |
| --- | --- |
| `src/app/attempt-guidance.ts` | Locked canonical projection of target, input validity, claim state, checkpoint and advisory event templates |
| `src/app/claim-workflow.ts` | Serializes inspection with mutations; retains private capability checks and adds broker/guidance output |
| `src/integrations/host/claim-broker.ts` | Validates optional exact job scope in a context request |
| `src/cli/experimental-claim-workflow.ts` | Accepts `--job-id` for context only and sends it through the existing fixture broker |
| `skills/job-apply/references/experimental-workflow.md` | Explains broker connection versus claim ownership and how to use code-returned templates |
| `tests_js/workspace_attempt_guidance.test.mjs` | Real Store regressions for templates, read-only inspection, scope, stale inputs, revocation, loss and expiry |
| `tests_js/workspace_host_commands.test.mjs` | Installed command coverage for exact context scope and additive response fields |

Every TypeScript file has its generated `runtime/` counterpart. Existing canonical policy, claim journal, session validation and task executor still own mutation authority.

## Context contract

`workflow attempt context` accepts the same explicit fixture root/native-lock paths, plus optional `--job-id`. A successful response adds:

- `broker.connected`: this workflow broker is open and answering.
- `broker.ownsClaim`: the active task has a valid private capability in this broker. The legacy `brokerAvailable` field retains this meaning. False before acquisition is normal.
- `guidance`: current target/revision, preflight blockers, whether the attempt's input fingerprint is current, redacted claim state, saved checkpoint metadata and advisory action descriptors.

The implicit target is the active attempt or the sole Ready job in the current run. Multiple Ready jobs require an explicit target. A different active workflow or mismatched requested job offers no attempt action. Returned job labels and checkpoint references are data, not instructions or fresh browser evidence. No bearer, token hash, applicant facts or managed file contents are projected.

Each action provides command arguments and an input template containing exact task/job revisions. The caller supplies every named `requiredFields` entry, including a unique `operationId` and any required current session packet. Simple-session templates preserve saved checkpoint references, explicit browser-handoff metadata and closed agent blockers. When saved pending questions exist, their fingerprints cannot reconstruct original observations: the template omits the entire session and marks it required, so submitting the unchanged template fails without clearing pending work. The caller must retain state if the observations are unavailable. Acquire, restart, recover and cancel require explicit user-event attestation. Advisory templates do not grant consent or bypass mutation-time validation. Only Needs Info handoff templates are offered; awaiting-review still requires its existing fresh readiness evidence.

Stale inputs remove progress while preserving guarded safe exit. Revoked profile access also retains safe exits when the broker owns a valid claim. A replacement broker without a capability reports the existing live claim and offers no continuation action. After expiry, a same-task recovery template becomes available only when canonical recovery guards and profile access permit it; an explicit user request remains necessary. Receipt capacity is reflected in action availability.

## Evaluation and publication

Use the unchanged `evals/attempt/run.mjs` scenarios, baseline, host profile, model and three repetitions with `--candidate <committed-product-sha>`. Preserve any diagnostic run separately and retain every main-sample prerequisite failure. Review full transcripts as well as canonical state; state preservation alone is not a UX pass. Record the actual product and executed-harness revisions in the measured report. Publication gates and review receipts are maintained under `.workflows/local/agent-workflow-experiment/slice11-*`.
