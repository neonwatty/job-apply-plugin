# Testing locally

Use the smallest tier that answers the question, while keeping the specialized
commands in `package.json` for focused diagnosis.

Run `npm ci` in a fresh development checkout. TypeScript is a pinned development
dependency, not an installed-plugin dependency. `npm run typecheck` checks the
shadow scaffold; `npm run build:runtime` updates its one-to-one checked-in ESM
output, and `npm run build:check` rejects missing, changed, stale, mapped or
oversized output. Build errors leave the previous runtime intact; stale files
require explicit review/removal. Ordinary installed command and Companion routes
use the TypeScript runtime; Python remains a development reference oracle.

Install the staged commit and outgoing push hooks with `npm run hooks:install`.
See the [local hook protocol](local-testing-protocol.md) for escalation and
24-hour deep-validation receipt reuse.

## Next.js Companion on Mac

Run `npm ci` at the repository root; the root lockfile includes the
`apps/companion` workspace. The library checks above remain separate from the
React application's DOM/JSX configuration. Run `npm run companion:typecheck`
for that application; the fast and full tiers include it.

For a local production build, run `npm run companion:build`, then
`npm run companion:start -- --root /absolute/path/to/test-store`.
The build also assembles the standalone application. For development, use
`npm run companion:dev -- --root /absolute/path/to/test-store`. Start through
these launchers so the Next application receives its owned workspace server URL
and authentication configuration. Use an isolated Store for development checks.

The launcher supervises both local services. The ordinary launcher activates the
native TypeScript Store writer through the process-owned switch and forwards API
requests to that server. Python launchers remain in the development repository
for reference comparisons. Checkout validation and standalone application
validation do not replace installed-plugin smoke tests.

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

## Local live-agent acceptance

`npm run test:agent-local` is an explicit local-only acceptance test; it is not a deterministic tier and exits immediately when `CI` is set. It runs three fresh, sequential, ephemeral `codex exec` subagents with `gpt-5.6-luna` by default. Use `npm run test:agent-local -- --trials 1` for a single diagnostic pass, `--model <available-model>` for an intentional local override, or `--keep` to retain successful local fixtures.

Each trial creates a new ignored directory below `.workflows/local`, installs the plugin into a fresh temporary Codex home, initializes a Store containing only committed fictional data and an `example.invalid` destination, and gives an ephemeral subagent a fixed protocol that invokes the installed `$job-apply:job-apply` skill. The subagent uses the installed public router to inspect and select the exact Ready job, start its detached attempt, grant Campaign to Review for that job, and perform the remaining Store and attempt operations. It runs with approvals disabled and `danger-full-access` for this isolated local installed-router and socket journey; the fixture contains no real data or destination, the prompt prohibits network/browser use, and a before/after source fingerprint rejects repository changes. The subagent must receive one authorized value-free decision, complete four synthetic non-final operations, stop at final review, and commit `awaiting_review`. A machine oracle then requires an untouched final action, the exact `job-started`/`reviewed` history, no bearer in the decision, and no repository source-state change. Successful fixtures are deleted; failed fixtures are preserved for diagnosis.

This test consumes live model capacity and can vary with the locally configured Codex model. Repeatability comes from the committed prompt, output schema, fixture, isolated Store, ordered action adapter, and closed oracle—not from accepting prose self-reports. Three consecutive clean trials are the local acceptance bar.

## Core workflow evidence audit

`npm run audit:core-workflows` is the primary account-free audit. It validates
all committed workflow YAML, requires one registry row per workflow, verifies
that referenced local files exist, and checks the registry's surface names,
copy-only handoff literals, placement declarations, and evidence-lane labels
for internal consistency. Its JSON output reports separate counts for
deterministic local, installed-host, supervised replay, and current-live ATS
evidence. A green result proves registry integrity and workflow schema validity;
it does not establish that an arbitrary referenced file semantically covers its
workflow, inspect the rendered Companion, or rerun historical host or replay
receipts. The mapped tests and packaged walkthroughs provide that behavioral
correspondence.

The optional installed-host lane is `npm run test:agent-local -- --trials 1`.
It requires an available authenticated Codex host and executes the installed
skill and public router against fictional local data. Record it as unrun when
that host capability is unavailable. There is no credential-free current-live
ATS command: such a lane must run only under its separately approved supervised
protocol, and until then the registry and compatibility table remain
`unverified`. Closed replay and synthetic readiness catalogs never upgrade that
status.

On macOS, `npm run test:qa-browser` resolves the evidence-bound CPython patches
3.12.13, 3.13.13, and 3.14.4. It asks an already-installed `uv` for each exact
local interpreter, then accepts the corresponding PATH alias only when its full
version matches. Discovery never installs or downloads Python. Process-local
shims expose the selected executables as `python3`, `python3.12`, `python3.13`,
and `python3.14`, so default and explicit profile tests use the same reviewed
identities. The command fails before testing if any patch is unavailable or
mismatched; it does not accept Homebrew 3.12.14 or the Xcode CPython 3.9 shim.
Other platforms retain their existing interpreter selection. The same macOS process resolves
`SDKROOT` and Clang with `/usr/bin/xcrun`; the native witness requires that exact
SDK and the independently fingerprinted compiler before exercising real flock
contention and unlock operations.

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
and smoke helpers in `scripts/smoke/`. The Store CLI contract covers 99 commands.
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

## Staging and CI validation

The checked-in **Validate Plugin** workflow runs for pushes to `main` and
`staging`, pull requests targeting either branch, and manual dispatch. It always
runs the full deterministic shards while recording affected selection in shadow
mode. The aggregate `PR gate` requires every selected Linux, macOS, Windows,
browser, package, policy, and classification job. The separate **Release
Validation** workflow runs installed-package validation for pushes to `main`
and `staging`, version tags, and manual dispatch.

The `classify` job records affected-suite selection in shadow mode but does not
skip full shards, and `PR gate` rejects any failed, cancelled, skipped, or
missing selected job. The former duplicate sequential validation lane and its
planned 20-PR observation window were retired after matrix equivalence was
established; `docs/legacy-validation-retirement.md` records that decision.

Required Windows and deterministic macOS contracts run on pull requests targeting
either `main` or `staging`.
Visible live-browser/native observations are advisory in the scheduled or
manual nightly workflow. Release installation evidence runs nightly and for
staging/main, version tags, and manual dispatch. No CI timing percentile or
observation-window completion is claimed yet; current timings are individual
local measurements.

## Portable and historical interpreter evidence

The Linux workspace CI job provisions CPython 3.12, 3.13 and 3.14 and runs fresh
codepoint-JSON differential observations, including interpreter/module provenance.
These comparisons do not grant historical migration acceptance to a new build.

`native-frozen-reference-profiles` remains in the full and platform tiers on
Darwin. It runs the unchanged S08 acceptance test against the exact recorded
macOS ARM64 interpreter/stdlib/native-module hashes; missing or different builds
fail that native gate. The Linux workspace suite excludes this host-bound test
and includes the separate portable comparison instead. Frozen receipts and their
strict checks are unchanged. A green portable CI run does not certify replay of
historical native acceptance; local deep verification retains that requirement.
