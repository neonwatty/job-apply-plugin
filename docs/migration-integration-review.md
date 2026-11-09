# Migration integration review

Date: 2026-09-05. Branch: `codex/ts-migration-integration`.
Worker base: `8b85729e3f936fdbe124d6b3634c7ad421461215`.
The new worktree initially opened at `984b55a`; it was clean and a new branch
was created explicitly at the worker base. No worker or main worktree was edited.

## Dependency and accepted scope

PR49 remains an unmerged dependency, last verified open at `8b85729` with
legacy validate and PR gate failing on run `33987643707`. Its owner retains
the browser-created-job/CLI visibility diagnosis and repair. This integration
does not absorb a repair, bypass the legacy check, publish, merge or release.
Reconcile the eventual repaired/merged baseline before proposing publication.

| Package | Decision | Local integration |
| --- | --- | --- |
| Profile/fact `3221f0ae953d6010309240dddeb68a0f2b74e6f9` | Accepted as bounded reference evidence | `b5dc97f`, byte-identical worker diff; `de13061` registers and links it |
| Runtime `9f3df908e1d0281a817978ce0c97b4b8d0cf46f5` | Accepted documentation only | `9c6d029`; linked by `5e8d11e` |
| Matching `70f4d12` through `28369466f45de7e0fa40a7beeeeab7f265521fb4` | Held in entirety | Neither commit, tests nor runtime modules integrated |

Profile/fact adds 19 cases for four mutation commands. Python remains the only
live Store writer. Runtime has zero accepted clean-host cells; neither runtime
version nor launch strategy is selected. No build/package registration changes
were necessary beyond registering the profile/fact test in the existing suite.

## Review evidence and limitations

Independent correctness, tests, contracts/types, silent-failures and comments/docs
passes found no undisclosed blocking defect in the accepted packages. A further
integration-wiring pass verified ownership, full selection, counts and links.
The native `codex review --base 8b85729e3f936fdbe124d6b3634c7ad421461215`
attempt failed because the installed CLI cannot use this task's model. It is
not counted as successful review evidence; no model or CLI changes were made.

The profile diff SHA-256 is
`62f5afdb45ac5e68c9849222931f882beef2b89e6742ecaa8307ae423bdc9977`
for both the submitted worker diff and the integrated package diff.
Official runtime-document sources were fetched independently and corroborated
the narrowly stated installation claims; they establish no plugin Node guarantee.
See the citations in the [runtime recommendation](runtime-evidence/launch-recommendation.md).

## Matching acceptance boundary

Review reproduced raw JSON scope `1` versus `1.0` producing Python
`none/scope_mismatch` but TypeScript `exact/scope_match`; `limit:1.0` is rejected
by Python and accepted after JavaScript decoding. The worker documents these
exclusions, so these are unresolved acceptance gates rather than hidden findings.
The migration's full-equivalence requirement is not satisfied by exclusions.

CPython 3.14.4/Unicode 16 and exact error wording do not match existing Python
3.12/Node 20 CI lanes. Even the provisional Node 22.0 floor does not itself
establish Unicode 16 normalization. Registration and version increases are not
accepted remedies. The 17 Unicode data modules and their emitted counterparts
are inspectable, but add substantial maintenance cost to a 7,861-line package.
Replacing casefolding with JavaScript lowercase/word regexes is not equivalent;
packing tables or bundling them would not solve the policy/design question.

Proposed next bounded diagnostic, pending scope decision: preserve raw JSON
request strings and record Python/interpreter/Unicode provenance separately.
Cover integral floats, exponents, negative zero, nested numbers, unsafe integer
neighbors, limit types, exact error wording and differing Unicode characters.
Do not refresh current goldens or normalize responses. No parser implementation,
runtime activation, version changes or production edits belong to this review.
The source owner agreed to keep this follow-up read-only for this integration.

A subsequent worker could own only a raw-reference schema/vector, raw-reference,
capture and harness helpers, a focused test and the matching receipt. Choosing
Python 3.12, Python 3.14 or explicit compatibility profiles requires a decision
first. Alternatively, a smaller ranking kernel could leave normalization,
validation and scope identity with Python, but that requires an explicit scope
amendment and would not complete the full matching port.

## Validation

Local environment: macOS arm64, Node 22.22.3, Python 3.14.4; supplementary
profile/fact execution used existing Python 3.13. No Python 3.12, Linux or Windows
execution is claimed. Local runtime presence is not fresh-host launch evidence.

- Profile/fact focused suite: 6 tests passed under both local Python versions.
- Combined read/startup/profile/runtime Node tests: 26 passed.
- Python runtime-evidence tests: 11 passed.
- Fast tier: all 6 suites passed.
- Type/build, source-size, test-matrix and documentation-link checks passed.
- Platform tier: macOS native suite passed; Windows suite skipped, unverified.
- Full and release outcomes are recorded below after their runs finish.

The full run exposed three `QuietParser` signature subtest failures in two
unchanged QA tests. A targeted identical command under Python 3.14.4 on this
integration and a disposable archive of `8b85729` reproduced all three failures:
`test_qa_chrome_facade.ChromeFacadeContractTests.test_facade_preserves_every_callable_signature_and_metadata`
and `test_qa_chrome_loader_isolation.ChromeLoaderIsolationTests.test_each_facade_retains_exact_loader_local_class_metadata`.
The baseline expects an older ArgumentParser signature without `suggest_on_error`
and `color`. This is pre-existing compatibility evidence, not a passed full run.
No QA tests, runtime versions or production code were changed to address it.

## Proposed PR scope

After PR49 reconciliation and explicit publication approval: profile/fact
reference corpus, its existing-suite registration and coverage links, runtime
evidence links and this acceptance receipt. Exclude matching and runtime launch
changes. Retain cross-platform, fresh-host, full-contract, recovery and writer
cutover gates. Current work is local commits only.

## Continuation provenance

The preceding handoff was restored from the first successful tool read of the
archived integrator's untracked report. A later read found that old path no
longer available; the cause is unknown. No old-worktree modifications were made.
Continuation branch: `codex/ts-migration-continuation`, created in clean
worktree `90aa` at exact `71122df0615751a797b382638516c723f52f9226`, rather than
the initial checkout `984b55a`.
Allowed continuation files: this report and `docs/integration-evidence/*`.
No implementation, QA, version, CI or production workspace changes were made.

Source-task retrieval returned six recent turns with empty item arrays. The
source owner subsequently confirmed the supplied constraints and heavy-test
capacity directly. Earlier independent reviews are inherited evidence, not
new reviews performed by the continuation. The profile diff digest was
recomputed and matches the preserved digest above.

PR49 was checked again on 2026-09-05: still OPEN at exact `8b85729`, with
`validate` and `PR gate` failed on run `33987643707`. No repaired dependency
was supplied or absorbed. Proposed PR title: **Add profile/fact reference
contracts and runtime acceptance evidence**. Publication requires dependency
reconciliation and the user's explicit approval.

The old full log ends without an aggregate summary or receipt. Process
inspection found no remaining `fe6d`, test-runner or Node test processes;
unrelated browser processes were left alone. No old-process cleanup was needed.
Recovered suite completion: Python workspace 548 passed, accounts 74 passed,
core 98 passed, fast 47 passed; Node foundation 11 passed, runner 19 passed,
renderer 13 passed. Python QA completed 347 tests with three failures and two
skips. Recorder and workspace Node suites lacked completion evidence.

Both targeted failed receipts are preserved verbatim:
[unchanged baseline](integration-evidence/python314-baseline.txt) and
[integration](integration-evidence/python314-integration.txt).
The original incomplete full log remains `/tmp/ts-integration-full.log`, SHA-256
`ff2ad7218400f5225179b6e65314e148838658053baa7c3e8485373ea1fc34a0`.
Its missing completion is not inferred from successful individual subtests.

Only the two unfinished Node suites were retried, followed by the release
tier's existing two suites, using `executeSuites` with concurrency two and
180,000 ms per-suite deadlines. These are explicitly bounded continuation
runs, not an unmodified full-tier rerun. The existing runner terminates only
the process groups it starts on timeout. Dependency installation used the
unchanged lockfile. Size and matrix checks passed again in the new worktree.

## Final validation outcome

| Gate | Outcome |
| --- | --- |
| Focused profile/fact, runtime evidence and build | Passed, inherited receipts described above |
| Fast tier | All six suites passed; [receipt](integration-evidence/fast.json) |
| Full tier | Failed: three reproduced baseline Python 3.14 assertions; all other suites now have completion evidence |
| Remaining full suites | Recorder 48 tests passed in 87.8s; workspace/other 73 passed in 80.7s; [receipt](integration-evidence/full-remainder.json) |
| Release tier | Both suites passed: links 4.7s, package 40.6s; [receipt](integration-evidence/release.json) |
| Platform | macOS passed; Windows skipped and unverified; [receipt](integration-evidence/platform.json) |
| Runtime launch | Unresolved; zero clean-host cells accepted |
| Matching equivalence | Held for numeric lexical, interpreter/Unicode and maintainability blockers |
| PR49 dependency | Open/red; publication blocked pending reconciliation and approval |

The release package run passed isolated Claude and Codex installation, upgrade,
critical-byte parity and all three packaged browser walkthrough tests. This
local success does not close PR49's separately observed CI failure.
No continuation suite timed out. Full status is assembled from recovered
completed suites plus the two targeted retries, not a green aggregate receipt.
The old fast/platform receipts omit HEAD metadata; they remain inherited
receipts, not new executions. Continuation receipts identify the unchanged
implementation HEAD; the final commit adds documentation and receipts only.

Continuation raw output: `/tmp/ts-continuation-bounded.log`, SHA-256
`f7c0a3eb3e42763d49a00b8e89181eb9ff715c9925dc4ca0ef12296201002997`.
The bounded runner exited normally. Heavy-test capacity is released.
