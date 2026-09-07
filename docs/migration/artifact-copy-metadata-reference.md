# Artifact copy metadata reference

Prepared against `d17a910`. This reference calls the actual
`scripts/smoke/artifacts.py::copy_critical` and the selected interpreter's
`shutil.copy2`. It is prerequisite evidence for a later TS copy leaf, not an
implementation, distribution choice or HOST acceptance receipt.

Allowed files: `reference.py` and `support.py` under
`tools/contracts/artifact-copy-metadata`,
`tests_js/artifact_copy_metadata_reference.test.mjs`, and this document.
All bytes, paths and attributes are synthetic and owned by temporary directories.
No Store or caller path is accepted. Arguments/stdin are rejected. No software
was installed; imported fixture modules do not write bytecode caches.

## Exact observations

Nine cases per interpreter distinguish four native copy scenarios from five
scoped failure injections. Three native cases set exact source nanoseconds:
`1700000000123456789`, `-600`, and `1767225600999999500`.
The fourth observes synthetic user attributes on the focus file. Each source
file starts mode 0640; each target starts mode 0600 with different bytes.
The wrapper asserts exact source/destination paths and copy2's
`follow_symlinks=False`. Focus-file copystat calls require the actual regular-file
`follow_symlinks=True`, exact source mtime nanoseconds and source permission mode.
The utime access-time argument is type-checked but not frozen as behavioral evidence.

Python copy preserves the exact source mtime nanoseconds and mode on all observed
profiles. A separate Node native test requested `1700000000123456789` through
double-based `utimes`; actual mtime was `1700000000123456000`. That API cannot
satisfy this observed precision contract. No approximation is approved.

On these macOS Python builds, `os.setxattr` is absent. The already-installed
`/usr/bin/xattr` reads/writes only owned files to observe native user attributes.
The source receives `user.job_apply_synthetic` with bytes `synthetic\0\xff`; the
target starts with `user.job_apply_target_only` containing `retained`.
Actual Python copy2 leaves the source attribute uncopied and retains the existing
target attribute. A port must not infer that copy2 always copies user attributes.
Profiles exposing Python's xattr API have a distinct expected union of source
and existing target attributes, requiring native execution before acceptance.

Only these deliberately seeded `user.job_apply_*` attributes are recorded.
System-generated attributes are excluded from this bounded observation; no ACL,
quarantine, resource-fork or arbitrary attribute preservation is claimed.

## Failures after preflight

Each injected failure occurs on the second file in sorted inventory,
`runtime/data.bin`; the first manifest has already been copied. Later files
retain their original target bytes and metadata. The actual production loop and
copy2 are retained; injection wraps copy2 or the target-only utime/chmod call.

| Failure point | Focus file after failure |
| --- | --- |
| Before second copy | Original target bytes/mode/mtime |
| After copyfile data | Source bytes, original target mode, newly changed mtime |
| After full copy2 | Source bytes/mode/exact mtime |
| During copy2 utime | Source bytes, original target mode, newly changed mtime |
| During copy2 chmod | Source bytes/exact mtime, original target mode |

All five propagate OSError/EIO. No rollback or cleanup restores earlier copies.
The complete owned path set remains unchanged, with no temporary/recovery
artifacts. This captures deliberate fault injection, not real disk-full or
permission-failure mechanics. Source snapshots remain unchanged.

## Evidence and limits

Closed receipts bind exact case IDs/timestamps/native flags, Python version and
platform, actual production source SHA-256 and the selected stdlib shutil file
hash. Tests independently verify payload digests, sizes, modes, signed-nanosecond
mtimes, flags, selected user attributes, copy event order, partial results and
complete before/after path sets. File reads exclude atime from assertions.
Exact access-time behavior and nonzero native flags need separate evidence.

Run `node --test tests_js/artifact_copy_metadata_reference.test.mjs` with the
existing Python 3.12 alias on PATH. Local result: six tests passed, zero failures
or skips; nine cases each on CPython 3.12.13, 3.13.13 and 3.14.4. Default python3
repeats 3.14.4, adding no independent profile. Capture is bounded to 20 seconds
and 1 MiB; native xattr commands are bounded to three seconds each.

Absent xattr APIs/tools or a supported native ENOTSUP capability failure produce
explicit partial profile skips. Other setup failures fail capture. Native
Windows and Linux have not been accepted by this macOS run. Copy-file races,
short writes, actual filesystem fault recovery, ACLs and platform-specific copy
acceleration remain open. Independent review and immutable freeze precede the
TS metadata implementation; full installed-package and rollback gates remain.
