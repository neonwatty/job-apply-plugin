# S04 point persistence reference

The bounded reference executes the unchanged original Python atomic writer and
coordinator JSONL append method on owned synthetic files. It instantiates no
public Store. Expected data is the frozen `reference-vectors.json`; Python
fixture construction never reads that file or uses TypeScript implementations.

The new corpus has 18 chunk cases, 10 atomic cases and 8 JSONL cases. The fixed
constructors retain scalar versus adjacent surrogate codepoints, insertion
order, actual shared list identity and actual cycles. Integer fixtures are
constructed arithmetically before the conversion limit is applied. Every case
restores the previous limit in `finally`.

Chunk observation separately exhausts the original encoder and encodes a fresh
sequence chunk by chunk with strict UTF8. This distinguishes a later serializer
failure from an earlier Unicode failure. Atomic observation delegates each
write/flush/close to the real temporary text writer. Separate read descriptors
observe buffering without flushing or seeking the writer; post-close stat and
bytes are captured before replacement or cleanup. The final LF is a separate
asserted write. JSONL observation delegates to actual `json.dumps`, then uses a
small `str` subtype solely to observe the existing LF addition and strict
`str.encode` call. It preserves text contents and delegates those operations to
the original built-ins. Gate identity, serialization/encoding order, requested
write suffixes and positive write counts are checked. No native single-write
guarantee is inferred.

The output retains complete error graphs, Unicode error objects and positions,
production event order, and before/after file trees. Inodes, device IDs, sizes
and nanosecond timestamps are decimal strings. Tests compare exact deterministic
bytes/modes and within-capture inode/time relationships; atime is observed but
not required unchanged. Native snapshot reads are observational, not counted as
production flush/fsync operations. Faults are explicitly synthetic EIO at the
frozen close, unlink, target-chmod and gate boundaries.

Each actual interpreter reports its resolved executable/hash, exact version,
platform, machine, byte order, filesystem policy, loaded module origins/hashes,
and the complete 15-file original local import closure plus three reference
modules. Tests independently probe interpreter and required stdlib/native module
origins, rehash reported files, and compare original source bytes to manifest
pins. Built-in origins are tied to the independently checked executable hash.
The entry rejects all caller arguments and nonempty stdin with exact exit2 and
one LF-terminated diagnostic; no caller-selected path is accepted.

Development checks passed on Darwin arm64 with default CPython3.14.4 and explicit
3.12.13, 3.13.13 and 3.14.4 aliases. The point cell passed five literal tests,
observing all36 cases per alias, with zero skips. The baseline cell passed two
literal wrappers; each preserves and strictly validates the complete unchanged
child TAP, requiring all five original profile/refusal names with zero skips,
failures, cancellations or TODOs. These cover the original34 atomic and43 JSONL
cases. Full raw point output and child TAP are retained as diagnostics with exact
stdout hashes; seven outer results do not stand in for the underlying counts.

The initial development point log exposed a test representation mismatch:
frozen fault descriptors are records while actual fault declarations are stage
strings. The assertion now compares the recorded stage list and independently
checks complete error fields and ordered effects. Neither expected vectors nor
original Python behavior changed. Successful development logs are external
`S04-points-development-final.tap` and `S04-baselines-development-final.tap`; coordinator
capture and independent acceptance of a committed subject remain separate.

This is evidence for owned POSIX fixtures on the stated host and versions.
Linux/Windows effects, raw-byte filenames, physical durability, crash recovery,
live Store concurrency and product TypeScript behavior are not accepted by it.
The fixed small-fixture buffering observations are not a general buffering
contract. All original references, vectors, manifests and configuration remain
unchanged by the implementation worker.
