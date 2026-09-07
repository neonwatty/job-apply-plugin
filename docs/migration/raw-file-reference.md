# Raw-file read reference

This synthetic-only package captures `scripts/job_apply_store/io.py`'s
`read_json_object` directly. It does not initialize a Store, write application
data, port filesystem code or claim whole FS acceptance.

Allowed files are `tools/contracts/store-raw-read/reference.py` and this document.
Independent tests, registration, immutable receipt binding and review belong to
other owners. The driver accepts no arguments, input paths or nonempty stdin.
It creates and removes its own temporary directory separately for every case.

Run with an existing interpreter:

```sh
python3 -I tools/contracts/store-raw-read/reference.py </dev/null
```

The independent test may exercise available version-specific aliases. Missing
interpreters are unavailable evidence, never proof of parity. No installation is
performed by the driver.

## Closed output shape

The top-level fields are `schemaVersion` (1), `provenance` and `cases`.
Provenance records implementation, exact Python/Unicode versions, platform,
OS name, integer digit and recursion settings, and the source IO module SHA256.
Every case has `id`, `inputHex`, `status`, `native`, `outcome`, `before`, `after`
and `unchanged`. Input hex is null where no input file exists.

An observed outcome is either `{kind: "value", json: <exact compact sorted
ensure-ASCII Python spelling>}` or `{kind: "error", name, message, cause}`.
Only the temporary fixture root in legacy error messages is replaced with
`<fixture>`; the remaining message and exception/cause classes are preserved.
This explicit fixture-path binding prevents machine paths entering receipts.
It does not normalize interpreter wording or turn distinct errors into passes.

Snapshot entries contain relative `path`, `kind`, permission `mode`, decimal
`mtimeNs`, file `sha256` or null, and relative symlink `target` or null. The root
directory and every descendant are included; links are never followed during
snapshot traversal. Access times are deliberately excluded because reads may
change them. Complete before/after arrays are compared within each case.
Timestamps vary between captures, so compare outcomes and provenance separately
from the per-run preservation assertion; do not claim byte-identical whole runs.

Symlink creation failures produce `status: "unavailable"`, `native: true`,
`outcome: {kind: "unavailable", name}`, empty snapshots and `unchanged: null`.
An unavailable native case is not accepted or passed. Other setup failures abort
with a fixed error marker rather than emitting paths or partially trusted data.

## Required fixed cases

The 22 fixed IDs cover empty and typed objects, future schema version accepted
without validation, duplicate keys, multibyte UTF-8,
invalid/truncated UTF-8, BOM, CRLF and bare CR, empty/malformed files,
array/scalar/null roots, missing files/parents, directories, file and broken
symlinks, symlink parents, and a 4301-digit integer. The checked-in driver owns
all bytes; caller-controlled files cannot be substituted through its interface.

The low-level helper follows symlinks. Caller-level session/path security checks
remain separate: a future port must not silently claim stronger low-level policy
or substitute this reference for native identity-race tests. The driver records
actual symlink behavior on its host; it provides no Windows reparse evidence on
macOS. It does not test permission denial under privileged runners, FIFO/device
blocking, substitution races, production nesting limits or directory access ACLs.
Those remain explicit future FS/caller cells.

Python decoding is strict UTF-8; BOM rejection and text newline handling must be
preserved by future byte ingress. Root type rejection is a StoreError after
decoding. Integer digit-limit ValueError is not caught by this helper's narrow
exception boundary. These distinctions must survive integration with typed JSON.

## Verification receipt

Coordinator verification observed all 22 cases on CPython 3.12.13, 3.13.13 and
3.14.4, using the existing temporary 3.12 alias. Five tests passed with zero skips
and zero native-unavailable cases on this macOS host. Independent fixed assertions
cover exact bytes, response/error/cause spelling and unchanged snapshot trees.
Interpreter families, Unicode versions and integer/recursion settings are checked.
The full-tier test matrix explicitly registers the reference tests.

Windows behavior, permission-denial fixtures, special files and identity races
remain unverified. This is a bounded raw-reader reference, not whole FS acceptance.
