# Testing locally

Use the smallest tier that answers the question, while keeping the specialized
commands in `package.json` for focused diagnosis.

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
  contracts. Network link checks remain in the release tier.
- `test:affected` adds every suite that owns committed, staged, unstaged, or
  untracked paths. Renames select both names. A global or unknown path safely
  selects the complete deterministic tier.
- `test:full` runs every portable Python and Node test file exactly once across
  bounded concurrent shards.
- `test:platform` runs the applicable OS-specific contract suite. Suites for
  other operating systems are reported as skipped.
- `test:release` runs the existing package smoke and network link checks. Later
  CI work will add explicit installed-package, upgrade, browser, and privacy
  evidence suites.

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
complete. Activation still requires the planned observation window with zero
omitted failures. Performance limits remain targets until enough warm local and
CI receipts exist to calculate percentiles.

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

Required Windows and deterministic macOS contracts remain on pull requests.
Visible live-browser/native observations are advisory in the scheduled or
manual nightly workflow. Release installation evidence runs nightly and for
staging/main, version tags, and manual dispatch. No CI timing percentile or
observation-window completion is claimed yet; current timings are individual
local measurements.
