# Task 5 integration fix report

Date: 2026-09-15

Worktree: `/Users/neonwatty/Desktop/job-apply-plugin/.worktrees/python-runtime-closure`

## Repaired blockers

- Registered `tests_js/native_installed_entrypoints.test.mjs` once in the
  existing `native-default-cutover` full suite. The matrix now owns that test
  and its full-inventory count is one.
- Reconciled the ten changed source hashes in their existing catalog shards:
  `source-catalog-05.json`, `source-catalog-06.json`,
  `source-catalog-native-default-cutover.json`,
  `source-catalog-native-jobs.json`, and
  `source-catalog-native-task-cli.json`. Refreshed those shard hashes and the
  existing `python-runtime-closure.json` shard hash in
  `config/migration/review-lock.json`. No validator or acceptance rule changed.
- Corrected the runtime-closure migration prose: ordinary Store and task skills
  are native-first; Python remains for explicit whole-process rollback,
  isolated QA replay, and differential oracles. The document makes no
  Python-free-package claim.
- Updated the focused plan with the review ruling that the Store/task route is
  an atomic writer handoff: a workflow selects one complete native writer
  process, and a Python rollback never joins or resumes that native mutation.

## Commands and results

Initial RED checks:

```text
npm run check:test-matrix
exit 1
unowned executable/test path: tests_js/native_installed_entrypoints.test.mjs
full inventory count 0 for tests_js/native_installed_entrypoints.test.mjs
```

```text
npm run check:migration
exit 1 while the worktree was dirty
Historical audit requires a clean current snapshot
```

Focused and green checks:

```text
npm run check:test-matrix
exit 0
test matrix valid: 29 suites, 2086 tracked paths

npm run check:migration
exit 0
status: inventory-consistent
errors: []
pythonRuntime.status: inventory-consistent
acceptance: open

npm run build:check
exit 0
{"schemaVersion":1,"mode":"check","modules":217}

npm run check:size
exit 0

node --test tests_js/native_installed_entrypoints.test.mjs \
  tests_js/migration_python_runtime_closure.test.mjs \
  tests_js/migration_inventory.test.mjs
exit 0; 14 passed, 0 failed

node --test --test-name-pattern='S05 path support registration preserves the exact prior matrix' \
  tests_js/point_paths_reference.test.mjs
exit 0; 1 passed, 0 failed

git diff --check
exit 0
```

## Concerns

- The migration checker intentionally reports `acceptance: open`; inventory
  reconciliation does not fabricate behavioral acceptance.
- The broad `node --test tests_js/point_paths_reference.test.mjs` still has the
  known local baseline failure in its CPython-profile subtest because `python3`
  resolves to 3.9. The focused matrix-registration assertion passes, and no
  change was made to that baseline-only interpreter requirement.
