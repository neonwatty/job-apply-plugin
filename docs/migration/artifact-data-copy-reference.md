# Data-only artifact copy reference

This bounded reference uses actual `shutil.copyfile`, its `copyfileobj` fallback,
and `scripts/smoke/artifacts.py` preflight in newly created disposable trees.
It complements the existing copy-metadata and metadata-order references. It does
not change their baseline or claim installed-package acceptance.

The 34 cases comprise 13 native direct-copy cases, 15 controlled buffered-stream
cases, two controlled accelerator cases and four critical-path preflight cases.
External arguments/stdin are rejected; source/stdlib and interpreter executable
hashes identify the observed CPython profile. Tests cover Python 3.12, 3.13 and
3.14 explicitly; missing interpreter aliases remain unobserved cells.

## Behavior established

Native success covers existing/new targets under explicit copy umasks 022/077,
empty data, and data spanning more than two fallback chunks. Existing target
permissions remain 0600; new files use 0666 filtered through the copy umask.
Native failures include missing source and directory destination. The source
opens before the target, so source-open failure preserves existing target bytes;
destination-open failure closes the opened source. Same-path and hard-link
aliases are rejected before streams open. Source/destination FIFOs are rejected
without opening/blocking. Direct no-follow source copying creates a symlink;
destination symlinks are followed. Outer package preflight rejects symlinks and
FIFOs before any `copy2` call, including a defect after earlier inventory entries.

Controlled buffered cases disable available accelerator flags, leaving actual
`copyfile`/`copyfileobj` and native `open(..., 'rb'/'wb')` buffered file objects.
A wrapper injects exceptions at stream read, write and context-manager exit
boundaries; these are not kernel/device faults. They cover early and second-chunk
failures, a short-write result, pre-close failures that leave owned descriptors
open, post-close failures, and nested read/write/target-close/source-close
exception precedence. `copyfileobj` ignores a short write return value rather than
retrying its unwritten suffix; the resulting prefix bytes are explicitly bound.
The small target data can remain buffered when an injected pre-close failure
prevents flushing; file-size witnesses are captured before harness cleanup.

The actual selected accelerator helper is replaced only in its two dedicated
cases. Unsupported-without-mutation signals `_GiveupOnFastCopy` and reaches the
fallback; a second helper writes and flushes seven bytes, observes those bytes
before raising, and demonstrates a propagated partial-mutation failure. These
are controlled helper outcomes, not evidence that a device generated such a
failure. Linux may select another helper after an unsupported first helper;
that native host's fallback sequence still needs acceptance evidence.

Copy buffer lengths are profile-sensitive: inspected Python 3.12/3.13 use 65536
bytes and 3.14 uses 262144 bytes on these POSIX profiles. Tests bind scenario IDs,
input/output hashes and small byte strings, precise stream call arguments,
whole path sets and kinds, modes, mtime changes, errors/contexts and descriptor
witnesses independently. Large multichunk byte equality is established by length
and SHA-256 over the independently constructed deterministic payload. Snapshots
capture timestamps before verification reads; access time is recorded but excluded
from no-content/mode/mtime/ctime-change comparisons because reads can change it.
Harness cleanup closes only its own retained streams and removes its trees.

## Remaining gates

This reference does not establish actual raw-buffer flush/device failures,
resource exhaustion, all accelerator errno policies, native Windows, unobserved
Linux behavior, power-loss durability, xattrs/flags/ACL copying or complete
artifact installation. Development source/executable hashes do not attest all
loaded operating-system libraries or a reproducible release. A TypeScript data
copy implementation must be selected and independently verified against these
intermediate effects before composing the already frozen metadata operations.
