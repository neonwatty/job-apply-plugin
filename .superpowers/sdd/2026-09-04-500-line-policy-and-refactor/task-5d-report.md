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
