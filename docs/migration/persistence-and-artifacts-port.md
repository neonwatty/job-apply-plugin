# Atomic persistence and installed verification checkpoint

Base: `a4ddb1f`, which froze the independent Python references. These are inert
TypeScript leaves; no live writer, launcher, Store facade or bootstrap changes.
Parent TX, FS, SEM and DIST acceptance remain open.

## Ownership and interfaces

migration_sequence owns `src/contracts/persisted-json.ts`,
`src/store/private-filesystem.ts` and `src/store/atomic-write-json.ts`.
numeric_codec owns the independent atomic/serialization tests and fixture support.
validation_strategy independently reviews those sources and owns the separate
`src/package/artifact-paths.ts` and `src/package/installed-artifacts.ts` port.
The coordinator independently reviews/tests the artifact port and owns
`src/contracts/filesystem-error.ts`, emissions, inventory and test registration.

`iterPersistedJson` yields Python-style sorted, indented, non-ASCII text chunks;
the selected Python profile and integer digit limit are explicit. It accepts the
existing PythonJson representation, including null and lists. Dictionary keys in
that representation are strings; arbitrary non-string Python dictionary keys
are not a supported persisted-data extension. Strict UTF-8 encoding rejects
unpaired surrogates. Float spelling reuses the reviewed numeric primitive.

`atomicWriteJson` uses an injectable filesystem interface and a real POSIX
adapter. It preserves private-parent behavior, exclusive sibling temporary
creation, buffered writes, flush/fsync/close, mode changes, replacement,
directory fsync and cleanup/error precedence. Replacement is the state boundary:
later failure can report an error with new bytes already installed. This is not
a transaction or rollback API and does not acquire an exclusive Store lock.

`criticalPaths` and `assertCriticalBytes` port inventory and verification from
the installed-artifact helper. They preserve the current fixed files/critical
trees, byte equality, ignored mode differences, unrelated-file behavior and
declared-root alias resolution. Symlinks below the root and nonregular artifacts
are rejected. Copying critical artifacts is not implemented by this package;
its metadata/native semantics remain a separate required delivery leaf.

The shared filesystem error bridge retains the original native error object,
code, errno, message and stack while assigning Python's corresponding OSError
category. Explicit verification errors retain their established SystemExit
messages. Native diagnostic wording is not claimed to match Python strerror or
traceback formatting. Tests do not conceal category mismatches by renaming only
their expected results.

## Independent checks and corrected findings

The final combined run passes 282 tests with zero failures or skips. It includes
the three frozen references, new writer/serialization tests, artifact tests and
the filesystem error bridge. All installed Python 3.12, 3.13 and 3.14 profiles
are exercised; the default repeats 3.14 and adds no independent profile.

Atomic tests compare all 34 reference cases per invocation on separately owned
trees, with exact chunks, persisted bytes, paths, modes, mtime-change witnesses,
call order, closures and exception context. Seven additional unwrapped native
write cases, long filenames and 13 native buffering sequences are exercised per
profile. A deterministic corpus of 213 typed values compares text chunks and
strict UTF-8 outcomes directly to Python (seed 711983).

Independent tests/review found and retained regressions for:

- A sixteen-character temporary suffix that rejected valid long destinations;
  the native adapter now uses eight characters from the Python filename alphabet.
- Missing native filesystem error categories and paired sync/close context.
- Buffer visibility differences, including the exact Python 3.14 128 KiB
  boundary. The adapter distinguishes text buffering from the native binary
  buffer and retains the unwritten buffered suffix after a write failure.
- Setup cleanup ordering and collision-exhaustion error category. Actual Python
  post-open setup-failure probes establish close/unlink exception precedence;
  they are not a native fstat-failure experiment.
- An artifact scan that unnecessarily statted ordinary directory entries.
  A real readable/non-executable-directory regression now matches Python 3.14's
  suppressed descent failure using cached directory-entry classification.

Artifact tests compare 24 inventory/verification cases on separate trees for
each explicit profile. They also compare native missing-root/loop categories,
real permission behavior and unchanged file snapshots. A child process loads
the emitted verifier from a disposable package with empty PATH and performs
inventory/byte verification. It invokes no Python or network service, but uses
the existing absolute Node executable: this is local package evidence, not a
runtime distribution choice, actual host launch or fresh-host acceptance.

## Open acceptance work

Build emission is reproducible at 28 modules. Inventory has 295 source/manifest
rows; consistency still leaves 4,380 unmapped requirement cells. Neither source
counts nor passing local tests can close the migration acceptance gates.

Native Windows, Linux byte-path/current-directory behavior, full recursion and
caller limits, actual fstat/device partial-write/disk-full faults, interrupted
system calls, crash/restart recovery and physical durability remain unverified.
The buffered writer does not establish any power-loss guarantee. Eight competing
TypeScript writers require a real native lock provider; no process-local or
directory-lock substitute is adopted. JSONL append rollback and journals follow.

Artifact copy metadata, raw traversal-order/race behavior and full diagnostic
wording remain open. Existing QA profile failures, visible-browser opt-in cells,
CI restoration, Python-free required tooling and all final install/upgrade/
offline/post-write-rollback host cells remain required. No live Store is used by
these comparisons, and Python remains the sole live writer.
