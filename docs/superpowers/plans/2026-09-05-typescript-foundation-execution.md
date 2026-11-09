# TypeScript foundation — first execution increment

Baseline: merged modernization commit `3319033` on `staging`.
The post-merge release workflow passed; its recorder shard failed an event
observation assertion. A separate test-only lane investigates that baseline
failure while independent foundation work proceeds. No runtime cutover is
authorized by this increment.

## Ownership and acceptance

| Lane | Allowed files | Acceptance |
| --- | --- | --- |
| Runtime probe | `tools/probe-installed-runtime.mjs`, `tests_js/runtime-support.test.mjs`, `docs/runtime-support.md` | Missing, malformed, unsupported and supported runtime evidence is value-free; local PATH evidence never closes the fresh-host gate. |
| Contract seed | `contracts/`, `test/contract/vectors/`, `tools/contracts/`, capture/redaction entry points, `tests_js/python-contracts.test.mjs`, `docs/contract-corpus.md` | Exact 98-command inventory, deterministic synthetic initial vectors, privacy checks, explicit missing coverage; no live Store inputs. |
| Build and integration | `tsconfig.json`, `src/`, `runtime/`, build tools/tests, shared package/matrix/workflow configuration and this report | Strict checking, reproducible one-source/one-output modules, no maps/bundle, source and emitted files <=500 lines, no launcher changes. |
| Baseline recorder repair | Recorder scenario and directly related test helpers | Preserve privacy, event-sequence and final-action assertions; await durable evidence rather than racing teardown. |

Workers use isolated worktrees and return scoped commits and test receipts.
The integration owner alone changes shared configuration. Each result receives
independent review before integration. Broader verification follows integration;
individual retries are diagnostic evidence, not CI observation-window credit.

## First-increment boundaries

- The runtime gate remains open until fresh supported Claude/Codex installations
  on supported operating systems and architectures prove a launch strategy.
- A command inventory is not a complete compatibility corpus. Initial vectors
  do not cover every command, HTTP route, mutation or recovery boundary.
- Public TypeScript contract types follow frozen vectors, not guessed schemas.
- The build sentinel is not application logic and is not imported by existing
  launchers. Python remains the only canonical writer.
- Build tooling is a small Node ESM bootstrap so it does not depend on native
  TypeScript execution. Pinned TypeScript emits ES2022 modules into `runtime/`.
- Compiled modules are checked in for future offline packaging; dependencies
  are development-only. The installed plugin never compiles or installs them.
- Retained CI and affected-selection observation gates remain unchanged.

## Verification commands

`npm run typecheck`, `npm run build:check`, `npm run test:fast`, focused contract
and recorder tests, source-size and matrix checks, then integrated full/release
tiers at the handoff. No actual Python removal, application port, release,
merge, or branch-protection change is part of this foundation increment.

## Local acceptance checkpoint

Implementation through `5b5118a` on `codex/typescript-foundation`:

- Runtime probe: five synthetic tests; local macOS/arm64 observation only.
- Strict build scaffold: six tests, development-only pinned compiler, inert
  emitted sentinel, installed-byte inventory extended to `runtime/`.
- Corpus seed: exact 98-command inventory, nine non-mutating read behaviors,
  two corrupt/future-profile rejection behaviors. Six focused tests passed
  after both independent review rounds; no golden refresh occurs in tests.
- Recorder baseline repair: original checkpoint state and all privacy checks
  retained, with an additional stable-document input and durable event wait.
  Focused stress runs and the integrated recorder suite passed locally.
- Fast tier: six suites passed. Full deterministic tier: all 13 suites passed
  on the integrated seed; later corpus-only review changes were verified by
  the six focused corpus tests, not represented as a second full-tier run.
- Source-size and matrix checks passed: 17 registered suites, no size exceptions.
- Final release tier: both suites passed, including packaged browser journeys,
  isolated Claude/Codex installations, upgrade and critical-byte verification.
- Independent scaffold and final corpus reviews found no remaining blocking
  findings within their bounded scopes.

Local evidence is in `/tmp/job-apply-ts-foundation-*.json` and corresponding
logs. These receipts do not establish fresh-host launch support, CI performance
percentiles, platform parity of the new corpus, or the external CI observation
gates. No push or merge was performed for this increment.

Next work packages: fresh-host runtime evidence; write-aware startup contracts
for automation/accounts/claims; then profile/fact mutation-conflict and recovery
vectors. Public TypeScript contract types and domain ports follow sufficient
frozen contracts for their scope. The other 89 Store commands and HTTP,
task/attempt, QA/policy, mutation and recovery coverage remain explicitly pending.
