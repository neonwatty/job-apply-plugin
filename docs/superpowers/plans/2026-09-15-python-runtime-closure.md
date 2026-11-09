# Python Runtime Closure Preparation Plan

**Status:** Ordinary native cutover deferred after final review. This plan
supersedes the attempted routing cutover recorded in the SDD ledger.

**Goal:** Preserve the working whole-process Python route for ordinary source
marketplace installs while retaining independently valid native hardening and
prepared-Store support. Do not claim runtime closure or a Python-free package.

**Architecture:** Shipped skills use the Python Store, task, attempt broker,
policy, workspace, and contract helpers together. Native Jobs/task commands and
the native attempt/policy implementations remain available for isolated prepared
Stores and assembled-package rehearsals. Explicit whole-process Python rollback
is preserved. One live Store must never have Python and TypeScript writers.

**Spec:** `docs/migration/python-runtime-closure.md`

## Final review ruling

Source marketplace installs have no verified packaged flock addon, and native
bootstrap does not create the full native layout or provide safe activation of
existing Python Stores. It is unsafe to compensate by marking an existing Store
in place, weakening native validation, or compiling/downloading an addon at
runtime. Restore the last coherent writer route before shipping. A future atomic
cutover requires assembled-package distribution, exclusive activation, complete
initialization, and documented CLI parity.

## Work packages

1. Retain the native attempt broker `nlink === 1` guard and lifecycle regression.
2. Restore all ordinary shipped skills and README commands to the complete Python
   route, including resume import, policy, attempts, workspace, and helpers.
3. Restore Python attempt critical-artifact and smoke coverage, Python closure
   inventory, and the corresponding artifact/skill contract tests.
4. Test real source-only installed packages with fresh and existing Python
   Stores. Run the commands selected by shipped instructions through init,
   profile-get, task snapshot, and resume import. Preserve existing profile bytes
   and ensure no native marker is introduced. Do not use native fixture setup to
   validate this installation route.
5. Keep prepared-native fixtures separately labeled. Reproduce and fix
   `JOB_APPLY_STORE_DIR='~/.job-apply'` expansion in native Jobs and task commands.
6. Regenerate runtime deterministically and reconcile source catalogs/review
   hashes. Run focused suites, build:check, typecheck, size, test matrix, migration,
   and affected checks. Record existing environment-only failures accurately.

## Binding constraints

- Preserve JSON envelopes, revision checks, privacy, managed resume identity,
  and human-only final submission.
- Never mutate or mark an existing Python Store as native in place.
- Never run Python and TypeScript writers against one live Store.
- Preserve explicit whole-process Python rollback; no command-level fallback.
- No runtime addon compilation or download.
- Keep scoped source and tests at or below 500 physical lines.
- Keep migration acceptance open until its full evidence exists.

The SDD ledger and `final-fix-report.md` record RED/GREEN evidence, final checks,
commit identities, and deferred activation/distribution requirements.
