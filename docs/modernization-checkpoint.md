# Modernization checkpoint — 2026-09-04

Implementation checkpoint: `cefef84` on `codex/codebase-modernization`.
At that checkpoint, changes were local; no remote push or branch-protection
change had been performed. Publication progress is recorded below.

## Completed

- All 448 scoped source/test/script files are at most 500 physical lines.
  The size-exception inventory is empty. Enforcement covers Python,
  JS/JSX/MJS/CJS, TS/TSX/MTS/CTS, Swift, and shell.
- Store facade reduced from 11,465 lines to 365, preserving its 98-command
  contract. Domain methods, startup, CLI, compatibility adapters, and
  composition have explicit module boundaries and reviewed runtime bindings.
- Workspace server and browser entry points are split into focused modules.
  The smoke shell is 107 lines; installed-byte verification recursively checks
  Store modules, workspace server modules, and browser assets.
- Fast, affected, full, platform, and release testing tiers are implemented,
  with bounded concurrency, exact test-file ownership, conservative fallback,
  timeouts, bounded output, and private machine-readable receipts.
- CI shadow workflows and a fail-closed aggregate gate are implemented locally.
  Existing required execution remains intact pending equivalence evidence.
- TypeScript migration plan reflects current modules, 98 commands, parallel
  ownership, runtime/packaging gates, retained Swift, and atomic writer cutover.

## Accepted local verification

| Check | Result |
| --- | --- |
| Source policy and test matrix | Passed; zero size exceptions; 15 suites |
| Fast tier | All 4 suites passed; 47 Python and 19 Node tests; longest shard about 3 seconds |
| Full deterministic tier | All 11 suites accepted after targeted reruns; 1,094 Python and 126 Node tests across the final accepted suite versions |
| Local macOS platform contracts | 26 tests passed; other OS execution is not claimed |
| Release tier | Both suites passed: link checks and installed-package smoke |
| Packaged browser journeys | All 3 passed |
| Installation/upgrade | Isolated Claude and Codex fresh installs, Codex upgrade, and recursive critical-byte parity passed |

The initial combined full run was **not** green: it found three stale exact
domain/MRO inventories and two onboarding-oracle failures caused by reading the
old browser entry file. Inventories were extended without weakening assertions;
the oracle now checks the extracted helper containing the same grouping logic.
The entire affected Store/workspace shard then passed 543 tests, and the QA
shard passed 336 tests with 2 expected skips. The final policy-extension change
was separately covered by the passing fast tier. This is converged suite
evidence, not a claim of one pristine full rerun or a measured CI percentile.

Local receipts are under `/tmp/` with the prefix
`job-apply-modernization-final-`: `fast.json`, `full.json`,
`qa-rerun.json`, `platform.json`, and `release.json`.
The workspace rerun receipt is
`/tmp/job-apply-python-workspace-contracts-receipt.json`.
The original failing full receipt is intentionally retained.

## Remaining gates

1. Review the published changes and collect actual cross-platform CI evidence.
2. Keep the temporary legacy CI lane until at least 20 PR runs show no
   unexplained divergence. Keep affected selection in shadow for two weeks
   with zero omitted failures before narrowing required execution.
3. Collect enough warm local and CI receipts to assess the performance targets;
   individual local timings do not establish p95 or remote CI speedups.
4. Before TypeScript cutover, resolve supported Node/standalone launch behavior
   in fresh supported installations, freeze differential vectors, then execute
   the staged migration plan. Python and TypeScript must never write the same
   live Store. The TypeScript port has not started.

## Publication and CI follow-up — 2026-09-05

[PR #47](https://github.com/neonwatty/job-apply-plugin/pull/47) targets `staging`.
It is not merged; branch protection and release settings remain unchanged.
The first cross-platform runs exposed test-fixture assumptions that local
macOS verification did not establish:

- Frozen AST checks now normalize empty interpreter-version metadata while
  retaining the original hashes and meaningful language/control-flow changes.
- Native line endings, storage-mode parity, and regular-file race injection
  replace POSIX-only fixture assumptions without changing persisted data.
- Paired Store comparisons normalize only cloned root paths before escaping
  and share clocks rather than assuming operations finish in the same second.
- Browser walkthroughs must await the relevant canonical request and UI state,
  not merely a click or a success message left over from an earlier operation.

Focused local verification and passing individual CI jobs are not a substitute
for a green aggregate run. The PR's current-head checks are the acceptance
source of truth. Failed and superseded runs are retained as diagnostic evidence;
they do not satisfy the legacy-lane or affected-selection observation gates.
