# Native POSIX lock development checkpoint

Base: `d17a910`. This is an inert native-provider/TypeScript wrapper package.
No Store caller, live writer, launcher or installed-artifact contract changes.
The complete TX/NATIVE/HOST/DIST gates remain open.

## Ownership and design

migration_sequence owns `native/posix/flock.c`, `src/store/posix-flock.ts` and
`src/store/exclusive-file-lock.ts`. The coordinator owns the explicit development
build, native lifecycle/concurrency tests, size/inventory registration and runtime
emission. numeric_codec independently reviews source/build/tests and owns the
14-case differential fault test. Other workers capture append/copy references.

The Node-API 8 addon exposes only `tryLock(fd)` and `unlock(fd)`. Acquisition uses
`LOCK_EX | LOCK_NB`; false means actual contention, and other failures preserve
errno/code. It never opens or closes descriptors. Integer validation prevents
accidentally truncating a supplied descriptor. TypeScript owns the FileHandle
through callback settlement, using cancellable timers between contended attempts.
This avoids a blocking native call on Node's event loop or libuv worker pool.
Polling does not establish fairness or reproduce signal interruption semantics.

Keeping the descriptor in the writer process avoids the separate-helper hazard
where helper death could release a lock while the writer callback continued.
Caller process death instead lets the kernel release that caller's descriptors.
Waiting cancellation prevents callback entry. Held cancellation signals the
callback but retains the lock until it settles; cancellation is not rollback.

The wrapper retains the frozen Python open/chmod/acquire/callback/unlock/close
ordering. Existing chmod and unlock failure paths can leave descriptors open;
tests observe this before cleaning their own handles. This is recorded baseline
compatibility, not acceptance of leak-free production error handling. Any repair
must preserve the intended externally visible contract and be reviewed explicitly.

## Build and native evidence

`tools/build-native-lock.mjs` is an explicit development command requiring a new
absolute output directory. It uses existing Node headers and a local C compiler,
does not overwrite an existing output directory, bounds compiler execution and
removes its output on failure. Receipts bind source/header/artifact hashes,
platform, architecture, Node version and Node-API 8. Runtime loading takes an
explicit absolute artifact path and never builds, installs or downloads code.

The local test build uses Apple clang 21 and Node 22.22.3 headers on native
macOS arm64. Addons are built in owned temporary directories and removed after
testing. This does not select a release artifact, sign it, attest an installed
binary, establish minimum OS compatibility, or prove another host/CPU cell.

Native tests establish:

- Eight separate TypeScript processes each report actual contention behind a
  held owner, then complete serialized read/modify/write operations with total 8.
- An alias descriptor contends while the holder lives; a waiting process acquires
  after the holder is killed, without cooperative cleanup.
- A real competing descriptor remains blocked after held cancellation and the
  lock becomes available only after the callback settles.
- Repeated contended native calls allow event-loop progress; invalid descriptor
  arguments fail, closed descriptors report EBADF and independent opens contend.
- All 14 frozen Python failure cases reproduce call order, exact artifact
  bytes/modes, winning exceptions, context and actual open-descriptor witnesses
  across Python 3.12, 3.13 and 3.14. Default Python repeats 3.14.

The native suite passes 64 tests with no failures/skips when all three existing
interpreter aliases are available. A first coordinator invocation omitted the
temporary Python 3.12 alias and correctly reported a skip; the corrected full
native run supplies it and does not count the skipped invocation as acceptance.

The test matrix registers a dedicated native POSIX suite in full/platform tiers.
Source-size and migration inventory now include C/header files, with regression
tests at the 500/501-line boundary. No size exception was added or increased.
Runtime still contains one emitted JavaScript file per TypeScript source; native
binaries are not placed in that directory or checked into this checkpoint.

## Open completion requirements

The local lock proof does not accept whole transactions. Atomic-write/append/
journal integration, crash/restart recovery, interrupted syscalls, real device
faults, descriptor-reuse adversity and wider contention remain required.
Windows requires a distinct native locking implementation; Linux code exists but
has no native test result from this package. There is no fairness claim.

Prebuilt native artifacts, installed-byte inventory coverage, signing/attestation,
offline loading, minimum-host/CPU evidence, upgrade and rollback remain delivery
work. The current installed verifier does not yet include native artifacts.
Users are not required to compile at launch. Python remains the sole live writer.
