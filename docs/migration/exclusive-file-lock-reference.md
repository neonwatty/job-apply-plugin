# POSIX file-lock reference checkpoint

Base: `1da7f3f`. This capture calls the unchanged `exclusive_file_lock` helper on
owned synthetic files with real POSIX flock calls. It initializes no Store and
never uses a live lock file. Windows emits unavailable evidence, not a pass.

Fourteen cases observe ordinary locking, existing bytes, a symlink lock file,
and failures at parent chmod, open, file chmod, acquisition, callback, release
and close. Combined failures establish which exception survives. Wrapper checks
assert exact file identity, open flags, permission arguments and flock operations.
Fixtures record complete before/after path sets, file kinds, bytes, modes and
link targets. Descriptors still open when the helper returns are counted before
the oracle closes them safely.

The current Python helper can leave a descriptor open after file chmod fails,
release fails or close fails. Unlock failure prevents the subsequent close call;
it can replace an earlier callback/acquire exception. These are observed baseline
behaviors, not claims that such leaks are desirable. Any repair must be tracked
explicitly rather than hidden by differential normalization. No TS lock provider
or implementation is selected in this checkpoint.

numeric_codec independently reviewed root's driver and test. Review required
exact argument checks, closed artifact path sets, schema checks and argument
rejection; all are included. Each receipt binds the current Python source hashes
and actual interpreter version. Tests exercise default Python plus installed
3.12, 3.13 and 3.14; the default duplicates 3.14 on this host.

This bounded reference does not include missing-parent creation/mkdir failure,
native permission denial, symlink races, process death, interrupted system calls,
eight-process contention, Windows locking or power-loss durability. Those remain
required before accepting the complete lock/TX node. Atomic-write capture owns
the next private-directory behavior evidence. No skipped or unavailable platform
cell may be treated as satisfied.
