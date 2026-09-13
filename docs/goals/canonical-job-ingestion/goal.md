# Canonical Job Ingestion

## Objective

Create one safe, idempotent ingestion path through which humans, job-search output, and browser agents can preview and commit job records into the existing durable store without duplicates or loss of human-authored data.

## Original Request

Plan the next appropriate slice after the durable shared store, using Goal Prep, so the CLI and future UX share the same job information.

## Intake Summary

- Input shape: `existing_plan`
- Audience: job seekers using the CLI directly or supervising an agent through the future UX
- Authority: `approved`
- Proof type: `test` and `demo`
- Completion proof: automated ingestion tests pass and a clean temporary-store CLI walkthrough demonstrates preview, commit, repeat ingestion, conflict handling, and preservation of human edits
- Goal oracle: the same representative job can enter from human and structured agent inputs, appear once in the canonical store, retain human edits after re-ingestion, and remain readable by existing CLI job commands
- Likely misfire: adding low-level upsert helpers that pass tests but do not form a usable human-and-agent ingestion workflow, or expanding into migration, claiming, or frontend work
- Blind spots considered: identity conflicts between normalized URL and source ID; partial discoveries; provenance; no-op repeat imports; preview/commit drift; privacy, locking, and atomicity; legacy Markdown migration scope
- Existing plan facts: the shared-workspace spec and durable store are already committed and pushed on `codex/shared-job-workspace`; canonical jobs, profile facts, resumes, readiness, and answers CRUD already exist; the selected next slice is canonical ingestion; completion requires tests plus a CLI demo; historical Markdown migration is excluded

## Goal Oracle

The oracle for this goal is:

`In an isolated temporary store, preview and commit representative human and agent job inputs; repeating either input creates no duplicate, conflicting identities are reported deterministically, human-authored edits survive later agent enrichment, provenance remains inspectable, and existing list/show behavior reads the resulting canonical record.`

The PM must keep comparing task receipts to this oracle. Planning, discovery, a passing tiny slice, or a clean-looking board is not enough. The goal finishes only when a final Judge/PM audit maps receipts and verification back to this oracle and records `full_outcome_complete: true`.

## Goal Kind

`existing_plan`

## Current Tranche

Deliver canonical job ingestion as one vertical CLI capability: validate the established plan against the current store contracts, implement preview and idempotent commit for human and structured agent inputs, connect current job-search guidance to that path, cover the merge and conflict rules, and demonstrate the completed round trip. This tranche ends at a verified CLI boundary; it does not build the frontend.

## Non-Negotiable Constraints

- Preserve backward compatibility for current store commands and data.
- Preview must not mutate durable data; commit must be atomic and safe under the store's existing locking model.
- Use stable identity rules based on canonical URL and supported source identifiers, with deterministic conflict reporting.
- Re-ingestion must be idempotent and must not overwrite human-authored fields with lower-authority agent or search data.
- Preserve field/source provenance sufficiently for later UX display and agent reasoning.
- Support incomplete discoveries without falsely marking them ready or applied.
- Keep private-store permissions and avoid placing sensitive user data in logs, receipts, or fixtures.
- Exclude historical Markdown migration, global agent claim/heartbeat behavior, browser automation changes, and frontend implementation.
- Do not publish, merge, or alter remote state unless separately authorized.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

Do not stop after planning, discovery, or Judge selection if a safe Worker task can be activated. Do not split the vertical ingestion workflow into a run of tiny helpers when one bounded Worker package can implement and verify it coherently.

## Slice Sizing

Safe means bounded, explicit, verified, and reversible. It does not mean tiny. The Worker package should finish the usable ingestion workflow, its store semantics, its job-search connection, and its tests together.

## Board Health

The PM owns board health. If the board looks stale or inconsistent, run:

```bash
node /Users/neonwatty/.codex/plugins/cache/goalbuddy/goalbuddy/0.4.3/skills/goal-prep/scripts/check-goal-state.mjs docs/goals/canonical-job-ingestion
```

## Canonical Board

Machine truth lives at:

`docs/goals/canonical-job-ingestion/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for task status, active task, receipts, verification freshness, and completion truth.

## Run Command

```text
Codex: /goal Follow docs/goals/canonical-job-ingestion/goal.md.
Claude Code: /goalbuddy Follow docs/goals/canonical-job-ingestion/goal.md.
```

## PM Loop

On every `/goal` continuation, read this charter and `state.yaml`, follow the GoalBuddy execution contract, work only on the active task, record its receipt, update the board, and continue through the next safe task until the final audit maps fresh proof to the oracle.
