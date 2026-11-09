# JSONL append and pending-tail reference

Base: `d17a910`. This capture calls the unchanged
`CoordinatorPersistenceMixin._append_history_event_idempotent_locked` and
`_repair_pending_history_tail_locked` methods in
`scripts/job_apply_store/domains/coordinator/persistence.py`.
It creates disposable synthetic directories, binds the module runtime only
during each call, restores it afterward, and never initializes a Store.

The minimal namespace supplies `history_path` and two explicit boundary stubs:
the append idempotency gate returns false, true, or a synthetic failure; the
repair journal loader returns a pending operation or no operation. Actual
history-event validation, collision detection, canonical equality, history
reading, journal validation and recovery orchestration are excluded. The stub
does not claim to validate the synthetic payloads as real domain events.

The receipt binds the current source hashes, actual CPython version and POSIX
platform, with an explicit 4300-digit integer conversion limit. Arguments and
stdin are rejected before any fixture creation. Native Windows is unobserved.

## Captured behavior

The 43 fixed cases comprise 29 append cases and 14 tail-repair cases.

- Append captures ordinary and missing files, missing parents, destination
  directories, existing/broken symlinks, idempotency short circuit/failure,
  sorted Unicode and numeric bytes, and pre-open surrogate/cycle/integer-limit
  serialization failures. JSONL uses Python's default spaces after commas and
  colons, unescaped non-ASCII characters, and one final newline.
- A successful append opens with `O_WRONLY | O_CREAT | O_APPEND` and mode 0600,
  records the original size, loops over short writes, fsyncs, closes, and then
  sets private mode. Existing mode 0644 remains until that final chmod.
  Symlinks are followed, so their owned referent receives bytes and chmod.
- Zero and negative write returns cause the exact StoreError message
  `history append was incomplete`. Partial writes, write errors and an injected
  KeyboardInterrupt exercise the actual `except BaseException` rollback.
  Rollback truncates to the original byte size and fsyncs before rethrowing.
- Truncate, rollback-fsync and close failures demonstrate which exception wins
  and preserve its nested Python exception context. Failed rollback can leave
  appended bytes; successful rollback does not restore the prior file mtime.
  A final close/chmod error can leave the entire appended line installed.
- Append fstat occurs before its try/finally. Its injected failure leaves an
  open descriptor. A close failure is injected before native close and also
  leaves the descriptor open. The receipt counts these descriptors before the
  harness closes them safely; the leak is baseline evidence, not an endorsement.
- Tail repair captures no pending operation, missing/empty/complete files,
  partial final lines, a file with no newline, a short native read, and failures
  at open/fstat/read/truncate/fsync/close. It opens with `O_RDWR` and reads once.
  An injected five-byte read can therefore cause truncation to zero even when
  later bytes contain a complete line. This behavior is preserved as evidence,
  not silently normalized into a full-read loop.

Operations call the real filesystem except at declared injected boundaries.
Every descriptor operation checks that the descriptor belongs to the fixture.
Tests assert exact open flags/mode, each remaining write-byte slice, read lengths,
truncate sizes, chmod mode, operation order, exception categories/contexts and
leak counts. Complete before/after path sets include exact bytes, SHA-256, modes,
nanosecond mtimes and symlink targets. Initial mtimes are fixed; created/changed
content has a changed mtime. Read atime is intentionally excluded.

## Evidence and remaining gates

`node --test tests_js/jsonl_append_reference.test.mjs` runs the mandatory default
Python and the 3.12/3.13/3.14 aliases. Missing aliases are explicit unobserved
profiles. Local results: five tests passed, zero skipped, on 3.12.13, 3.13.13
and 3.14.4; the default duplicates 3.14.4. Every scoped file is under 500 lines.

Existing source tests include the partial-append rollback and pending-tail
repair cases in `tests/test_store_coordinator_persistence_extraction.py`, and
history identity cases in `tests/test_store_history_sessions.py`.

This reference does not accept a TypeScript append implementation, live Store
writes, domain idempotency, cross-process exclusion, races with external writers,
native disk-full/permission failures, power-loss durability, Windows behavior,
or full coordinator transaction/recovery acceptance. Those remain separate
gates. Close/rollback faults are controlled injections; filesystem success does
not establish hardware durability.
