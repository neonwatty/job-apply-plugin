# Codebase Modernization Design

**Date:** 2026-09-04

## Objective

Modernize Job Apply in three controlled stages:

1. Enforce a hard 500-physical-line maximum for tracked Python, JavaScript,
   MJS, CJS, TypeScript, TSX, Swift, and shell source and test files, then reduce
   every current violation to compliance.
2. Replace the current exhaustive inner loop with fast, affected, full,
   platform, and release test tiers without deleting safety evidence.
3. Move the application to TypeScript through a differential strangler
   migration, retaining only the Swift code that requires native macOS APIs.

The work preserves all public CLI behavior, stored bytes, privacy properties,
crash recovery, platform support, browser safety, and the human-only final
action boundary.

## Current Baseline

`origin/staging` at `9661d1a` contains 30 tracked source/test files above 500
lines: 23 Python, one JavaScript, four MJS, one Swift, and one shell file. The
largest are:

- `scripts/job-apply-store.py`: 11,465 lines.
- `tests/test_job_apply_store.py`: 9,276 lines.
- `tests_js/recorder.test.mjs`: 3,372 lines.
- `tests_js/workspace.test.mjs`: 3,095 lines.
- `workspace/app.js`: 2,562 lines.
- `scripts/qa-replay.py`: 2,510 lines.

The local full Python and serialized browser suites each take about 193–198
seconds. The browser suite passed locally in about 86 seconds when file-level
parallelism was restored. The latest sampled CI run spent 421 seconds installing
two npm packages on Linux and 379 seconds doing the same in a Mac job.

## Global Invariants

- A physical line is every newline plus a final non-empty unterminated line.
- The 500-line rule applies to production code, tests, test support, launchers,
  and checked-in runtime JavaScript. It does not apply to Markdown, JSON test
  fixtures, or third-party generated/vendor content.
- No minification, statement packing, comment deletion, or generated
  indirection may be used to evade the limit.
- New files must be at most 500 lines from the first enforcement PR.
- Existing violations may never grow. Every reduction lowers its recorded
  ceiling; reaching 500 removes the exception permanently.
- Existing CLI paths, arguments, JSON stdout, redacted stderr, exit behavior,
  HTTP contracts, and plugin skill instructions remain compatible until a
  separately approved major-version cutover.
- Persisted schema version 1 documents must remain readable and byte-preserved
  on rejected, corrupt, or future-version input.
- Files and directories retain current private permissions, symlink/reparse
  defenses, atomic replacement, parent-directory fsync, and journal recovery.
- Claim authority, credentials, applicant values, browser identity, paths,
  URLs, tokens, and private Store data must not enter logs or test artifacts.
- Final submission remains human-only.
- Visible-browser and live OS observations may be advisory; their deterministic
  contracts remain required.
- Python and TypeScript writers must never mutate the same live Store during
  migration.
- All new TypeScript and retained Swift files must remain at most 500 lines.

## Delivery Order

The numbered product goals are preserved, but their execution overlaps safely:

1. Land the size-policy ratchet and baseline.
2. Build the fast and full test runners while low-coupling test files and leaf
   modules are split in parallel.
3. Use the faster tiers to decompose the Store, workspace, replay, browser, and
   native modules until the size baseline is empty.
4. Freeze behavioral contracts and introduce TypeScript in shadow mode.
5. Port pure functions, UI/browser code, and read-only Store behavior first.
6. Port mutations on cloned Store fixtures and switch all canonical writers in
   one atomic release gate.
7. Port the attempt broker, replay filesystem, promotion, and final-action
   policy last; then remove Python compatibility launchers in a major release.

This order avoids spending the entire refactor under the current slow feedback
loop and avoids two runtimes competing for the Store lock.

## Parallel Execution Model

Use one integration lead, independent workers, and fresh reviewers. A worker
owns one bounded file family; no worker may broaden its ownership without the
integration lead updating the dependency map first.

| Wave | Parallel worker packages | Merge rule |
|---|---|---|
| 0: guardrail | Size checker/baseline; test inventory receipt | Land the ratchet first; inventory is read-only until then |
| 1: feedback | Test runner/matrix; Python test families; MJS test families; QA leaf modules | Each package must pass focused tests and lower its own baseline ceilings |
| 2: decomposition | Policy/matching; recorder; promotion/replay; Chrome; Swift; smoke families | Merge independent leaves continuously; do not batch them into one mega-PR |
| 3: choke points | One Store-facade owner; Store domain workers after common interfaces stabilize; one workspace-bootstrap owner plus UI feature workers | Only the designated owner edits each facade/bootstrap; domain workers consume frozen interfaces |
| 4: TypeScript shadow | Contracts/runtime; pure answers; accounts; UI; recorder; Store reads | Python stays authoritative; every lane compares frozen vectors |
| 5: TypeScript state | Atomic storage owner; job/resume mutation workers on cloned Stores; attempt/native worker; QA/policy workers | Never point Python and TS writers at the same live Store |
| 6: cutover | One release integrator, platform verifiers, privacy/rollback verifier | Switch all canonical writers together, observe, then remove Python |

The initial implementation can keep eight to ten workers productive by
queueing independent packages, even if only a smaller number run concurrently.
Every implementation package gets a requirements review before merge and a
code-quality review after tests pass. Failed integration returns only to the
owning worker; unrelated lanes continue.

## Source-Size Enforcement

The initial policy uses `.source-size-baseline.json` as a monotonic ratchet.
Each entry records the exact path, current ceiling, owner, reason, and removal
phase. The checker compares the working tree with the merge-base baseline:

- A new oversized source file fails and cannot be added to the baseline.
- A baseline ceiling may decrease but never increase.
- A file below its recorded ceiling requires the ceiling to decrease in the
  same change.
- A file at or below 500 requires removal from the baseline.
- A removed or renamed file requires removal of the obsolete entry.
- Unknown extensions or excluded paths are explicit configuration errors.

Repository `AGENTS.md` will require every worker package touching an oversized
file to name at least one extraction target in `allowed_files`. This reverses
the current incentive to append to the one large file the task happens to own.

## Test Architecture

The supported local interface becomes:

```text
npm run check:size
npm run test:fast
npm run test:affected -- --base origin/staging
npm run test:full
npm run test:platform
npm run test:release
```

| Tier | Purpose | Warm target |
|---|---|---:|
| Fast | Size, syntax, contracts, pure unit tests, docs | p95 <= 30s |
| Affected | Fast plus every suite owning changed paths | p95 <= 90s |
| Full | Every deterministic portable suite exactly once | CI p95 <= 5m |
| Platform | Windows and deterministic native Mac contracts | p95 <= 5m |
| Release | Installed bytes, upgrades, browsers, package/privacy | p95 <= 15m |

Every tracked executable/test path is owned by `config/test-matrix.json`.
Unmapped or global changes fail closed to the full tier. Selection runs in
shadow mode against the full suite before becoming merge-gating.

GitHub Actions uses one stable required aggregate check, `PR gate`, while
shards evolve beneath it. Existing required check names remain protected until
the aggregate has proven equivalence and the repository ruleset is deliberately
updated. Superseded PR runs are cancelled, npm and Playwright downloads are
cached, deterministic jobs run in parallel, and visible Mac observations move
to scheduled/manual advisory evidence.

## Refactor Architecture

Compatibility entry points remain thin facades. Production implementations are
split by domain, not arbitrary line ranges:

- Store: IO/validation, profile/facts, answers, jobs, claims, resumes,
  extraction, history/sessions, accounts, and CLI dispatch.
- Workspace: auth/HTTP/projections plus domain routes; browser UI uses explicit
  context passed to independent feature controllers.
- QA: contracts, oracle, server, secure filesystem, replay lifecycle,
  promotion, recorder safety/capture, and Chrome supervision.
- Policy: models/storage, campaign, authorization, outcomes, and CLI.
- Swift: executable identity, bindings, Accessibility, reviewed form, browser
  identity, fixtures, and executor.
- Tests: shared support modules plus behavior-oriented files, never imports
  between test modules.

The Store facade and workspace context interfaces are single-owner integration
points. Leaf modules and test-only splits may proceed concurrently.

## TypeScript Target

The target contains TypeScript application code and retained Swift native
helpers:

```text
src/contracts/
src/domain/{answers,jobs,resumes,attempts,accounts}/
src/store/{documents,journals}/
src/cli/
src/workspace/
src/workspace-ui/
src/qa/
src/native/macos/
native/macos/*.swift
test/{unit,contract,integration,platform,acceptance}/
runtime/                 # reproducible one-to-one compiled ES modules
```

No bundle may recreate a generated monolith. The installed plugin must not run
`npm install`; it ships reproducible runtime modules or signed standalone Node
executables.

The migration freezes 90 Store subcommands, the task/attempt/QA/policy command
families, authenticated workspace routes, schema-version-1 documents, and
privacy/error projections as golden contracts. Python and TypeScript run on
separate cloned Stores with injected clocks and nonces. Read paths can cut over
incrementally; canonical mutation paths cut over together only after normal,
concurrent, crash, restart, permissions, corruption, migration, and rollback
equivalence passes on Linux, macOS, and Windows.

## Runtime Decision Gate

The current plugin promises Python availability and does not declare a Node
runtime requirement. Before any Python-free release, fresh supported Codex and
Claude installations must prove an accessible supported Node runtime. If that
cannot be guaranteed, the release must ship signed standalone executables per
supported OS/architecture. Retaining Python silently is not an acceptable final
state for this objective.

## Completion Criteria

- No scoped tracked source, test, launcher, or runtime file exceeds 500 lines.
- The baseline file is deleted and CI enforces the unconditional limit.
- A normal affected local test run completes at p95 <= 90 seconds.
- Green PR feedback reaches p50 <= 5 minutes and p95 <= 8 minutes.
- Full deterministic and release evidence remains scheduled and reproducible.
- Selection shadowing records zero omitted failures before activation.
- The packaged TypeScript implementation passes every frozen Python contract,
  concurrency/crash adversary, platform gate, privacy scan, and upgrade test.
- A previous stable package can read Store data written by the TypeScript
  release until an explicitly planned schema-version change.
- Python production and test files are removed; only necessary Swift remains.

## Implementation Plans

- `docs/superpowers/plans/2026-09-04-500-line-policy-and-refactor.md`
- `docs/superpowers/plans/2026-09-04-tiered-testing-and-ci.md`
- `docs/superpowers/plans/2026-09-04-typescript-strangler-migration.md`
