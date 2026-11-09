# Exact POSIX timestamp primitive

This inert prerequisite exposes an asynchronous `utimensat` operation through
Node-API 8. It does not activate a launcher, implement artifact copying, or
establish HOST/DIST acceptance. The separate addon is `timestamps.node`;
`flock.node` is unchanged.

## Scope and interface

Owned files are `native/posix/timestamps.c`,
`src/package/posix-timestamps.ts`, `tools/build-native-timestamps.mjs`, and this
document. Independent tests and emitted runtime belong to the integrating owner.

`loadPosixTimestampProvider(absoluteAddonPath)` loads only an explicitly selected
artifact and returns `setTimes(path, atimeSeconds, atimeNanoseconds,
mtimeSeconds, mtimeNanoseconds, followSymlinks): Promise<void>`.
The path is a Buffer; seconds are bigint; nanoseconds are integral numbers in
0 through 999999999; following is an explicit boolean. The native operation
requires exactly six arguments. Invalid direct native calls throw before queuing;
syscall failures reject the Promise. The TS provider maps native errno categories
through the shared Python filesystem error adapter.

`setTimesNs(provider, path, atimeNs, mtimeNs, followSymlinks)` accepts a string
path and bigint total nanoseconds. It encodes UTF-8/surrogateescape bytes, rejects
NUL as ValueError, and uses floor division for negative timestamps. Native Buffer
NUL rejection is an argument TypeError. Neither interface rounds through a
floating-point seconds value. Native seconds must fit signed time_t losslessly;
this does not impose a signed-64 total-nanoseconds year-2262 limit. Filesystem
range and resolution remain properties of the actual filesystem.

Buffer identity uses a captured Buffer.isBuffer predicate because Node 22
Node-API accepts some plain typed arrays in napi_is_buffer. The predicate and
receiver references belong to the exported function and are released by its
finalizer, without cross-environment global state.

The native operation validates arguments and copies path bytes before queuing
`napi_async_work`. The worker owns its copied path and times until completion;
subsequent caller Buffer mutation cannot change the path. The worker calls
`utimensat(AT_FDCWD, ..., follow ? 0 : AT_SYMLINK_NOFOLLOW)` without retry or
suppression. Work and allocation cleanup run on completion, including syscall
failure. Relative paths retain process-cwd semantics; the primitive does not
promise directory containment or immunity to concurrent path replacement.

## Development build and evidence

The builder is explicit, accepts a new absolute output directory and local Node
headers, and never runs from the loader. Compilation is bounded to 30 seconds
and 1 MiB. Its receipt records source, headers and artifact SHA-256, Node version,
Node-API version, platform and architecture. Failed builds remove only their
new output directory. No installation, download or compiler discovery fallback
is added.

Initial native macOS arm64 compile/smoke observed atime -600 ns and mtime
1700000000123456789 ns exactly through bigint stat after the asynchronous call.
TypeScript checking and source-size checks passed. This developer smoke is not
an independent acceptance receipt; the integrating owner supplies focused tests.

The independent focused suite now reports 17 passes, zero failures and one
explicit skip on native macOS arm64 with Node 22.22.3. It checks independently
varied access/modification timestamps, negative fractions, near-second carry,
Unicode paths, denied traversal, missing/non-directory paths, following and
not following symlinks (including dangling links), invalid arguments before
effects, path-buffer ownership, build provenance and loading with an empty PATH.
The last case uses the existing absolute Node executable and is not fresh-host
distribution acceptance.

Testing found that this Node's `napi_is_buffer` also accepts a plain Uint8Array.
The implementation now captures `Buffer.isBuffer` and its receiver at addon
initialization. References belong to the exported function's finalizer, with
no process-global or cross-environment reference. Tests verify Uint8Array,
DataView and ArrayBuffer rejection before queuing. Independent review found no
actionable defect in this fix or the async allocation ownership.

For requested mtime 10000000000123456789 ns, Python's actual `os.stat` observes
9223372036854775807 ns after the addon call. Python 3.14's own `os.utime(ns=...)`
on the same file produces that same observed value; Node's stat agrees. This is
observed baseline parity at the host's limit, not an exact far-future timestamp
claim. The case passes by comparing actual native behavior, not by skipping a
mismatch. The remaining skip is a filename containing byte 0xff: native file
creation reports EILSEQ before the timestamp operation can run.

## Remaining gates

The frozen artifact-copy reference proves that double-based Node utimes loses
precision. This primitive supplies exact timestamp arguments, not complete
Python copy2 behavior. Copy-time source-stat ordering, atime evidence, nonzero
flags, platform-specific xattrs and partial-copy failures remain separate work.
No ACL, ownership, durability, rollback or cancellation guarantees are added.
Native Linux, native Windows, other CPU architectures, supported OS floors,
packaged signed artifacts and fresh-host launch remain unaccepted. Windows is
explicitly unavailable rather than emulated. Mac development evidence cannot
substitute for any of those cells.
Environment teardown, allocation/queue failure and installed-binary attestation
remain untested. Header hashes are sampled before compilation; development build
receipts do not establish a final reproducible or attested release artifact.
