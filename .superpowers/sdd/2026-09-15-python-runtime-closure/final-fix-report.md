# Final review fix report

Date: 2026-09-15

Worktree: `/Users/neonwatty/Desktop/job-apply-plugin/.worktrees/python-runtime-closure`

## Decision

Defer ordinary native routing. Source/GitHub marketplace packages do not contain
a verified flock addon, and native bootstrap is not an exclusive activation path
for canonical Python Stores. Replacing commands in skills cannot safely supply
either prerequisite. The supported ordinary route is again the complete Python
writer process family; there is no native-to-Python command fallback.

This deliberately supersedes the prior Task 2–5 native-first routing/completion
claims in the ledger and Task 5 report. Runtime closure and migration acceptance
remain open. Retained native commands are preparation/rehearsal surfaces only.

## Findings addressed

1. **P1 initialization/activation:** Restored all Store, task, attempt, policy,
   workspace, and helper skill commands together. Source-package tests initialize
   a genuinely fresh Store through the documented command and read its profile
   and task snapshot. A second case starts from an existing Python Store, checks
   exact profile bytes, and verifies no native marker appears. No existing Store
   is marked as native, moved, or shared between writer implementations.
2. **P1 installability:** Restored the Python attempt fixed critical artifact and
   Python attempt smoke route, with the matching TypeScript/Python inventories,
   reference fixtures, and expectations. Source-package tests copy actual tracked
   source assets and verify the packaged-lock directory contains only README.md.
   They run documented commands with empty PATH and absolute existing interpreter
   paths, without assembling, compiling, or downloading any addon.
3. **P2 resume contract:** Restored the Python Store invocation for every resume
   command. Both source-package cases successfully run the documented
   `resume-import --input` shape with `{id, label, path}`. The returned record has
   the requested identity and does not expose the import source path.
4. **P2 home-relative configuration:** Native Jobs and task default-root handling
   now expands `~` and `~/` using the resolved home directory before resolving
   the configured path. Separate assembled/prepared native fixtures verify
   `JOB_APPLY_STORE_DIR='~/.job-apply'` without Python on PATH. Absolute configured
   Stores remain independent of a missing HOME directory.

The native attempt broker hard-link ownership guard remains intact. Prepared
native packaged-addon discovery remains available. No marker validation was
weakened, no runtime compilation/download was introduced, and explicit
whole-process Python rollback, manual final submission, privacy, and CLI
revision/envelope boundaries remain unchanged.

## RED/GREEN evidence

Before production edits, `node --test tests_js/native_installed_entrypoints.test.mjs`
reported 2 passing existing prepared-native cases and 4 failing new cases:

- Native Jobs with the tilde Store failed with exit 1 and the redacted fixture
  error.
- Native task with the tilde Store failed with exit 2 and `store_unavailable`.
- Fresh source-package documented init failed with exit 1 because the ordinary
  route required an unavailable packaged addon.
- Existing Python source-package documented init failed at the same unavailable
  addon boundary after successful Python setup of the disposable Store.

The first draft existing-Store fixture omitted `qa` dependencies; that fixture
error was corrected before recording the above RED run. No production edits
were made until all four failures represented the reported behavior.

After routing restoration, the root expansion fixes, and deterministic runtime
regeneration, all 6 installed-entrypoint cases passed. Native fixtures use
`initializeJobsFixture` only in the explicitly assembled/prepared cases; the
ordinary source-install cases never use it.

Self-review added two RED cases for an absolute configured Store with nonexistent
HOME. Both initially failed because home realpath resolution was unconditional.
The fixtures use canonical absolute roots (normalizing the macOS `/var` symlink).
Resolving HOME only for tilde/default configuration made both pass. The final
installed-entrypoint suite passes all 8 cases.

## Verification

- Focused combined Node run: 159 tests, 155 passed, 4 failed solely because this
  host's default `python3` is 3.9.6 while artifact reference profiles require
  3.12–3.14. All versioned 3.12/3.13/3.14 cases passed.
- Reran artifact copy order, artifact metadata, data-only copy, and installed
  artifact reference suites with the existing Homebrew Python 3.12 first on
  PATH: 22 tests passed, 0 failed.
- The combined run also passed native attempt lifecycle/protocol, policy
  reference/concurrency/CLI, installed artifact TypeScript parity, workspace
  markup, runtime closure, and all installed-entrypoint regressions.
- Native Jobs parity and raw answer-matching rerun with installed Python 3.13:
  22 passed, 1 existing unfrozen-profile case skipped, 0 failed. This confirms
  the broad native Jobs URL/parser and raw-reference failures were interpreter
  differences, not root-resolution or routing changes.
- Python skill, application contract, and resume suites: 19 passed.
- Migration inventory unit tests: 9 passed.
- `npm run build:check`: passed, 217 generated modules match.
- `npm run typecheck`: passed.
- `npm run check:size`: passed; no source-size exception added.
- `npm run check:test-matrix`: passed, 29 suites.
- `git diff --check`: passed.
- `npm run check:migration` from clean commits `3c12e95` and `41c3fea`: passed with
  `inventory-consistent`, 8 entrypoints, historical audit passed, `errors: []`,
  and `acceptance: open`.
- `npm run test:affected -- --base origin/staging`: completed all 25 selected
  suites; aggregate result failed on the already recorded local interpreter and
  frozen-profile limitations. Failing suites were node-foundation-fast (1),
  native-frozen-reference-profiles (2), native-posix-lock (17, including nested
  failures), node-reference-s04 (3), node-reference-s05 (3), and
  node-workspace-other (80, including nested failures). The failure causes are
  default Python 3.9.6, alias/resolved executable disagreement, and unfrozen
  interpreter profiles including Python 3.12.14. No UI flake recurred.
  node-migration-evidence passed 42/42; native-default-cutover passed 82/82.
  The broad run began at `3c12e95`; after the small absolute-root follow-up,
  its directly affected entrypoint suite and all static/migration gates were
  rerun on `41c3fea`. No broad green result is claimed.
- Diagnostic logs are in `/tmp/runtime-closure-final-affected.log`,
  `/tmp/runtime-closure-final-migration-v2.log`,
  `/tmp/runtime-closure-supported-focused.log`, and
  `/tmp/runtime-closure-env-parity.log`.
- The full native-default-cutover suite passed 82/82 in the broad run before
  the two additional absolute-root cases; the final 8-case entrypoint suite and
  build/typecheck/size/matrix checks were rerun after that follow-up.

## Files and commits

Implementation commits:

- `3c12e95` — `fix: defer native routing until safe installed Store activation`.
- `41c3fea` — `fix: preserve absolute native Store configuration without HOME`.

Changed groups:

- All ordinary shipped `skills/**` command/reference routes and README runtime
  description; migration status and governing plan.
- `src/cli/native-jobs.ts`, `src/cli/task-runner.ts`, and generated runtime.
- TypeScript and Python installed-artifact inventories; smoke attempt route;
  matching artifact reference/support tests and skill/markup contracts.
- `tests_js/native_installed_entrypoints.test.mjs` source-install and native-root
  regressions; existing test matrix registration retained.
- Existing migration source catalog shards and review-lock hashes reconciled
  only for the changed source/runtime assets; closure manifest restored to its
  eight currently referenced Python entrypoints.

The complete implementation file list is `git diff --stat 4b8fa70..41c3fea`.

## Remaining concerns

- Native Store `init` is still preparatory and does not activate canonical state.
  It is not a shipped ordinary skill route and must not be used to convert an
  existing live Python Store in place.
- Future cutover requires a tested assembled installer, complete native fresh
  initialization, exclusive preparation/activation/rollback with full writer
  process-group quiescence, and every documented CLI contract checked together.
- This change does not claim Python-free installation or migration acceptance.
- The broad affected gate is not green on this host. Its interpreter/profile
  issues must be resolved in the validation environment before claiming a clean
  full-platform result. The default local Python alias remains an environment
  issue; no interpreter
  installation or global PATH configuration was changed.
