# Atomic JSON persistence reference

This bounded reference invokes the unchanged `atomic_write_json` in
`scripts/job_apply_store/io.py`, including its private-directory and directory
fsync helpers. It creates only owned temporary trees and never initializes a
Store. The executable rejects arguments and stdin. Its receipt binds the actual
source SHA-256, interpreter version, POSIX platform and explicit 4300-digit
integer conversion limit. Windows remains a separate, unobserved native lane.

`tools/contracts/atomic-write-json/reference.py` declares 34 fixed cases.
`support.py` wraps actual paths, temporary text files and OS calls. Successful
operations use the native filesystem; fault cases inject a deterministic error
at the named boundary. Those injected failures do not demonstrate actual disk
exhaustion, permission denial or physical media durability.

## Fixed contract

- Basic, large integer, float, negative zero, nonfinite float, subnormal, Unicode,
  empty containers, list and null payloads freeze exact persisted bytes. The
  runtime does not enforce its dictionary annotation. Output is sorted JSON with
  two-space indentation, non-ASCII characters and one final newline.
- Lone surrogate, unsupported set, circular value, mixed dictionary key types
  and integer conversion limit cases freeze serialization errors and cleanup.
  Python 3.12 writes two text chunks before mixed-key sorting fails; 3.13/3.14
  write one. This profile difference is explicit in the fixed tests.
- Existing parent, recursive missing parents, destination symlink, broken
  symlink, destination directory and parent-directory symlink cases freeze
  actual path following/replacement behavior. A replaced destination symlink's
  referent remains unchanged. Parent chmod follows a parent symlink.
- Faults cover mkdir, parent chmod, temporary creation, partial write, explicit
  flush, file fsync, temporary close, temporary chmod, replace, destination
  chmod, directory open/fsync/close, and cleanup unlink.
- Paired failures establish precedence: cleanup overrides replace/write;
  temporary close overrides write; cleanup FileNotFoundError preserves the
  original replace error. Error receipts name the winning and contextual
  synthetic stages. Other serialization/native errors retain their categories.
- Directory-open/fsync OSError is suppressed; ValueError at either boundary
  propagates. Directory-close failure propagates. Temporary and directory close
  injections occur after actual close, deliberately ensuring the harness does
  not leak descriptors. They establish control-flow precedence, not every
  possible native close-failure state.

Each case emits closed fields for input identity, target, fault stages, result,
operation trace with exact path/mode/temp-creation arguments and descriptor roles,
write-call count, descriptor closure and complete before/after
tree snapshots. Snapshots include bytes, SHA-256, mode, nanosecond mtime and
symlink target; atime is excluded. Random temporary names alone are normalized
to `<temp>`. Every preexisting fixture mtime starts at an exact fixed value.
Assertions bind previous document bytes and mode, new output, cleanup remnants,
referent preservation and parent chmod effects. Successful writes intentionally
change bytes/mtime; this reference does not claim general nonmutation.

The parent directory is chmodded before serialization. A failed write can
therefore change its mode/mtime while preserving the old document. A failure
after replacement leaves the new document installed. Neither condition is
represented as rollback. Creation of intermediate parents uses Python's actual
mkdir behavior and the process umask; only the final parent is explicitly 0700.

## Acceptance boundary

Run `node --test tests_js/atomic_write_json_reference.test.mjs`. Platform-default
Python is mandatory; missing versioned aliases are explicit unobserved profiles.
The tests verify closed schemas, exact source/version binding, corpus identity,
operation order and arguments, exact before/after path sets, fixed outcomes and
filesystem witnesses. Source-size checks
apply independently to both support and reference files.

This is the contract capture for an inert TypeScript writer. It does not accept
TS writes, cross-process exclusion, journal transactions, crash recovery,
power-loss durability, Windows permissions, or invalid-byte native filename
coverage. Those gates remain open. Existing anchors are
`tests/test_store_integrity.py` and the atomic IO case in
`tests/test_store_facade_contract.py`.
