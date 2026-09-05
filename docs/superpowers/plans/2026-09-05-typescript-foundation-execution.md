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
