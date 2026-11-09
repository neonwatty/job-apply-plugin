# Native Store Authority Facades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task.

**Goal:** Implement Python-compatible native Trusted Fill, replay-transition, and attention-approval command facades while preserving one authority implementation.

**Architecture:** The CLI leaf delegates Trusted Fill to the existing service with explicit projection/consumption modes, aliases attention approval names to grouped approval behavior, and delegates replay to a pure service over a narrow locked repository interface. Shared Store and dispatcher composition remain integration-owned.

**Files owned by this tranche:**
- Create `src/cli/native-authority.ts`
- Create `src/workspace-core/replay-transition.ts`
- Modify `src/workspace-core/trusted-fill.ts`
- Generate matching runtime modules
- Create `tests_js/workspace_native_authority_cli.test.mjs`
- Create `tests_js/workspace_native_replay_transition.test.mjs`

**Do not modify:** `src/cli/native-jobs.ts`, `src/store/native-jobs.ts`, grouped-approval source, existing tests, catalogs, matrix, review lock, launcher, or skills.

## Task 1: Make Trusted Fill compatibility explicit

- [ ] Differentially test approve/status/evaluate/revoke including private Store CLI records, repeats, stale revisions, claim drift, final-action denial, and denial handoff.
- [ ] Extend `TrustedFillService` with explicit projection and consumption options; preserve current HTTP defaults exactly.
- [ ] Configure Store CLI evaluation to match Python's private, non-consuming behavior without forking authority logic.

## Task 2: Add approval aliases

- [ ] Expose `attention-approval-preview` and `attention-approval-approve` through delegation to the existing grouped approval leaf.
- [ ] Differentially test both spellings, complete option grammar, owner confirmation, stale preview, and Python-compatible integer spellings.

## Task 3: Implement replay transition

- [ ] Differentially test only `started` and `reviewed`, all four supported ATS values, required ordering, idempotence, terminal and ATS mismatch denials.
- [ ] Implement a pure replay service over session/history repository operations, using existing claim-session/history validators.
- [ ] Repair a history-only interrupted write by recreating the session; keep persisted records free of URL, route token, resume path, browser state, and answer values.

## Task 4: CLI leaf and verification

- [ ] Export a closed command set for the four Trusted Fill commands, replay transition, and the two approval aliases.
- [ ] Preserve Python parsing, input/error ordering, result envelopes, and authority lifecycle.
- [ ] Generate runtime JavaScript; run focused and existing Trusted Fill/grouped approval tests, typecheck, build parity, size, and diff hygiene.
- [ ] Commit only owned files and report exact repository/dispatcher adapter needs.

