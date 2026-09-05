# Task 5D report: replay coordinator decomposition

## Status

Complete. The hyphenated `scripts/qa-replay.py` entry point is now a
500-line compatibility facade over the directional `qa.replay` package. All
owned source and test files are at or below 500 physical lines, and the sole
`scripts/qa-replay.py` source-size baseline entry was removed.

Base: `c47e2797daa629a703aadca5e5dac3958adecf4c`.

## Scope

Changed only the owned replay surface:

- `scripts/qa-replay.py`
- `qa/replay/{__init__,auto_submit,secure_io,report,run_state,server_control,prepare,lifecycle,evaluate,cleanup_preflight,cleanup,cli}.py`
- `tests/test_qa_replay_facade.py`
- `.source-size-baseline.json`, removing only `scripts/qa-replay.py`
- this required report

No promotion, recorder, Chrome, Store, fixture, scenario, PDF, browser, or
packaged runtime source was changed.

## TDD evidence

RED was established before implementation with:

```text
python3 -m unittest tests.test_qa_replay_facade -v
```

The six-test contract run failed for the missing split: the legacy CLI patch
characterization passed, the frozen `__all__` contract failed because the
monolith had no explicit inventory, and package/import/split-CLI tests failed
because `qa.replay` did not exist. One nested server-patch test initially made
an unintended real request; its setup was corrected to patch the shutdown
boundary as well before production behavior was changed.

After implementing the package and runtime-compatible facade, the same six
tests passed. The first full replay run then exposed one real porting defect:
the preflight sanitizer had omitted the deferred `run.json` branch, so cleanup
recovery failed for interruption points 7 through 14. The existing
`test_cleanup_recovers_after_every_sanitization_interruption` test was the RED
guard. Restoring the deferred branch made the targeted test green, followed by
all 54 replay tests.

## Decomposition and compatibility

- `auto_submit.py` owns the closed loopback safety matrix and policy checks.
- `secure_io.py` owns `_RunStorage`, opened root/run descriptors,
  descriptor-relative bounded reads, atomic JSON/marker publication, and
  directory-binding checks.
- `report.py` owns report shape/semantic validation, report digests, signed
  tombstones, recovery validation, and public cleanup projection.
- `run_state.py` owns identifier/state validation and opens loaded or cleanup
  runs only through `_RunStorage`.
- `server_control.py` owns loopback URL validation, authenticated identity and
  shutdown requests, server startup, detached-process handling, and state
  fetches.
- `prepare.py` owns scenario/fixture validation, source copying, isolated Store
  initialization, server preparation, and stable prompt/output construction.
- `lifecycle.py` owns direct route resolution and serialized started/reviewed
  transitions.
- `evaluate.py` owns serialized oracle evaluation, PDF/store descriptor use,
  report publication, terminal markers, and fail-closed server shutdown.
- `cleanup_preflight.py` owns `_CleanupTree`, including the bound root identity,
  exact manifest/children identities, sanitization, and post-sanitize
  verification.
- `cleanup.py` owns authenticated cleanup state orchestration and
  descriptor-relative removal used by failed preparation.
- `cli.py` owns parser construction, stable JSON dispatch, diagnostics, and
  exit codes.
- `scripts/qa-replay.py` remains the historical import and executable facade.

The facade freezes the exact 62-name legacy star-import inventory and keeps
the historical helper names available. `CoordinatorError` has one shared
identity across facade, package, and leaves. The small package API exports only
`CoordinatorError`, `prepare`, `evaluate`, `record_transition`,
`resolve_route`, `cleanup`, `verify_auto_submit`, and `main`.

Facade entry wrappers pass a live facade runtime into the leaves. Low-level
partial bindings retain that same live runtime. Existing patches to facade
functions, roots, validators, standard-library modules, authenticated request
handling, exclusive rename, and cleanup helpers therefore continue to affect
the split implementation. No leaf imports the hyphenated facade; a
clean-process contract verifies this.

## Descriptor, identity-tree, and lifecycle review

- Core prepare/evaluate/lifecycle/cleanup operations consume `_RunStorage`
  instances. Root and run descriptors are opened in `secure_io`, retained for
  the operation, verified against their original directories, and closed by
  the binding. Compatibility tuple adapters explicitly transfer ownership and
  are not used by core orchestration.
- Core orchestration never recreates a run descriptor from a stored path.
  Store and cleanup traversal remain relative to the retained run descriptor.
- `cleanup_preflight` builds `_CleanupTree` from the retained run descriptor,
  records the root identity plus every child identity, and uses that same tree
  object for sanitize/verify phases. Cleanup orchestration never reconstructs
  the tree from path strings.
- Cleanup retains the deferred `run.json` capability until all other synthetic
  artifacts are sanitized, preserving retry after every interruption point.
- Tombstones remain HMAC-bound to both route and shutdown tokens, the lifecycle
  nonce, fixture/scenario, cleanup state, report-retention bit, and report
  digest. Self-contained retry still accepts only a closed, already-sanitized
  identity tree.
- Server shutdown still requires exact fixture identity and the private
  shutdown capability. Unavailable servers retain retry capability; identity
  mismatches never stop another server.
- Evaluation still opens the Store under the retained run descriptor, passes
  that descriptor to the oracle/PDF inspection path, publishes the validated
  report before the completed marker, and records abandonment on active-run
  failure.
- Auto-submit verification remains loopback-only, redacted, repeatable, and
  enforces a single claimed activation, all stop boundaries, linearized kill,
  and bounded uncertainty retry.

## Line counts and baseline

```text
scripts/qa-replay.py                    500
qa/replay/__init__.py                    24
qa/replay/auto_submit.py                484
qa/replay/cleanup.py                    381
qa/replay/cleanup_preflight.py          498
qa/replay/cli.py                         78
qa/replay/evaluate.py                   176
qa/replay/lifecycle.py                  173
qa/replay/prepare.py                    380
qa/replay/report.py                     252
qa/replay/run_state.py                  136
qa/replay/secure_io.py                  473
qa/replay/server_control.py             296
tests/test_qa_replay_facade.py          207
```

`.source-size-baseline.json` changed by exactly one deletion: the former
2,510-line `scripts/qa-replay.py` exception. No ceiling was added or raised.

## Verification

```text
python3 -m unittest tests.test_qa_replay_facade -v
PASS: 6 tests

python3 -m unittest \
  tests.test_qa_replay_cleanup.ReplayCoordinatorTests.test_cleanup_recovers_after_every_sanitization_interruption -v
PASS: 1 test, all interruption subtests

python3 -m unittest discover -s tests -p 'test_qa_replay_*.py' -v
PASS: 54 tests

python3 -m unittest \
  tests.test_qa_oracle_events \
  tests.test_qa_oracle_semantics \
  tests.test_qa_oracle_sessions \
  tests.test_qa_readiness_oracle
PASS: 45 tests

python3 -m unittest discover -s tests -p 'test_job_apply_policy_*.py'
PASS: 19 tests

python3 -m unittest discover -s tests -v
PASS: 788 tests, 2 opt-in browser skips

bash scripts/smoke-plugin.sh
PASS: manifest/static/package checks, 3 packaged Playwright/CLI tests,
      isolated Claude marketplace install, isolated Codex install

npm run check:size
PASS

python3 -m compileall -q \
  scripts/qa-replay.py qa/replay tests/test_qa_replay_facade.py
PASS

git diff --check
PASS
```

A direct package API smoke rejected an invalid fixture identifier through the
shared `CoordinatorError`, and the hyphenated executable rendered CLI help
successfully.

## Self-review

- Confirmed the diff contains only owned replay paths, the single baseline
  deletion, and this report.
- Confirmed the dependency graph is directional and acyclic; no leaf imports
  the facade, promotion, or Chrome code.
- Audited every core run open: only `secure_io` creates `_RunStorage`, and
  prepare/evaluate/lifecycle/cleanup close the retained binding in `finally`.
- Audited cleanup preflight/sanitize/verify: each phase uses descriptor-relative
  child names, same-entry checks, the retained root descriptor, and the
  preflight-owned `_CleanupTree`.
- Mentally mutated facade routing for roots, `_verify_identity`,
  `_authenticated_request`, atomic marker publication, exclusive rename,
  cleanup sanitization, oracle evaluation, and `_prepare`; focused tests would
  fail for each broken seam.
- Confirmed JSON projections, stderr diagnostics, CLI exit codes, suggested
  prompts, signed tombstones, report retention, and cleanup idempotency against
  the existing replay suite.

The full suite emitted the existing two `ResourceWarning` messages from the
unrelated workspace launcher test while still passing; replay tests emitted no
warnings. The facade is exactly at the 500-line policy limit and
`cleanup_preflight.py` has two lines of headroom, which is a maintenance
constraint but not a functional blocker.

## Review round 1: legacy seam and metadata restoration

### Status and scope

Complete against review base
`c888021ad5dc4f5d59990783360fcb89c1836076`. This round changes only the
already-owned replay facade, replay leaves, facade regression tests, and this
report. It makes no promotion, recorder, Chrome, Store, fixture, scenario,
PDF, browser, packaged-runtime, or baseline change.

This section supersedes the earlier statement that core orchestration does not
use the tuple compatibility adapters. The legacy tuple seams are now the
required facade interception boundary. Each adapter transfers its already-open
descriptors, and orchestration immediately adopts those exact descriptors into
`_RunStorage`; it never reopens a descriptor from a returned path.

### RED

The review regressions were added before production changes:

```text
python3 -m unittest tests.test_qa_replay_facade
......FFFFF
Ran 13 tests in 0.456s
FAILED (failures=24)
```

The failures proved all requested defects:

- `_prepare` did not call the patched `_new_run_directory`.
- route resolution, lifecycle recording, and evaluation did not call the
  patched `_load_run`.
- cleanup did not call the patched `_open_run_for_cleanup`.
- all 16 named helpers exposed the bound `_runtime` parameter instead of their
  legacy signatures and metadata.
- all four invariant comment blocks, comprising nine explanatory lines, were
  absent from their extracted leaves.

Because the intentionally patched prepare seam was bypassed during RED, that
one test reached the real detached server start. The exact child started by
that test was identified and terminated; a process audit confirmed no residual
`qa.server` child. Once the seam was restored, the test failed before server
startup by construction.

### GREEN implementation

- `prepare._prepare` calls the facade runtime's `_new_run_directory`.
- `lifecycle._resolve_route`, `lifecycle._record_transition`, and
  `evaluate._evaluate` call the facade runtime's `_load_run`.
- `cleanup._cleanup` calls the facade runtime's `_open_run_for_cleanup`.
- `_RunStorage.adopt_legacy` takes ownership of the transferred root/run
  descriptors without a path lookup or reopen. Cleanup retains the exact
  canonical path supplied by `_open_run_for_cleanup`; prepare/load consumers
  operate only on the transferred descriptors and returned run root.
- The 16 reviewed helpers are ordinary facade functions with the exact legacy
  parameter lists, annotations, `__name__`, and `__module__`. They still pass
  the live facade runtime into their directional leaf implementations, so
  nested monkeypatch points remain live.
- CLI compatibility now owns the frozen legacy star-export inventory and its
  runtime namespace adapter in `qa/replay/cli.py`. Internal storage and cleanup
  tree helpers stay owned by their leaves. This is the responsibility movement
  that creates facade headroom; no statements or comments were packed or
  deleted for line count.
- The endpoint-current-policy, HTTP-boundary, detached-`Popen`, and
  retry-capability/shutdown invariant comments were restored verbatim in
  `auto_submit.py`, `server_control.py`, and `cleanup.py`.

Focused GREEN:

```text
python3 -m unittest tests.test_qa_replay_facade
.............
Ran 13 tests in 0.075s
OK
```

An independent executable comparison against the original monolith confirmed
all requested metadata dimensions rather than relying only on the frozen test
table:

```text
python3 -c '<load base and current; compare signature/name/module/annotations>'
16 legacy helper metadata contracts match base
```

### Descriptor and cleanup identity ownership audit

- `_new_run_directory`, `_load_run`, and `_open_run_for_cleanup` each detach
  exactly the already-validated descriptors from their temporary storage owner.
  Their corresponding orchestrator adopts those same integer descriptors and
  closes them in its existing `finally` path.
- No new `os.open` occurs between a legacy seam and adoption. Prepare performs
  its existing run-directory binding check before writing. Loaded-run state is
  validated while the same descriptor is still owned by the adapter. Cleanup
  carries forward the adapter-supplied canonical run root and both descriptors.
- Store traversal, report/tombstone publication, marker recovery, and deletion
  remain descriptor-relative. The signed tombstone construction and
  verification code is unchanged.
- `_CleanupTree` creation, root identity, manifest, child identities,
  sanitize, deferred `run.json`, and post-sanitize verification remain inside
  `cleanup_preflight.py`. Moving its two new internal helper calls out of the
  facade did not reconstruct a tree or weaken any legacy facade patch point;
  all historical recursive sanitizer/verifier seams still use the live facade
  runtime.
- Existing adversarial replay tests for run-parent replacement, cleanup-open
  swapping, pathname-deletion refusal, mid-sanitize entry changes, retained
  shutdown capability, every sanitization interruption, signed tombstone
  recovery, and server identity mismatch all pass.

### Final line counts and baseline

```text
scripts/qa-replay.py                    497
qa/replay/__init__.py                    24
qa/replay/auto_submit.py                488
qa/replay/cleanup.py                    391
qa/replay/cleanup_preflight.py          498
qa/replay/cli.py                        157
qa/replay/evaluate.py                   183
qa/replay/lifecycle.py                  188
qa/replay/prepare.py                    388
qa/replay/report.py                     252
qa/replay/run_state.py                  136
qa/replay/secure_io.py                  490
qa/replay/server_control.py             298
tests/test_qa_replay_facade.py          468
```

Every owned source/test file remains below 500 physical lines. The facade has
three lines of headroom and the maximum leaf remains
`cleanup_preflight.py` at 498. This review round does not modify
`.source-size-baseline.json`; the original Task 5D delta remains exactly the
single replay-facade baseline deletion.

### Verification

```text
python3 -m unittest tests.test_qa_replay_facade
PASS: 13 tests

python3 -m unittest discover -s tests -p 'test_qa_replay_*.py'
PASS: 61 tests

python3 -m unittest \
  tests.test_qa_oracle_events \
  tests.test_qa_oracle_semantics \
  tests.test_qa_oracle_sessions \
  tests.test_qa_readiness_oracle
PASS: 45 tests

python3 -m unittest discover -s tests -p 'test_job_apply_policy_*.py'
PASS: 19 tests

python3 -m unittest discover -s tests -v
PASS: 795 tests, 2 opt-in browser skips

bash scripts/smoke-plugin.sh
PASS: manifest/static/package checks, 3 packaged Playwright/CLI tests,
      isolated Claude marketplace install, isolated Codex install

npm run check:size
PASS

python3 -m compileall -q \
  scripts/qa-replay.py qa/replay tests/test_qa_replay_facade.py
PASS

git diff --check
PASS
```

The full suite again emitted only the two pre-existing `ResourceWarning`
messages from the unrelated workspace launcher test. Replay tests emitted no
warnings. A post-replay process audit found no detached replay server.

### Self-review

- Compared each of the 16 helper signatures, names, modules, and annotation
  dictionaries directly with the base monolith and confirmed exact equality.
- Traced every reviewed facade seam from wrapper to leaf and mentally mutated
  each call back to its prior storage helper; the focused regressions fail in
  that state.
- Audited ownership from open through detach, immediate adoption, operational
  use, and `finally` close. No bound descriptor or cleanup identity tree is
  recreated from a path.
- Rechecked the restored comments against all nine original explanatory comment
  lines and added a source contract that names their correct extracted leaves.
- Ran oracle/readiness, policy, and the full Python suite once, then re-ran the
  focused and all-replay adversarial suites after the final no-path ownership
  simplification. Package smoke, source size, compilation, and whitespace
  validation were also run against that final implementation.
- Confirmed the final diff contains only replay-owned source/tests and this
  report, with no baseline delta in this review round.

Remaining maintenance concern: the facade has three lines of headroom,
`cleanup_preflight.py` two, and `secure_io.py` ten. These are not functional or
release blockers, but future responsibilities should be added to directional
leaves rather than these near-limit files.
