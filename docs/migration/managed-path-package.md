# Managed resume path implementation package

Parent nodes: FS and SEM. Reference checkpoint: `54069e0`, containing the
independently reviewed 38-case managed-path reference. This package remains inert;
Python retains sole authority over the live Store.

## Ownership and dependencies

Implementation owner migration_sequence has exact `allowed_files`:

- `src/contracts/posix-path.ts`
- `src/store/managed-resume-path.ts`

Independent test owner numeric_codec has exact `allowed_files`:

- `tests_js/managed_resume_path_ts.test.mjs`
- `tests_js/managed_resume_path_ts_support.mjs`

Independent source reviewer: validation_strategy. The coordinator owns emitted
`runtime/contracts/posix-path.js` and `runtime/store/managed-resume-path.js`, test
registration, source inventory, this package and the execution ledger.

Prerequisites are the strict compiler interface, existing typed JSON Map model
and StoreValidationError, and the frozen reference. The Store leaf may depend on
the path primitive; the primitive must not import the Store leaf. No facade,
bootstrap, live routing or write operation belongs to this package.

## Contract and acceptance

Preserve candidate construction separately from parent resolution: redundant
separators and dots collapse, dotdot remains in the returned candidate, and an
absolute name replaces the base. Resolve actual links and missing components
using explicit Python 3.12, 3.13 or 3.14 semantics. Compare the candidate parent
with the separately resolved managed root, then return the lexical candidate.
Keep missing-key, invalid-name, loop and application-error categories distinct.

The native implementation must use real filesystem observations on supported
POSIX hosts. Tests use separate owned synthetic trees, compare exact return/error
outcomes with the frozen Python reference, and verify unchanged bytes, links,
modes and mtimes. Injected errors are identified separately from native evidence.
No profile, unsupported platform or missing native capability is silently accepted.

Completion requires independent source review, all required local reference and
comparison cases passing without skips, strict typechecking, reproducible emitted
runtime, size compliance, test registration and migration inventory checks.
Commands include `npm run typecheck`, `npm run build:runtime`, `npm run build:check`,
`npm run check:size`, `npm run check:test-matrix`, `npm run check:migration`, and
`node --test tests_js/managed_resume_path_reference.test.mjs tests_js/managed_resume_path_ts.test.mjs`.

This is not full FS acceptance. Native Windows semantics, path-byte/Unicode
profiles, actual permission denial, races, final-component opening and complete
managed-file observation retain their own required gates. A parent comparison
does not bind or authorize a subsequent file open. Unsupported behavior remains
explicit outstanding work toward the complete migration.
