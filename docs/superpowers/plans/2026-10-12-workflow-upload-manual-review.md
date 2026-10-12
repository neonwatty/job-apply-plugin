# Owner upload-to-manual-review implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development. User approved parallel execution; parent owns shared contracts, integration and testing.

**Goal:** Complete one explicitly opted-in selected-job application through accepted managed upload and durable manual review.

**Architecture:** Compose the existing claim session/readiness validator and upload-path guard. Add a fresh-session `awaiting_review` report/action, with owner-specific managed/current-input checks. Existing native transactions release the claim and save the manual-review handoff; host tools leave the visible page untouched for the owner.

**Tech Stack:** TypeScript runtime, Node installed clients, React Companion, native Store, host-provided browser tools.

**Spec:** `docs/architecture/agent-workflow-dogfood-readiness.md`, slice 2; user-approved continuation of PR #216.

## Global constraints

- Base PR #216, `3bcfb5c8c0ca1426753992c1f585ea6b66f5ae09`; isolated experimental branch, no staging merge.
- No real owner Store or live ATS pilot. All implementation acceptance uses isolated fictional data and a loopback form.
- Existing host browser tools perform upload and observation. Evidence remains agent-attested, not independent browser proof.
- Reuse existing readiness builders and canonical recomputation. No new persistence schema or readiness model.
- Owner review requires current selected managed resume, confirmed facts/current run, unchanged input scope, and a fresh complete live form packet.
- `resume.file` is the value-free semantic ID for the selected managed resume: required file control, observed accepted upload. Paths, filenames and applicant values never enter readiness or durable workflow receipts.
- `awaiting_review` report uses a new session, never a saved-session fingerprint or copied prior readiness. Exact receipt replay records history only.
- Preserve Needs Info/cancel after drift, manual final submission, finite v1 ledger, and no owner restart.
- Keep scoped files at most 500 physical lines; no new dependencies. Normal hooks and branch review remain required.

## Tasks

### 1. Owner completion policy

Allowed: `src/app/owner-workflow-policy.ts`, optional new `src/app/owner-review-policy.ts`, owner policy tests.

- [x] RED: reject drift, unconfirmed/external resume, fixture-only evidence, missing/unaccepted resume upload, saved-session completion.
- [x] Enable only guarded awaiting-review; delegate full readiness validation to ClaimsService.
- [x] GREEN: successful completion releases claim and preserves unrelated data; rejection leaves state intact and safe exit possible.

### 2. Host protocol and lifecycle

Allowed: owner broker, host-browser-guidance, owner broker/review tests.

- [x] RED: fresh review descriptor, outcome projection, terminal closure and exact replay.
- [x] Project code-provided review action with required operationId/session, no stale session or saved fingerprint.
- [x] GREEN: review completion and lost-response replay stop only the owned task's broker.

### 3. Prompts and Companion

Allowed: owner-workflow reference, job-apply entrypoint, OwnerWorkflow component, owner guidance and skill contract tests.

- [x] Document canonical resume resolution, immediate path guard, accepted upload observation, accumulated form inventory, guarded report and receipt recovery.
- [x] Keep host browser open at manual review; no raw/ordinary protocol fallback while claimed.
- [x] Update selected-job guidance and test rendered copy/contracts.

### 4. Shared contracts, integration and verification (parent)

Allowed: owner-workflow contract, host-browser-report parser, attempt-guidance, parent contract/integration tests, controlled upload fixture/grade, inventory reconciliation, generated runtime.

- [x] RED/GREEN parser and fresh canonical action: awaiting_review uses session only; action requires owned claim/current inputs/access and receipt capacity.
- [x] Installed native route acceptance: actual selected-file upload in loopback host browser, fresh readiness, durable handoff, claim release/broker close, visible review page, zero final actions.
- [x] Failure matrix: wrong/missing upload, stale inputs, incomplete controls, final action activated, exact replay, unrelated-data preservation.
- [ ] Affected selections against staging and intended base, source-size/type checks, independent task and full branch review.
- [ ] Full deep/release checks and normal commit/push hooks; publish PR stacked on #216 and retain worktree.

## Review focus

- A recorded upload/checkpoint is not fresh current form evidence.
- Revocation/drift during observation must prevent review without trapping safe exit.
- Lost terminal responses must be recoverable without repeating browser action or adopting another task.
- Form inventory must retain prior-step required controls and accepted resume after the input disappears.
- UI/prompts must distinguish manual review from submitted status and preserve visible draft.

## Acceptance evidence

Controlled Codex host-browser trial passed on the installed native clone: exact
managed path guard, file-chooser upload accepted once, accumulated two-step form
with three required controls and one optional blank, fresh readiness helper,
`awaiting_review`, claim released, broker exit 0, exact terminal receipt replay,
unrelated data unchanged and review page retained after shutdown. Final-action
counter: **0**. No owner data or real ATS used. Private grade and screenshot are
under `.workflows/local/agent-workflow-experiment/slice26-*`.

Policy, protocol/guidance and integration/fixture independent task reviews passed.
Focused installed/protocol/contract integration: **7/7**. Final release and
whole-branch review results belong in the PR receipt after the final commit.
