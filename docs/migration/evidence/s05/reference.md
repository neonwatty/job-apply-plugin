# S05 point path reference

The new fixed corpus observes actual `os.fsencode`/`os.fsdecode`, the original
managed-resume parent validator, and the original cache observation and private
digest methods. It constructs 24 codec inputs, 16 records and eight cache
sequences independently of the frozen expected JSON. No public Store, user
files, browser or TypeScript implementation is used.

Codec observations preserve adjacent surrogate codepoints and use the actual
UTF8/surrogateescape filesystem policy. This differs from JSON surrogatepass
byte decoding. Managed-parent delegates retain actual `Path` joins/resolution,
record access and comparison order. Injected resolve errors are synthetic EIO;
the historical pair-error labels intentionally retain the frozen ASCII
`file.bin` recipe. Successful results are lexical paths with separately observed
filesystem encoding, not successful native leaf opens. Invalid-parent Unicode
errors retain the complete actual object and coordinates. Assertions resolve
only the extant temporary ancestor independently and preserve every remaining
owned component, including the `/private` prefix relationship.

Cache observations use original Python dictionaries and independently built key
objects. Native descriptor reads provide actual digests. Path/stat/clock/cache/
hash/descriptor calls are recorded at their delegate boundaries. Frozen logical
predicates such as identity equality and TTL comparison are separately asserted
from exact captured metadata/cache/clock and actual hit/miss behavior; they are
not fabricated call events. Equality, insertion order, retained original key
identity, zero-age hits, exact-TTL misses and numeric aliases remain explicit.
All inode/device/size/nanosecond fields are lossless decimal strings. Complete
before/after snapshots preserve file bytes/modes/identity/times, except atime is
observed and deliberately unconstrained. Only link/outside cases create those
objects; every created fixture object appears in the checked tree.

The executable accepts no caller arguments or nonempty stdin and rejects after
reading at most one byte. Four fixed aliases must launch successfully and
identify actual CPython3.12/3.13/3.14 versions; default may duplicate one. The
capture records executable/source/loaded-module hashes, and tests independently
probe executable and required stdlib/native module origins, including split
pathlib packages and built-in origins tied to the executable hash. The complete
15-file original local import closure and three new reference modules are
checked. Full raw observations and independent probe output precede assertions
in TAP diagnostics, alongside exact stdout hashes.

The two separate baseline cells directly execute the four unchanged Python
reference drivers. Their independently copied closed expectations bind original
assertion-source hashes. They cover38 managed-path,16 byte-path,16 descriptor
and18 observation records per profile. These direct-driver checks are distinct
from running the original Node test files. Their source and diagnostics are
coordinator-owned; the new point worker does not edit them.

Five macOS invalid-byte-name setup obligations remain open:

- resolve-byte-directory
- resolve-byte-file
- resolve-byte-link
- managed-byte-parent
- managed-byte-link-parent

Their exact EILSEQ setup observations are validated by the baseline reference;
a passing record test does not accept the corresponding native operations.
Linux/Windows and owner-environment/native launch behavior are not established.
The cache reference specifically exercises POSIX non-null identity behavior.

Development initially exceeded the150000-byte per-profile cap because unused
outside directories and both symlinks were included in every fixture snapshot.
Failures are retained in `S05-points-development-1.tap` and
`S05-points-development-2.tap`. Setup now creates those
objects only for cases that use them, without removing required observations or
changing expected values, case counts or budgets. Provenance stores a file path
only when it differs from the recorded origin; tests independently reconstruct
and rehash every file, with a closed conditional schema. This removes duplicate
strings, not observations. The second run also found a constructor omission of
the fixed ASCII 'id' prefix in the escape-versus-scalar cache keys; the constructor
was corrected to the frozen vectors, which remain unchanged.

Development then passed all five point literals on actual default3.14.4,3.12.13,
3.13.13 and3.14.4, zero skips, retaining all48 cases per alias. The two unchanged
coordinator baseline cells already passed their eight literal tests across those
profiles. The complete package has13 outer tests; new48 and old88 cases per
profile remain distinct. Coordinator capture and acceptance of exact committed
source remain separate from these development results.
