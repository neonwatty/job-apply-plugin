# JSONL transaction primitive package

Reference revision: `d1b90ed`. This package consumes the 43-case
[append and tail reference](jsonl-append-reference.md) and the existing native
POSIX lock provider. It advances TX; it does not accept the coordinator, its
journal validation, or the complete TX node.

## Ownership and acceptance

The implementation worker owns `src/contracts/jsonl-json.ts`,
`src/store/jsonl-history.ts` and `src/store/jsonl-history-io.ts`.
The independent test worker owns `tests_js/jsonl_history_ts.test.mjs`,
`tests_js/jsonl_history_support.mjs` and `tests_js/jsonl_json_ts.test.mjs`.
The coordinator owns runtime emission, inventory/matrix registration and
`tests_js/jsonl_lock_integration.test.mjs`. None owns a live Store, facade,
bootstrap or shared journal dispatch in this package.

Local verification requires exact output bytes, operation ordering, short-write
slices, rollback sizes, errors and nested contexts, permissions, mtime changes,
and open-descriptor witnesses for every frozen reference case. Tests run against
the installed Python 3.12, 3.13 and 3.14 reference profiles. Serialization checks
must distinguish numeric identity and preserve whitespace inside strings.

Cross-process checks combine the actual native flock provider with the emitted
append implementation on owned disposable files. Eight writers must each observe
contention, then leave eight complete unique records despite synthetic retries.
Process-death checks must witness partial or completed append bytes before killing
the owner, acquire through a contending waiter, repair under ownership and show
that repeated repair converges. These predicates and pending-operation callbacks
are synthetic test boundaries, not substitutes for domain identity or journals.

Typecheck, deterministic emission, source-size, inventory, matrix and the commit
gates must pass. An independent reviewer examines implementation and tests before
the checkpoint can be called locally verified. Required native host cells remain
separate evidence; no missing host is counted as a pass.

## Remaining integration gates

Caller recursion/resource limits, complete event validation and collision policy,
actual pending-journal loading and validation, other domain writers, all named
crash boundaries, real device faults and final native host cells remain open.
Controlled process death demonstrates process recovery on this filesystem, not
hardware power-loss durability. Python remains the sole live Store writer.

Exact artifact metadata copying proceeds on the independent HOST/DIST lane.
That lane must resolve nanosecond precision and platform metadata behavior before
claiming copy parity; Node's floating-point timestamp interface is insufficient.

## Local execution evidence

The coordinator ran the two differential/serialization suites and the native
integration suite together: 223 tests passed, zero failures and zero skips on
native macOS arm64, Node 22.22.3, Python 3.12.13/3.13.13/3.14.4. The default
Python repeats 3.14.4. Each interpreter invocation covers the 43 frozen cases,
ten unwrapped native filesystem cases and 212 deterministic typed JSON values
(seed 819171). Native integration adds the eight-writer test and the two killed
writer boundaries described above.

The first invocation reported two unavailable-Python-3.12 skips because an old
temporary command alias had expired. Restoring an alias to the already installed
interpreter produced the complete passing run; skipped results are not acceptance.
The independent read-only reviewer found no bounded compatibility defect in the
implementation, differential harness or process-death assertions. This receipt
does not close any of the remaining integration gates above.
