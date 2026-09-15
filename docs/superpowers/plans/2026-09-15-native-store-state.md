# Native Store Compatibility State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task.

**Goal:** Implement native command leaves for history, standalone sessions, profile preparedness, and `resume-create` with Python-compatible envelopes and durable behavior.

**Architecture:** Pure workspace services implement command semantics behind narrow repository interfaces. A CLI leaf owns parsing and envelopes. The integration branch later supplies one locked `NativeJobsRepository` adapter and shared dispatch registration.

**Files owned by this tranche:**
- Create `src/workspace-core/store-history.ts`
- Create `src/workspace-core/store-sessions.ts`
- Create `src/workspace-core/profile-preparedness.ts`
- Create `src/cli/native-store-state.ts`
- Generate matching `runtime/` modules
- Create `tests_js/workspace_native_history_cli.test.mjs`
- Create `tests_js/workspace_native_sessions_cli.test.mjs`
- Create `tests_js/workspace_native_preparedness_resume_create_cli.test.mjs`

**Do not modify:** `src/cli/native-jobs.ts`, `src/store/native-jobs.ts`, store layout/clone/writer switch, existing services/tests, catalogs, matrix, review lock, launcher, or skills.

## Task 1: Pin history semantics

- [ ] Differentially test `history-append` closed input, generated fields, the eleven current writable event names, answer-key resolution, collisions, and Python error ordering.
- [ ] Test `history-list` future value-free events, malformed line numbers, byte-preserving reads, concurrency, and rollback after partial append.
- [ ] Implement through a narrow history repository interface using existing validators and crash-safe JSONL behavior; keep future-event tolerance read-only.

## Task 2: Pin standalone session semantics

- [ ] Test modern save/load/list/delete, privacy, deterministic ordering, stable references, canonical active-job mutation denial, terminal deletion, missing deletion, and concurrency.
- [ ] Test legacy projection, mixed/colliding fields, ATS inheritance/clearing, ignored non-JSON directory entries, symlinks, and identity swaps without rewriting legacy bytes.
- [ ] Implement pure session operations behind a repository interface, reusing persisted validation and claim-session construction where compatible.

## Task 3: Implement preparedness and resume creation

- [ ] Differentially test every preparedness reason code and ordering across profile, managed-resume observation, extraction requests/proposals, and user provenance; assert value/path/digest redaction.
- [ ] Implement the value-free preparedness projection with existing validators and observation interfaces.
- [ ] Test `resume-create` input-embedded path, import/default behavior, duplicate ID/content, source identity swap, format/size limits, crash recovery, filename preservation, and failure ordering.
- [ ] Wrap the existing `ResumeService.import` with `preserveFilename=true` through a narrow repository interface.

## Task 4: CLI leaf and verification

- [ ] Export a closed command set for `history-append`, `history-list`, `profile-preparedness-get`, `resume-create`, `session-save`, `session-load`, `session-list`, and `session-delete`.
- [ ] Preserve Python option grammar, stdin/file input normalization, result envelopes, and initialization requirements as explicit adapter preconditions.
- [ ] Generate runtime JavaScript; run focused tests, typecheck, build parity, size, and diff hygiene.
- [ ] Commit only owned files and report any exact adapter needs to the integration owner.

