# Private-file digest reference

This fixed synthetic driver calls the unchanged
`ResumeStorageMixin._private_file_digest` in
`scripts/job_apply_store/domains/resumes/storage.py`. It binds only the temporary
runtime provider's OS wrapper, stat, hashlib and actual `RESUME_MAX_BYTES` constant,
then restores the provider. No Store is initialized or live data opened.

Allowed files are `tools/contracts/private-file-digest/reference.py` and this
document. Independent tests, registration, immutable receipts and review belong
to other owners. No arguments, stdin data or caller-selected paths are accepted.

```sh
python3 -I tools/contracts/private-file-digest/reference.py </dev/null
```

## Evidence shape

The closed top-level shape contains `schemaVersion`, `provenance` and `cases`.
Provenance records Python implementation/version, platform, OS name, actual size
maximum, read-only/binary/no-follow flags and SHA256 of the authoritative source.

Observed cases record the fixed ID, native flag, input size/hash, exact returned
digest or error class/message, ordered operation events, byte count, opened and
closed descriptor counts, leaked count, race status, actual failed-open errno,
complete before/after tree snapshots and an unchanged flag. Events expose flags
and chunk-request sizes, never paths, descriptors or applicant values. Snapshots
use relative paths and link targets, permission modes, nanosecond mtimes and file
hashes; access times are excluded. Compare snapshots within a run, not timestamps
between separate captures.

Unavailable native cases contain only ID, status, native flag and reason. They
are not passes. Unexpected errors abort with `digest_reference_failed` without
printing paths or stack traces. Caller input rejection has its own fixed marker.

## Fixed cases and limitations

Sixteen cases cover empty/binary/multichunk content, exact 10 MiB and maximum plus
one, absent files/parents, directories, valid and broken symlinks, injected
open/fstat/read/close failures, and an owned path-to-symlink substitution before
the actual open call, plus file growth after descriptor metadata is captured.
All non-race cases must preserve their complete tree.

The native substitution case requires actual `O_NOFOLLOW` and symlink creation.
It replaces the input with a relative symlink to a synthetic foreign fixture
immediately before opening. Correct evidence is null digest, no bytes read, and
unchanged foreign-file bytes. Its expected tree change is caused by this explicit
test intervention; it must not be mislabeled as an unchanged-tree pass.

The OS wrapper forwards real opens, descriptor metadata reads, reads and closes.
Fault injections are identified by case ID. A close failure is injected after
the actual close, preserving the exception propagation contract without leaking
the fixture descriptor. The final cleanup probes every opened descriptor and
records leaks before closing any survivor. Injected faults are not proof of
actual permission denial, disk failure or kernel close-error behavior.

The `grow-after-stat` case captures real metadata for the 18-byte binary fixture,
then appends 10 MiB plus one byte of ASCII `x` before returning that original
metadata to the reference. Its full enlarged digest and 10,485,779 bytes read
prove the source checks size only initially; no new midstream cap is implied.
`racePerformed` is true for both sanctioned interventions. Initial input size/hash
remain distinct from the final snapshot, and `unchanged` is false for growth.

The source reads in 1 MiB chunks. Native ACL denial,
Windows reparse behavior, unsupported no-follow platforms, process interruption
and stable pre/post observation identity remain future explicit cells. Parent
directory containment and `_managed_resume_observation` are outside this leaf.

Independent tests must verify required event sequences, expected digests, narrow
OSError-to-null mapping, escaping close error, descriptor closure on rejection
and failure, and native unavailable handling. Passing this reference does not
accept the FS parent or authorize production activation.

Coordinator verification: all 16 cases observed on Python 3.12.13, 3.13.13 and
3.14.4; five tests passed with zero skips and no unavailable native cells on
this macOS host. Independent expected hashes/events verify initial-size-only
behavior, bounded read requests, descriptor closure and sanctioned mutations.
