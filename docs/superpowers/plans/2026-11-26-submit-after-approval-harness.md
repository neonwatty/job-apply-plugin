# Submit after approval in the Job Apply harness

**Base** `origin/main` at `5d80f6a5`

**First milestone** One end-to-end submission through the Job Apply harness against an isolated Greenhouse-style fixture, with an exact owner approval and a verified receipt.

## Current behavior

The shipped filling modes are Guided, Autofill to Review, and Campaign to Review. The application authority contract allows filling and non-final navigation. The attempt broker hands completed applications off as `awaiting_review`. Keep using that contract to prepare applications. The new mode should add a separate approval and execution step after the existing review checkpoint. [Filling authority contract](../../../src/contracts/workspace/application-authority.ts#L9) · [Handoff contract](../../../src/workspace-core/claims.ts#L214)

The final-action policy already issues leases, binds exact revisions, arbitrates concurrent claims, supports revocation, and records outcomes. Its current auto-submit verifier exercises those primitives directly. The rendered replay only exposes a tripwire that rejects a final click. A passing policy verifier therefore leaves a specific integration gap between a reviewed browser form and an approved synthetic submission. [Current policy verifier](../../../src/qa-replay/auto-submit.ts#L17) · [Replay tripwire](../../../src/qa-replay/server.ts#L77) · [Policy contract](../../../skills/answer-memory/references/policy.md)

## Owner experience

1. Start an application in **Review only** or **Submit after approval**. Review only is the default. Submit after approval adds an approval step after the same review screen.
2. At review, see the employer, role, target application destination, selected résumé, and answers that will be sent. The selected jobs and their approved content are fixed when the owner confirms the preview.
3. Job Apply rechecks the visible form and application identity immediately before the final action. A changed form or answer returns the job to review with a reason.
4. Each application returns **Submitted**, **Needs attention**, or **Submission uncertain**. Submitted requires confirmation from the portal. The owner can stop the remaining approved applications.

The first slice uses one fictional job and an owner-facing local harness command for preview, approval, and execution. This exercises the mode through the actual harness entry point. A Companion button and multi-job execution can follow once the single-job path is proven. The work concerns the application harness and its test fixtures. The weekday workflow and the existing applications are outside this milestone.

## First implementation steps

### 1. Add the mode and an exact review preview

- Add a closed mode choice to the existing QA harness entry point in [the native replay CLI](../../../src/cli/native-qa-replay.ts#L15). Carry it through the isolated run configuration and status. Existing calls and older records should resolve to review only. Reject unknown modes.
- Use the existing [Greenhouse single-page fixture](../../../qa/fixtures/greenhouse-single-page-2026-08-v1/fixture.json) and the normal fill, upload, and review flow. Reuse the existing [readiness packet builder](../../../apps/companion/readiness-packet.mjs) and the broker's review evidence. Keep the approved fixture and its ordinary review tripwire intact.
- Create the approval preview from a verified review handoff. Bind it to the exact job and application destination, isolated Store and run, managed résumé content and confirmed-facts revision, selected answers and their revisions, and the observed form and final control. Check what the current readiness fingerprint covers. If it describes the controls but omits their values, add a separate binding for the proposed contents. A change to prefilled or manually edited answers must also invalidate the preview.
- Put approval behind an explicit owner action over that preview. Show the approved contents only in the local owner-facing view. Persist opaque references, revision bindings, and statuses. Keep applicant values, résumé content, and capabilities out of receipts and logs.
- At the first checkpoint, both modes reach the same review page. Submit after approval also offers an exact approval preview. Both modes produce zero accepted final actions at this point.

### 2. Connect owner approval to one synthetic final action

- Extend the QA harness with an isolated final-action executor that reuses the [policy authorization service](../../../src/final-action-policy/authorization.ts#L83). Use the existing private loopback and temporary Store boundaries. Give the executor a fresh observation of the browser form and verify it against the approved preview immediately before the one-time claim.
- Keep the ordinary replay tripwire in place. Use a separate fixture-only route for accepted synthetic submission. Its authority must come from the approved harness run and the private executor. A page event, form label, recorded browser action, or generic agent instruction cannot supply that authority.
- When the fixture accepts the submission, record a distinct confirmation event for the exact attempt via the [outcome service](../../../src/final-action-policy/outcomes.ts#L38). An attempted click, a stale success page, or a response without confirmation should remain distinguishable from an accepted submission.
- If the executor stops after claiming the action and the result is unclear, preserve the uncertain outcome across restart. Reconcile it against the fixture's submission record before making another attempt. Keep the existing controlled retry proof for synthetic tests. A missing confirmation alone should never trigger a new click.
- At the second checkpoint, demonstrate one accepted action, one verified receipt, restart recovery, and zero accepted actions on every denial path. The existing real-application review path stays human-submit only, as required by [repository guidance](../../../AGENTS.md).

### 3. Extend the proven path to a named batch

- Extend the same preview and owner confirmation to an explicit list of reviewed jobs. Bind each approval to its own destination, résumé, answers, and form. Use an ordered run and one execution attempt at a time.
- Report an outcome per job. A changed or blocked item goes to Needs attention. A confirmed item remains recorded even if a later job fails. A stop request prevents remaining claims.
- After the isolated run is accepted, decide how to expose the approval in Companion and which production candidate portal to support first. A live executor and a separately reviewed, exact-target trial are a later decision. Confirm how the portal reports success and how to reconcile ambiguous attempts before enabling that adapter.

## Acceptance checks

| Scenario | Expected evidence |
| --- | --- |
| Default and legacy review-only flow | Form reaches review and releases its claim. Zero accepted final actions. |
| Submit after approval, before confirmation | Exact preview is visible. Zero accepted final actions. |
| One approved, unchanged fixture | One accepted final action and one trusted confirmation receipt tied to the approved job. |
| Approval reused or two workers race | At most one accepted final action and one receipt. |
| Employer, job, destination, résumé, answer, final control, or approval revision changes | Stale approval is denied and the job returns to review. Zero accepted actions for that approval. |
| Cancellation, expiry, stop, or missing/forged approval | Zero accepted final actions after the boundary takes effect. |
| Process stops after the action or portal confirmation is missing | The result remains uncertain across restart. Replaying the request does not duplicate the submission. |
| Non-loopback URL, untrusted redirect, or real Store | The isolated executor refuses the request before claiming a final action. |
| Receipt, status, and error output | The owner can reconcile the result without applicant values or private capabilities appearing in logs. |
| Later batch coverage | Named jobs only, independent outcomes, no duplicate submission, and stopping prevents subsequent actions. |

## Verification sequence

- **Baseline on this worktree** `npm run test:auto-submit` passed all 11 reported assertions. `node --test tests_js/final_action_policy_cli.test.mjs tests_js/final_action_policy_concurrency.test.mjs` passed all 7 tests. These are policy baselines. The new browser-to-receipt journey is the milestone's added coverage.
- **During implementation** Regenerate the checked-in runtime from TypeScript. Rerun the policy verifier and the focused [Greenhouse renderer](../../../tests_js/renderer_greenhouse.test.mjs), [live readiness](../../../tests_js/workspace_live_readiness_packet.test.mjs), and policy concurrency tests. Add the new isolated journey and its denial paths to the repository test matrix.
- **Before packaging** Run type checks, the reproducible build check, and the affected tier using the repository's documented base. Run the release tier before claiming installed-harness support. Use fixture Stores and synthetic browser sessions for these checks. [Testing tiers](../../testing.md)

## Review decision

Start with the single-job harness mode and local approval command. Review that checkpoint before investing in a browser UI for approval or an executor for a live portal. A single synthetic form is enough to evaluate whether the approval and receipt model feels right.
