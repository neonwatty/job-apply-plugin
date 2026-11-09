# Ready Job Agent Handoff

## Objective

Connect canonical jobs marked `ready` to the existing visible-browser application workflow through one shared, durable, concurrency-safe handoff that advances job status without weakening the human final-submit boundary.

## Original Request

Continue with the Ready Job Agent Handoff slice after canonical job ingestion was merged into staging.

## Intake Summary

- Input shape: `existing_plan`
- Audience: Job Apply users coordinating with Codex or Claude Code agents
- Authority: `approved`
- Proof type: `test`
- Completion proof: An integration test and documented CLI walkthrough prove that an agent can select a ready job, acquire exclusive application ownership, load its assigned durable data, record value-free blockers or progress, reach awaiting review, and release ownership safely.
- Goal oracle: The normal job-application skill completes the shared ready-job lifecycle against an isolated durable store while concurrency, stale-claim recovery, privacy, optimistic revision, and manual-submit tests remain green.
- Likely misfire: Building a second agent-state or queue system that can drift from the canonical job status, or adding orchestration primitives without wiring the real application skill to use them.
- Blind spots considered: stale/crashed agents, concurrent CLI and future UX clients, assigned versus default resume selection, sensitive-answer consent, value-free pending questions, resumable sessions, compatibility with direct-URL application, and status recovery after partial failure.
- Existing plan facts: Durable storage precedes UX; canonical job ingestion is merged into `staging`; next is Ready Job Agent Handoff; the companion UI remains out of scope for this tranche.

## Goal Oracle

The oracle for this goal is:

`A tested end-to-end helper and skill walkthrough moves one canonical job through ready -> in_progress -> needs_info or awaiting_review under one exclusive recoverable runtime claim, uses the assigned/default resume and existing profile/answer/session contracts, records no answer values in claim/history/session metadata, releases the claim, and never activates the final action.`

The PM must keep comparing task receipts to this oracle. Planning, discovery, isolated helper tests, or documentation alone are not enough. The goal finishes only when a final Judge/PM audit maps receipts and verification back to this oracle and records `full_outcome_complete: true`.

## Goal Kind

`existing_plan`

## Current Tranche

Deliver the complete Ready Job Agent Handoff vertical slice: validate the merged contract and current application workflow, implement the smallest coherent claim and pending-question/status integration required by the oracle, wire the Job Apply skill to consume ready jobs while retaining direct-URL compatibility, and verify the real lifecycle. Do not begin the companion UX or legacy Markdown migration in this tranche.

## Non-Negotiable Constraints

- The canonical job record remains the only durable application status; do not create a second agent-status model.
- Exactly one live application runtime claim may exist across CLI and future UX clients.
- Claim acquisition and the `ready` to `in_progress` transition must be atomic or fail without partial mutation.
- Stale claim recovery must be explicit, bounded, deterministic, and tested.
- Human-authored job fields and optimistic revisions remain authoritative.
- Assigned resume wins; otherwise use the active default resume. Missing or changed files fail readiness safely.
- Pending-question and progress metadata remain value-free and refer to answer keys where applicable.
- Sensitive current-use consent remains separate from remember consent.
- The visible-browser workflow and hard stop before Submit, Send, Apply, or equivalent final action remain unchanged.
- Existing direct-URL application behavior and version-1 durable stores remain compatible.
- The local companion UX, Markdown queue migration, answer merging, and resume extraction proposal UI are out of scope.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

Do not stop after planning, discovery, or Judge selection if a safe Worker task can be activated. Do not stop after isolated storage primitives if the job-application skill and integration oracle are not complete.

## Slice Sizing

Safe means bounded, explicit, verified, and reversible. It does not mean tiny. Prefer one coherent storage-and-skill vertical slice over separate micro-tasks for each helper command.

## Board Health

Machine truth lives in `state.yaml`. Use the bundled GoalBuddy checker when board state is changed or before completion.

## Canonical Board

`docs/goals/ready-job-agent-handoff/state.yaml`

## Run Command

```text
Codex: /goal Follow docs/goals/ready-job-agent-handoff/goal.md.
Claude Code: /goalbuddy Follow docs/goals/ready-job-agent-handoff/goal.md.
```

## PM Loop

On every execution continuation, read this charter, the GoalBuddy execution contract, and `state.yaml`; work only the active task; persist a compact receipt; keep advancing safe work; and run the stop checker before declaring completion.
