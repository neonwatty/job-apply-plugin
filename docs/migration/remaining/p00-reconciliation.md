# P00 baseline reconciliation — accepted audit

Subject: `adb9fb97d19da1bb432acaa45cf8f394c3dc356d`.
Subject tree: `ec4ac2f9f4324875f3a28ce6372fbbc3510aa147`.
Staging ancestor: `4f6fcbe` (skills cleanup PR51).
Prior implementation baseline: `94e7d9c`; approved plan commit: `bb2372d`.

Root reconciled the branch and recorded the audit. Independent reviewer
`hooks_audit` reviewed the final immutable subject and accepted P00.V only as
baseline reconciliation. No parent family, native host, push or final conversion
acceptance follows from this result. P01 will provide formal task-receipt loading;
this bootstrap audit must be reconciled into that scheme without inventing evidence.

## Evidence bound to the subject

- Staging is an ancestor; zero upstream commits remain unintegrated. There were
  no open PRs when fetched. Forty-one commits were ahead of staging after the merge.
- Inventory is consistent: 316 source rows, 37 emitted JS modules, 446 surfaces,
  10 requirements, one structural package and 4,380 unmapped requirement cells.
- All nine staged commit checks passed against the subject tree. Native Git hooks
  are installed; no bypass or changed timeout was used.
- The upstream critical-artifact contract now recursively includes `skills`.
  Existing TS inventory and independent fixtures were reconciled intentionally.
  Six artifact test files passed 232 tests with zero failures/skips across the
  installed Python profiles, including nested skill-reference corruption cases.
- The old Python 3.14 QuietParser expectation failed three assertions across two
  tests. The constructor is inherited unchanged from argparse; comparison with
  that independent installed constructor preserves every signature parameter.
  Both complete test files pass 22 tests on each of Python 3.12, 3.13 and 3.14.
- No other production text, parser, native lock/timestamp or Store behavior was
  activated. Source catalog hashes match the actual integrated sources.

Commands and retained local logs:

| Check | Command / evidence |
| --- | --- |
| Inventory | `node tools/migration/check.mjs` |
| DAG | `node tools/migration/check-remaining-plan.mjs` |
| Artifact reconciliation | `node --test tests_js/installed_artifacts_reference.test.mjs tests_js/installed_artifacts_ts.test.mjs tests_js/artifact_copy_metadata_reference.test.mjs tests_js/artifact_copy_order_reference.test.mjs tests_js/artifact_data_copy_reference.test.mjs tests_js/data_copy_ts.test.mjs`; `/tmp/job-apply-staging-artifact-reconciliation.tap` |
| Python constructor regression | Each installed Python 3.12/3.13/3.14: `-m unittest tests.test_qa_chrome_facade tests.test_qa_chrome_loader_isolation`; `/tmp/job-apply-qa312-signature-after.log`, `/tmp/job-apply-qa313-signature-after.log`, `/tmp/job-apply-qa314-signature-after.log` |
| Original regression | `/tmp/job-apply-qa314-signature-reproduced.log`; the earlier incorrectly named test invocation is excluded |
| Commit gate | `/tmp/job-apply-staging-reconciliation-commit.log`; full receipts in this worktree's Git metadata `local-checks` directory |

Temporary log paths are local provenance pointers, not portable final-release
artifacts. Final acceptance needs retained immutable log content and hashes under
P01/P05. Deep validation of this subject subsequently completed with `passed-local`
status in 727 seconds: 27 suites passed and the foreign Windows suite was
deferred. The 28-suite selection includes package installation and isolated
browser/CLI walkthroughs. No deep receipt existed before that run.

Receipt key: `265d5c0c55f481e00c1b11875833fa3ad4c5ddf21cc0598309644ddea07621b2`.
Log: `/tmp/job-apply-migration-baseline-deep.log`; SHA-256
`8872e54533dbcf976000fc1c431b2a8f79c7f941540a8b3aae3cdf02264305e4`.
Two opt-in visible-browser tests, 24 POSIX path-byte cells and one timestamp
raw-filename cell were skipped internally; none is accepted by suite success.
The receipt applies only to the exact subject/tree/base/environment above,
not subsequent reference or evidence-tooling edits.

## Remaining limits

The text representation is still inert. Binary-copy buffering/acceleration and
installed package behavior still need native adapters and host evidence. Raw
macOS filename fixtures with EILSEQ, other native OS/CPU cells, clean hosts and
packaged runtime delivery remain open. Prior opt-in visible-account tests remain
unrun unless explicitly authorized for the relevant cell. Full conversion still
requires coverage closure, Python-free required tooling/tests, writer switch and
rollback after TS writes on owned clones. No live Store was touched.
