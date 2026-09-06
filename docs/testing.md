# Testing locally

Use the smallest tier that answers the question, while keeping the specialized
commands in `package.json` for focused diagnosis.

Run `npm ci` in a fresh development checkout. TypeScript is a pinned development
dependency, not an installed-plugin dependency. `npm run typecheck` checks the
shadow scaffold; `npm run build:runtime` updates its one-to-one checked-in ESM
output, and `npm run build:check` rejects missing, changed, stale, mapped or
oversized output. Build errors leave the previous runtime intact; stale files
require explicit review/removal. Existing application launchers still use Python.

Install the staged commit and outgoing push hooks with `npm run hooks:install`.
See the [local hook protocol](local-testing-protocol.md) for escalation and
24-hour deep-validation receipt reuse.

## Supported tiers

```text
npm run check:size
npm run test:fast
npm run test:affected -- --base origin/staging
npm run test:full
npm run test:platform
npm run test:release
```

- `test:fast` is the default pre-commit check. It covers source policy, matrix
  integrity, documentation safety, runner behavior, and inexpensive Python
  contracts, plus strict TypeScript checking, reproducible build contracts and
  runtime-probe tests. Network link checks remain in the release tier.
- `test:affected` adds every suite that owns committed, staged, unstaged, or
  untracked paths. Renames select both names. A global or unknown path safely
  selects the complete deterministic tier.
- `test:full` runs every portable Python and Node test file exactly once across
  bounded concurrent shards.
- `test:platform` runs the applicable OS-specific contract suite. Suites for
  other operating systems are reported as skipped.
- `test:release` runs package smoke and network link checks. The smoke harness
  covers isolated Claude/Codex installs, Codex upgrades, packaged browser/API
  walkthroughs, privacy assertions, and recursive critical-file byte parity.

Pass `--receipt path/to/receipt.json` to record selection, status, and elapsed
milliseconds. Receipts intentionally omit commands, output, and environment
variables. Pass `--concurrency N` to lower the default bounded concurrency.
Each suite has a 15-minute process timeout and separate 2 MiB stdout/stderr
limits. Node test files remain serial within each parallel shard until repeated
evidence supports raising their internal concurrency.

## Ownership and fallback

`config/test-matrix.json` is the source of truth. The checker rejects missing
suite references, nonexistent repository command paths, unowned executable or
test paths, and any duplicate or omitted deterministic test file. Changing the
matrix, runner, package scripts, lockfile, or workflows selects the full tier.
Production ownership is initially conservative and heuristic; affected mode is
local selection evidence, not yet an affected-safe CI gate.

Affected selection is initially local evidence, not proof that CI shadowing is
complete. Activation still requires two weeks of selection shadowing with zero
omitted failures; an omitted failure requires correcting ownership and restarting
the observation window. Performance limits remain targets until enough warm
local and CI receipts exist to calculate percentiles.

## Parallel implementation and verification

Use the extracted module boundaries for bounded assignments: Store domain
subtrees in `scripts/job_apply_store/domains/`, workspace server/domain modules
in `scripts/job_apply_workspace/`, browser libraries/features in `workspace/`,
and smoke helpers in `scripts/smoke/`. The Store CLI contract covers 98 commands.
Compatibility adapters preserve live replacement seams and root-local loading;
changes there require facade, startup, and loader checks as well as domain tests.

Each parallel worker owns explicit files and focused tests in an isolated
worktree. One integration owner controls shared facade/bootstrap composition,
test-matrix ownership, package scripts, workflows, and installed inventories.
Workers report immutable revisions and test receipts; an independent reviewer
checks each result. Run broader deterministic and package verification at
integration points, repeating it only after relevant changes or failures.

TypeScript migration uses the same ownership rules, but its runtime/platform
launch gate remains unresolved. Differential writers must use separate cloned
Stores. Python and TypeScript must never write the same live Store; read-only
tests must also detect initialization, repair, and recovery side effects.

## Timing interpretation

Runner summaries are measurements from that invocation only. The modernization
targets are fast p95 at most 30 seconds, affected p95 at most 90 seconds, and
full CI p95 at most five minutes. Do not describe a single run as a percentile
or as completion of the CI observation window.

## CI shadow mode

Pull requests still run the retained `validate` job and every new deterministic
Python and browser shard. The duplicate legacy lane is temporary equivalence
evidence, not an optimization: remove it only after at least 20 PR runs show no
unexplained divergence. The `classify` job records affected-suite selection but
does not skip full shards, and `PR gate` rejects any failed, cancelled, skipped,
or missing selected job.

The 20-PR equivalence gate and two-week affected-selection observation are both
pending external evidence. Local test receipts and merged workflow code cannot
mark either gate complete.

Required Windows and deterministic macOS contracts remain on pull requests.
Visible live-browser/native observations are advisory in the scheduled or
manual nightly workflow. Release installation evidence runs nightly and for
staging/main, version tags, and manual dispatch. No CI timing percentile or
observation-window completion is claimed yet; current timings are individual
local measurements.
