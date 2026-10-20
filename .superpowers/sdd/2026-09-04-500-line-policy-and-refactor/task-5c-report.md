# Task 5C report: promotion transaction decomposition

## Status

Complete. `qa.promote` is now a 341-line compatibility facade over the
directional `qa.promotion` package. All owned source and test files are at or
below 500 physical lines, and the sole `qa/promote.py` size-baseline entry was
removed.

Base: `b84e09eecb2a7ceea3bbfe104b1e6c6b12dcd670`.

## Scope

Changed only the owned promotion surface:

- `qa/promote.py`
- `qa/promotion/{__init__,bindings,candidate,approval,destination,deletion,rollback,transaction,cli}.py`
- `tests/test_qa_promotion_facade.py`
- `.source-size-baseline.json`, removing only `qa/promote.py`
- this required report

No recorder, replay, Chrome, Store, browser, or packaged runtime source was
changed.

## TDD evidence

RED was established before implementation with:

```text
python3 -m unittest -v tests.test_qa_promotion_facade
```

The five-test contract run had the expected split-boundary result: the legacy
CLI patch-point characterization passed, while the frozen `__all__` contract
failed because the monolith had no `__all__`, and the package/import/CLI tests
failed because `qa.promotion` did not yet exist (one failure, three errors).

After implementing the minimum split and compatibility runtime, the same run
passed all 5 tests. The pre-existing candidate, transaction, security, and
recorder-filesystem tests supplied the behavioral RED guard for the refactor's
privacy, descriptor, failure-injection, rollback, and exclusive-rename seams.

## Decomposition and compatibility

- `bindings.py` owns the private-session descriptors, identity and mount
  checks, permission checks, bounded reads, and atomic candidate writes.
- `candidate.py` owns compilation, artifact snapshots, denied-term handling,
  privacy scanning, and review-manifest validation.
- `approval.py` owns timestamps, reviewer validation, approval creation, and
  exact approval validation.
- `destination.py` owns retained destination descriptors, ancestor identity
  validation, overlap rejection, and staging writes.
- `deletion.py` owns the preflight identity tree and descriptor-relative,
  identity-rechecked recursive deletion.
- `rollback.py` removes only the installed directory whose retained identity
  matches the transaction receipt.
- `transaction.py` consumes bound capabilities; it does not reopen candidate,
  destination, or private-session paths. Its opens and stats use retained
  directory descriptors and direct child names.
- `cli.py` owns parser construction and command dispatch.
- `qa/promote.py` remains the import and executable facade.

The facade freezes the exact 43-name legacy star-import inventory. Public
functions keep their historical signatures and docstrings. `PromotionError`,
private binding classes, constants, recorder `BrokerError`, and the public
`exclusive_rename` / `exclusive_rename_available` capability seam retain one
shared identity at the facade boundary. The small package API exports only
`PromotionError`, `compile_candidate`, `approve_candidate`,
`promote_candidate`, and `main`.

Compatibility wrappers pass the live facade module as an explicit runtime to
the leaves. Consequently existing monkey-patches of `qa.promote` helpers,
standard-library modules, compiler/privacy validators, descriptor checks,
exclusive rename, deletion, and rollback continue to affect the split code.
No leaf imports `qa.promote`; a clean-process contract verifies that importing
`qa.promotion.transaction` does not load the facade.

## Transaction and identity review

- Candidate artifacts are still read once into an in-memory snapshot and the
  installed fixture is written from those exact bytes.
- Privacy scanning remains value-free on failure and candidate ABA replacement
  remains detected before install.
- Destination ancestors and the private parent/session/candidate remain bound
  to retained descriptors and revalidated before mutation.
- Deletion still preflights depth, total/per-directory entry limits, device,
  mount, kind, and inode; deletion rechecks every planned node.
- The exclusive install remains no-replace and maps broker diagnostics to the
  same stable promotion errors.
- Before tombstoning, cleanup failure rolls back the exact installed fixture.
  After tombstoning, incomplete cleanup retains the installed fixture and
  tombstone as before.
- Rollback reopens only the direct installed child beneath the retained
  destination descriptor and verifies its recorded identity before removal.

## Line counts and baseline

```text
qa/promote.py                         341
qa/promotion/__init__.py               16
qa/promotion/approval.py              129
qa/promotion/bindings.py              472
qa/promotion/candidate.py             271
qa/promotion/cli.py                    51
qa/promotion/deletion.py              301
qa/promotion/destination.py           220
qa/promotion/rollback.py               68
qa/promotion/transaction.py           289
tests/test_qa_promotion_facade.py      147
```

`.source-size-baseline.json` changed by exactly one deletion: the former
1,375-line `qa/promote.py` exception. No ceiling was added or raised.

## Verification

```text
python3 -m unittest -v \
  tests.test_qa_promotion_candidate \
  tests.test_qa_promotion_transaction \
  tests.test_qa_promotion_security \
  tests.test_recorder_fs
PASS: 43 tests

python3 -m unittest -v tests.test_qa_promotion_facade
PASS: 5 tests

python3 -m unittest discover -s tests -p 'test_qa_*.py' -v
PASS: 287 tests, 2 opt-in browser skips

python3 -m unittest discover -s tests -v
PASS: 782 tests, 2 opt-in browser skips

bash scripts/smoke-plugin.sh
PASS: manifest/static/package checks, 3 packaged Playwright/CLI tests,
      isolated Claude marketplace install, isolated Codex install

npm run check:size
PASS

python3 -m compileall -q \
  qa/promote.py qa/promotion tests/test_qa_promotion_facade.py
PASS

git diff --check
PASS
```

A direct real use of the new package API also compiled, approved, promoted,
and removed an isolated private session successfully. Module CLI help and a
failing approval invocation retained the expected parser text, empty stdout,
value-free stderr, and exit code 1.

## Self-review

- Confirmed the diff contains only the owned promotion paths, the single
  baseline deletion, and this report.
- Confirmed all leaf imports are directional and none imports the facade.
- Audited every `open` and `stat` in `transaction.py`; each mutation-time call
  is descriptor-relative.
- Confirmed the public exclusive-rename capability check is still performed
  before opening promotion inputs.
- Mentally mutated facade runtime routing for `_read_regular_at`,
  `_scan_snapshot`, `_open_destination_binding`, mount identity,
  `_deletion_entry_identity`, `exclusive_rename`, `_destroy_bound_session`,
  and rollback; focused tests would fail for each broken seam.
- No functional concern found. `bindings.py` is the largest leaf at 472 lines,
  leaving 28 lines of policy headroom.

The full-suite run emitted two `ResourceWarning` messages from the unrelated
workspace launcher test while still passing; no promotion descriptors or
tests produced warnings.
