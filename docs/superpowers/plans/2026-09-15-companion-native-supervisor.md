# Companion Native Default Supervisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task.

**Goal:** Make the installed Companion choose the native writer by default under one process-owned lifecycle, with explicit atomic Python rollback and no silent fallback.

**Architecture:** A new outer `supervise.mjs` resolves the ordinary Store root, acquires the lifetime writer lease, prepares or recovers native state, and owns the complete inner Companion process group. `launch.mjs` remains the inner Store/Next service and inherits lease fd 3. `writer-route.mjs` becomes an explicit inner route resolver. The supervisor refuses activation or rollback while a detached attempt broker is live unless a future explicit quiescence protocol proves it stopped without releasing its claim.

**Files:**
- Create `apps/companion/supervise.mjs`
- Modify `apps/companion/launch.mjs`
- Modify `apps/companion/writer-route.mjs`
- Modify if required `src/store/process-owned-writer.ts`
- Generate `runtime/store/process-owned-writer.js`
- Create `tests_js/companion_default_cutover.test.mjs`

## Task 1: Pin routing and failure semantics

- [ ] Write failing tests for empty first run, initialized Python Store, prepared candidate, native restart, concurrent supervisors, and root precedence (`--root`, environment, home default).
- [ ] Require a no-flag invocation to serve native `/api/boot` only after preparation, activation, and native readiness succeed.
- [ ] Test lock/addon/readiness failure, controller death, and every activation interruption boundary; assert the invocation fails and never serves Python as an implicit fallback.
- [ ] Test an existing native-active Store restarts native without rebuilding or touching retained Python bytes.

## Task 2: Separate outer ownership from inner launch

- [ ] Keep Store server and Next composition in `launch.mjs`; reject direct lifecycle-changing use without `COMPANION_PROCESS_OWNER=process-group-v1` and inherited fd 3.
- [ ] Make `supervise.mjs` the sole lifecycle owner, with a process group containing the inner launcher, Store server, Next server, and descendants.
- [ ] Preserve readiness JSON and browser-open behavior without logging private paths or bearer tokens.
- [ ] Prove signals and controller death stop the complete process group before lease release or directory movement.

## Task 3: Implement native default activation

- [ ] Resolve and validate the ordinary root, lock artifact, installed runtime, and current switch state before spawning a writer.
- [ ] Initialize an empty root or validate/clone an existing Python Store through the Task 2 bootstrap and canonical clone APIs.
- [ ] Recover interrupted switch states, start owned Python only when activation requires quiescing the legacy writer, activate under both Store digests, then start native.
- [ ] Refuse live detached attempt-broker metadata before activation; preserve its Store claim and return a stable actionable error.

## Task 4: Implement explicit rollback

- [ ] Add an explicit supervisor rollback option with closed parsing and reject ambiguous/missing retained state.
- [ ] Quiesce the complete native process group, refuse a live detached attempt broker, call atomic rollback, and start Python only after recovery establishes Python-active state.
- [ ] Preserve the post-write native directory and verify native-only mutations remain there while the restored Python tree is byte-identical to its pre-activation snapshot.
- [ ] Test rollback interruption boundaries and restart recovery.

## Task 5: Verify

- [ ] Run `companion_default_cutover`, writer-switch rehearsal, process-owned quiescence, attempt lifecycle, and existing writer-route tests serially with no skips on POSIX.
- [ ] Run Companion and root typechecks, runtime generation/check, size, and diff hygiene.
- [ ] Record installed-runtime assumptions and any OS deferrals; do not update shipped skills or migration claims in this tranche.

