# Resume Extraction Onboarding

## Objective

Build the approved local-first workflow that lets a person request fact
extraction from a managed resume in the Companion, lets a Job Apply agent
fulfill that same durable request through the CLI, and lets the person review
the resulting facts with a shared, Store-owned preparedness view.

## Original Request

Plan and build the missing UX-triggered resume extraction and onboarding
workflow so the human and agent can control the same canonical data.

## Intake Summary

- Input shape: `existing_plan`
- Audience: Job Apply users and Job Apply agents
- Authority: `approved`
- Proof type: `demo`
- Completion proof: the deterministic redacted-resume oracle, focused UI
  walkthroughs, full regression suites, packaged-plugin checks, and a fresh
  skill-driven agent acceptance all pass without private owner data or an
  application browser action.
- Goal oracle: `npm run qa:resume-extraction-onboarding` returns a value-free
  receipt with `passed: true`, all required repository gates are green, and the
  fresh agent stops at proposal review.
- Likely misfire: delivering attractive UX or a queue that does not actually
  connect the browser, agent CLI, proposal lifecycle, and canonical profile.
- Blind spots considered: honest waiting when no agent is active; no embedded
  model or automatic task launch; existing opaque resume content revisions;
  concurrent agents and cancellation races; cosmetic metadata edits; legacy
  proposal compatibility; browser inability to inject extracted candidates;
  structured-array replacement risk; forward-compatible Additional facts; and
  privacy differences between value-free request/preparedness output and
  explicitly requested local profile/proposal detail.
- Existing plan facts: preserve the approved design at
  `docs/superpowers/specs/2026-09-03-resume-extraction-onboarding-design.md` and
  the nine-task implementation plan at
  `docs/superpowers/plans/2026-09-03-resume-extraction-onboarding.md`. Implement
  Store/CLI foundations first; then preparedness/API; then the Resumes and
  Facts UX; then agent instructions and the end-to-end oracle.

## Goal Oracle

The oracle for this goal is:

`The committed redacted resume fixture completes the explicit UX request -> CLI agent completion -> grouped human review -> shared profile flow; content changes, cancellation, concurrency, stale revisions, and crash recovery fail safely; all new request/preparedness outputs are value-free; the fresh agent stops at review; npm run qa:resume-extraction-onboarding, npm run test:qa-browser, the full Python suite, and scripts/smoke-plugin.sh all pass.`

The PM must keep comparing task receipts to this oracle. Planning, discovery, a
passing tiny slice, or a clean-looking board is not enough. The goal finishes
only when a final Judge or PM audit maps receipts and verification back to this
oracle and records `full_outcome_complete: true`.

## Goal Kind

`existing_plan`

## Current Tranche

Continuously implement the full approved plan in the isolated worktree at
`/Users/neonwatty/Desktop/job-apply-plugin/.worktrees/resume-extraction-onboarding-design`
on `codex/resume-extraction-onboarding-design`. Start by validating the plan
against current `origin/staging`, then deliver the largest safe vertical slices
in order until the complete local oracle is proven. A PR, merge, installation,
promotion, tag, or release is not part of this tranche and requires a separate
owner instruction.

## Non-Negotiable Constraints

- Extraction starts only after explicit human or agent intent; import never
  starts it automatically.
- The existing Job Apply agent performs extraction. Do not embed a model or
  launch/wake a Codex task from the product.
- The canonical Store is the sole mutation authority.
- Requests have no durable `processing` state and no automatic timeout.
- Request/preparedness documents and outputs, logs, receipts, and handoff text
  contain no resume bytes, paths, filenames, digests, fact values, or raw errors.
- Existing explicitly invoked local profile/proposal detail commands remain
  value-bearing and must not be broken.
- The Companion may list, create, cancel, and retry requests; it cannot complete
  or fail them, submit candidates, or specify a profile revision.
- Human-confirmed facts are not silently overwritten; structured replacement
  requires explicit review and confirmation.
- Preparedness is advisory and has no score or job-readiness claim.
- Do not use owner data, a live job application, account automation, OS
  credentials, cloud services, telemetry, OCR, or any application final action.
- Add no runtime dependency and preserve Linux, macOS, Windows, and packaged
  plugin behavior.
- Preserve unrelated worktrees and the user-owned `output/` and `tmp/`
  directories in the primary checkout.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

Do not stop after planning, discovery, or Judge selection while a safe Worker
task remains. Do not stop after the Store contract, the API, or one attractive
screen; the full human-agent-human loop and privacy/recovery oracle must pass.

If a phase exposes a genuine ambiguity or behavior/security expansion, stop
that slice with a receipt and continue any independent safe local work. If an
exact approval is the only remaining blocker and no safe work remains, record
the required reply once in the terminal blocked state.

## Slice Sizing

Safe means bounded, explicit, verified, and reversible. Each Worker owns one
coherent milestone: Store/CLI lifecycle, shared preparedness/API, Companion UX,
agent contract, or final oracle. Do not split repeated validators, routes, or
UI states into tiny tasks. Review at the Store contract, browser boundary, UX,
and final-oracle boundaries.

## Board Health

The PM owns board health. Check it with:

```bash
node /Users/neonwatty/.codex/plugins/cache/goalbuddy/goalbuddy/0.4.3/skills/goal-prep/scripts/check-goal-state.mjs docs/goals/resume-extraction-onboarding
```

If the local board is running, compare `state.yaml` to the live board API.
Repair only GoalBuddy control files unless the active Worker task allows product
edits.

## Canonical Board

Machine truth lives at:

`docs/goals/resume-extraction-onboarding/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for status, active
task, receipts, verification freshness, and completion truth.

## Run Command

From the isolated worktree:

```text
Codex: /goal Follow docs/goals/resume-extraction-onboarding/goal.md.
Claude Code: /goalbuddy Follow docs/goals/resume-extraction-onboarding/goal.md.
```

## PM Loop

On every continuation:

1. Read this charter, the approved spec and plan, the GoalBuddy execution
   contract, and `state.yaml`.
2. Work only on the active task and respect its allowed files and stop rules.
3. Record a compact receipt and update board truth after every task.
4. Re-run the relevant oracle layer after every Worker package.
5. Continue immediately to the next largest safe task unless a phase/risk/final
   review is due.
6. Before ending, run GoalBuddy's `check-can-stop.mjs`; continue if safe work
   remains.
7. Mark the goal complete only after T999 records
   `full_outcome_complete: true` against the full oracle.
