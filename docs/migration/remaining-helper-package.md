# Remaining synchronous helper implementation package

Parent: UI0. Immutable reference base:
`7f6e1f4272e2b06a7eb955112356b96be983d929`.

This child package ports the 27 exports enumerated in
[the reviewed reference contract](remaining-helper-reference.md). The reference
tests and original JavaScript remain unchanged during implementation. Dependencies
are the existing strict Node compiler interface and this family's fixed reference
tests; no Store, HTTP, projection or mutation implementation is required for these
inert leaves. Parent UI0 acceptance remains separate.

## Ownership

Implementation owner: migration_sequence. Exact `allowed_files`:

- `src/workspace-ui/lib/answer-view.ts` — nine answer exports.
- `src/workspace-ui/lib/activity-view.ts` — twelve activity exports.
- `src/workspace-ui/lib/profile-view.ts` — six profile/form exports.

Independent test owner: numeric_codec. Exact `allowed_files`:

- `tests_js/workspace_answer_helpers_ts.test.mjs`
- `tests_js/workspace_activity_helpers_ts.test.mjs`
- `tests_js/workspace_profile_helpers_ts.test.mjs`

Coordinator owns the emitted counterparts:

- `runtime/workspace-ui/lib/answer-view.js`
- `runtime/workspace-ui/lib/activity-view.js`
- `runtime/workspace-ui/lib/profile-view.js`

The coordinator also owns inventory registration, this receipt and the execution
ledger, plus `tests_js/workspace_helpers_browser_ts.test.mjs` for a real Chromium
module-loading comparison. No worker edits these shared artifacts. Module dependencies remain within
each helper group. The compiler emits each runtime file directly from its source.
No entry point or application routing changes in this package.

## Acceptance and completion

- All 27 named exports retain their existing values, identity, ordering, coercion,
  short circuits, observable property access and errors on the captured inputs.
- Profile patches retain existing caller-object alias writes and frozen-object
  failures. A blanket nonmutation claim would be incorrect.
- Independent tests compare separate equivalent fixtures, including sparse arrays,
  prototype keys and caller-defined getters/coercion failures; test success must
  not depend on shared mutable fixtures between implementations.
- Original reference tests pass alongside comparison tests, without skipped or
  cancelled cases. Coverage remains bounded to these helper bodies.
- Strict type checking, reproducible emission, source-size policy, test inventory
  and migration inventory pass. No source file exceeds 500 physical lines.
- Independent source review has no unresolved blocking finding. Evidence records
  the exact source/build state tested, commands and outcomes.

Commands: `npm run typecheck`, `npm run build:runtime`, `npm run build:check`,
`npm run check:size`, `npm run check:test-matrix`, `npm run check:migration`, and
`node --test` with the three reference files and three comparison files listed
above. Commit checks verify the integrated staged snapshot. Broader tests are run
at integration milestones according to the approved map.

The browser check loads all 35 emitted synchronous helper exports without Node
globals and checks 12 selected behaviors against both fixed expectations and the
original browser module. It is a browser compatibility check for inert helpers,
not a replacement for the independent per-family cases or application flows.
Its FileReader case is an original-only reference for the separate IO boundary.

Implementation completion does not grant browser-event, live privacy, HTTP,
filesystem, Windows/Linux, or parent UI0 acceptance. FileReader remains a separate
browser boundary, and application activation waits for its owning integration
gates. This document starts as a work package; verified outcomes belong in the
execution ledger after review.
