# Artifact copy metadata ordering reference

This separate corpus leaves the frozen nine-case artifact-copy metadata oracle
unchanged. It calls actual `scripts/smoke/artifacts.py::copy_critical` and the
selected interpreter's shutil implementation on disposable synthetic trees.
No Store, personal paths, caller arguments or stdin data are accepted.

Production source baseline: `b1f4bb1`. The commit containing this document freezes
the executable reference and its tests; source and stdlib hashes bind each run.

Allowed files are `reference.py` and `support.py` under
`tools/contracts/artifact-copy-order`,
`tests_js/artifact_copy_order_reference.test.mjs`, and this document.

## Cases and observations

Twelve cases distinguish five native scenarios from seven controlled injections.
All wrappers bind exact source/destination paths and follow-symlink arguments;
stat, utime, xattr helper, chmod and chflags are observed only for the focus file,
which is second in sorted inventory. Every file's copyfile invocation is recorded.

| Case | Frozen observation |
| --- | --- |
| native-times | Real copying may change source atime. Destination receives both nanosecond values sampled by copystat after copying. |
| post-data-times | Real copyfile completes, then a controlled source timestamp change occurs. Destination receives atime 1500000000111111111 and mtime 1750000000222222222, proving metadata sampling follows data copying. |
| source-stat-error | Real copyfile has replaced data; copystat source stat raises EIO. Destination retains mode 0600; later files stay unchanged. |
| utime-error | Exact source atime/mtime arguments are observed, then EIO stops metadata processing. Destination retains mode 0600 with copied bytes. |
| source-flags | Native reversible UF_NODUMP source flag is applied to destination. |
| clear-target-flags | Zero source flags clear the destination's native UF_NODUMP flag. |
| flags-ENOTSUP | Injected flag error is suppressed; later copies continue. |
| flags-EOPNOTSUPP | The separately named unsupported flag error is suppressed; later copies continue. These errno values coincide on this Mac. |
| flags-EIO | Injected flag error propagates after timestamp/chmod changes; later files remain unchanged. |
| chmod-notimplemented | Injected NotImplementedError is suppressed even for this regular-file call. Flags and later copies continue while focus mode remains 0600. |
| xattr-existing | Different source/target values of one seeded attribute distinguish overwrite from retention. Local Python leaves the target value intact. |
| xattr-new | Source attribute is absent from the newly created target on local Python, including its native data-copy path. |

Real copyfile, copystat and the outer production loop remain active. Error and
post-data timestamp changes are explicitly marked injected in each receipt.
Native mode/flags/xattr fixture setup is separate from those injections.
Each injected flag failure requests nonzero UF_NODUMP against a zero-flag
destination; snapshots prove that failed flag updates leave the target at zero.
The successful source-flags case is the positive control.
The no-op `_copyxattr` helper is still called and its arguments are witnessed.
Local Python builds lack os.setxattr; absence of that API does not mean the
native filesystem lacks attributes. The installed Mac xattr tool observes only
the seeded `user.job_apply_copy_order` attribute.

## Measurement and verification

Initial source atime is 1600000000123456789 ns; mtime is
1700000000987654321 ns. Target values are each one second earlier.
All source and target metadata snapshots are collected before attribute tools
or file-content verification. Thus later digest reads cannot affect the atime
observations being asserted. Source atime after native copying is deliberately
not a fixed clock value: tests bind the selected source stat to exact utime
arguments, post-copy destination metadata and source metadata instead.

Tests assert closed case/profile/event shapes, exact case order, payload hashes,
mode and flag outcomes, complete path sets and continued or stopped copying.
Both successful and failing cases preserve the expected eight-file inventory;
the new-target case adds only its previously absent focus file. Flag teardown
clears the reversible flag on owned focus paths before directory cleanup.

Provenance binds CPython version, platform, capability profile, actual production
source SHA-256 and the selected shutil source SHA-256. The default interpreter is
mandatory; version aliases are verified against their returned Python family.
Missing aliases and native capabilities are explicit unavailable cells, never
silently accepted. subprocess calls are bounded to 20 seconds/1 MiB, and each
native xattr command to three seconds.

Observed on native macOS arm64: five tests passed with zero failures or skips;
12 cases each on CPython 3.12.13, 3.13.13 and 3.14.4. The default repeats 3.14.4
and adds no independent profile. Run the focused Node test with the existing
Python 3.12 alias on PATH; no installation is required.

## Limits

This is reference evidence for a later orchestrator, not copy2 implementation
or acceptance. A data-copy primitive that changes target mode before copystat
would violate the observed source-stat/utime failure boundary. Node copyFile
must not be assumed equivalent without independent evidence.

Linux xattr behavior and native Windows copying remain unobserved. Nonzero
UF_NODUMP is the only native flag tested; other flags, ACLs, ownership, system
attributes, resource forks and platform copy acceleration are not generally
covered. Injected failures prove ordering and partial results, not native
filesystem fault mechanics. Path races, durability, rollback, packaging and
fresh-host installation remain separate gates. Independent review and freezing
are required before this corpus is consumed as a migration prerequisite.

Coordinator review checked actual copyfile/copystat delegation, syscall argument
bindings, metadata observation timing and the closed expected effects. Review
strengthened flag-error cases to request nonzero source flags, so retained zero
target flags are a visible failure witness. The final combined history/copy-order
run passed ten tests with zero failures or skips across all installed profiles.
This accepts the bounded reference for freezing, with the stated limits intact.
