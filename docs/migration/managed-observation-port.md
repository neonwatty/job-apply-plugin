# Managed observation implementation checkpoint

Base: `86b01fe`. Scope: inert POSIX observation, timestamp formatting and explicit
native stat arithmetic. Parent FS/SEM acceptance remains open. No Store startup,
live writer, public routing or distribution configuration changes in this package.

## Ownership and interfaces

The implementation worker owns `src/store/resume-modified-at.ts`,
`src/store/managed-resume-observation.ts` and `src/store/managed-resume-native.ts`.
The coordinator owns `src/contracts/stat-time.ts`, emitted counterparts,
registration, the native comparison driver/test and this evidence record.
The independent test worker owns the timestamp and injected observation tests
and their synthetic fixture support. validation_strategy reviews source without
editing it; numeric_codec independently reviews the coordinator's native harness.

`resumeModifiedAt` preserves binary64 fractional microsecond rounding before
formatting whole UTC seconds. `statSecondsFromNanoseconds` requires an explicit
fused or separate arithmetic mode; neither is silently inferred from OS name.
The native adapter requires a Python path profile and an injected microsecond
clock. It uses byte-preserving POSIX paths, bigint metadata and the existing
descriptor-based digest primitive. Windows has no native implementation here.

The native Python expression is `sec + 1e-9*nsec` in
[CPython fill_time](https://github.com/python/cpython/blob/v3.14.4/Modules/posixmodule.c).
The local builds exhibit fused arithmetic, including negative 600 nanoseconds.
This observed build behavior does not establish a universal compiler default.

## Independent evidence

The frozen timestamp reference includes 24 fixed float inputs and four native
stat conversions. Tests additionally compare 3,048 deterministic double inputs
and 50 owned native stat samples per interpreter invocation. The default Python
duplicates 3.14; explicit 3.12, 3.13 and 3.14 are available on this macOS host.
The reviewer separately compared 2,048 deterministic timestamp inputs to Python.
Both stat arithmetic modes are also compared against Python Decimal arithmetic on
112 inputs per invocation, including signed 64-bit limits and negative remainders;
seven inputs distinguish the modes. Invalid mode/range guards are tested.

The frozen observation reference includes 18 normal, cache, missing-file,
nonregular-file, injected-error and post-read-change cases. Tests compare results,
call counts, initial/final cache contents and owned-file preservation. Extra tests
exercise exact microsecond expiry, every identity field, propagation of non-OS
errors, missing keys, numeric key equality, sparse identities and null cache values.
Independent review found the last three cache issues; fixes and regressions are
included. Arbitrary malformed JavaScript objects remain outside the typed API.

The native integration compares eight cases on separate Python and TypeScript
trees for each explicit Python profile: ordinary file, missing file, directory,
symlink, oversized file, traversal, final NUL and final invalid surrogate.
It calls the actual Python path, observation, digest and metadata helpers without
constructing a Store. Two sequential observations preserve bytes, permissions,
link targets and mtimes. Python StoreError maps only to the established typed
StoreValidationError class, with exact message comparison; other error categories
are unchanged. Native output/cache equality does not prove the second call avoided
disk reads; that decision is separately tested by injected call counts.

The final focused run includes the timestamp/reference, observation/reference,
native observation, managed path and private digest suites: 360 passed, zero
failed, zero skipped. Strict typing, reproducible emission (22 modules), size and
test registration checks pass. Inventory consistency reports 283 sources and
4,380 unmapped requirement cells; acceptance remains open.

## Remaining gates

This checkpoint is implementation evidence, not formal FS/SEM acceptance.
Required native Linux byte-named files/cwd, Windows paths, permission denial,
race-safe storage, platform calendar/error details and complete caller semantics
remain open. The timestamp formatter currently models signed 64-bit time_t and
signed 32-bit native calendar years; other host profiles require their own evidence.
No mandatory skipped or unavailable cell is counted as passing.

The full-tier Python 3.14 QA signature failures and opt-in visible-browser skips
recorded in the execution ledger remain unresolved. Full candidate, install,
upgrade, offline, writer-switch and post-write rollback gates have not run for a
Python-free artifact. Formal inventory requirements remain uncovered; consistency
checks alone cannot close these gates.
