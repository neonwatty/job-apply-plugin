# POSIX byte-path reference

This package captures actual Python Path.resolve and managed-resume parent checks
on fixed synthetic paths. It does not approve permanent rejection of valid Python
byte paths by the future TypeScript adapter. No caller path/input or live Store
is accepted. Temporary fixtures are removed after capture.

Allowed files: the Python driver under `tools/contracts/posix-path-bytes`,
`tests_js/posix_path_bytes_reference.test.mjs` and this document.

Sixteen cases distinguish surrogateescape U+DC80–U+DCFF from invalid standalone
surrogates, actual invalid-byte names/targets, dangling targets, UTF-8 astral names
and NUL parent versus final component. The driver uses raw byte filesystem calls
and `os.fsdecode`; emitted JSON uses ASCII escapes so transport preserves every
Python string code point. Path outputs include filesystem-encoded hex where
encoding is possible, with only the canonical temporary root replaced by `<root>`.
Successful lexical high-surrogate leaf paths explicitly have no encodable hex.

Complete before/after snapshots contain relative path hex, kind, mode, mtime,
file SHA256 and link-target hex. Reads exclude atime from preservation checks.
Every observed case must leave these snapshots unchanged. No mocked result is
used for native filename support.

On the current macOS filesystem, creation of invalid UTF-8 filenames fails with
an illegal-byte-sequence error. Five cases requiring such names are marked
unavailable, and their profile test is skipped after checking the remaining
observations. Actual invalid-byte symlink targets can still be created and
observed. Linux/native filesystem evidence is required to close those five
cells; do not turn their absence into a global accepted-input restriction.
Unavailable records retain the exact setup stage, exception class and errno.
Only EILSEQ is classified as this encoding capability gap; unrelated setup
failures abort rather than masquerading as unsupported filenames.

Observed boundary expectations: filesystem surrogateescape preserves arbitrary
bytes; high surrogates and U+DC7F fail encoding during resolution; NUL inside a
resolved parent raises ValueError. A final leaf containing NUL or a high surrogate
is returned lexically by the managed-path helper because only its parent is
resolved. Later IO validation is a separate caller boundary.

Run `node --test tests_js/posix_path_bytes_reference.test.mjs`. Provenance includes
Python version, platform, filesystem encoding/error policy and source hash.
Independent review is complete for the partial reference observations, and the
coordinator reran all three installed profiles. Immutable implementation receipts
and the missing native cells remain required before accepting a byte-path implementation.

After binding review, tests validate closed records/outcomes, actual source hash,
exact interpreter alias and encoding, fixed inputs/operations, and nonempty
complete snapshot witnesses including expected directories and byte link targets.
Local rerun with the supplied existing Python 3.12 alias observed 11 cases each
on CPython 3.12.13, 3.13.13 and 3.14.4. Five filename cells remain unavailable on
each profile: one input-rejection test passed and four profile runs were skipped
after their partial assertions, with zero failures. The default alias repeats
3.14.4 and does not add an independent profile.
