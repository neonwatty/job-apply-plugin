# Frozen history reading and identity reference

This package calls the actual Python `SessionHistoryMixin.read_history`, both
history validators, `normalization._canonical_json`, and the coordinator's
`_history_event_is_idempotent_locked`. No Store is constructed or initialized.
Every file belongs to a newly created disposable tree; production Python is
read-only. It advances the history dependencies of TX, not complete journal or
coordinator acceptance.

Production source baseline: `b1f4bb1`. The reference package is frozen by the
commit containing this document and its executable tests; receipts bind the
actual source hashes rather than relying on the baseline label alone.

## Cases and evidence

The reference has 117 cases: 34 native reader cases, 32 record validations,
32 write validations and 19 composed identity cases, plus seven direct canonical
serializer cases. Values are represented as ASCII JSON text to retain number
spelling. Canonical string code points additionally preserve the distinction
between a literal Python surrogate pair and a Unicode scalar, which JavaScript
string transport alone cannot represent distinctly.

Reader cases include missing/empty files, symlinks and directories, unterminated
records, blank Unicode whitespace, CR and CRLF normalization, physical line
labels, unknown event names, version errors, BOM, malformed JSON, malformed UTF-8,
duplicate keys, integer digit limits, and 8191/8192-byte decoder boundaries.
A nearby invalid UTF-8 byte can prevent the first record from reaching validation;
a distant invalid byte allows the earlier record error to win. Observations use
the actual native text iterator, without replacing its buffering or decoding.
Runtime wrappers record JSON input text and object/version/record callback order;
they forward arguments to the unchanged actual functions.

Validation cases distinguish future event identifiers accepted on read from the
known-event policy on write. They cover required fields, ASCII identifiers and
length boundaries, optional null/string policy, and the absence of schemaVersion
checking in the write validator. Multiple invalid optional fields do not have a
universal first-error assertion: Python set iteration selects the error. Tests
run seeds 0, 1 and 2 and report each observed result, requiring read/write
validator agreement within a process. The runner disables site initialization
and unsafe path injection, removes PYTHONPATH/PYTHONHOME, and deliberately does
not use `-I`, which would ignore PYTHONHASHSEED. Effective flags and the seed
are recorded and asserted.

Identity cases call the real reader and validator, including exact incoming
object identity. They establish no-match short-circuiting, all-equal duplicate
records, first/mixed collisions, canonical-call short-circuit order, schema
integer/float/bool distinctions, Unicode and surrogate comparisons, and the
requirement to finish reading history before comparing any matching records.
Malformed later history must fail even when an earlier matching event is equal.

Before/after snapshots compare complete path sets, bytes, SHA-256, mode, size,
mtime, ctime and link targets. Incoming event serialization must also remain
unchanged. Snapshots exclude access time because reads can update it; equality
is a final-state no-content/mode/mtime/ctime-change witness, not an assertion
that no access-time effects occurred.

Each receipt binds seven production source hashes, relevant Python stdlib file
hashes, executable bytes and the observed CPython/platform/integer-limit profile.
External arguments or stdin are rejected without emitting a receipt. Tests use
independently written, closed scenario IDs, exact fixture bytes/incoming values,
ordered callback arguments/results and complete wrapped-cause details (including
decoder byte windows and error positions). The reordered-key case deliberately
uses a different physical key order. No golden update operation exists.

## Scope still open

This is a finite POSIX reference, not a TypeScript implementation or native host
acceptance. Native Windows, device faults, resource exhaustion, arbitrary
recursion limits, every text buffering configuration, permission failures during
`exists()` and injected close failures remain separate evidence. Source hashes
must be frozen to the reviewed commit before a downstream port consumes them.
The stdlib hashes identify Python sources; the executable hash identifies the
interpreter used, not all operating-system libraries or a reproducible host.

## Independent review and execution

Review required stronger independent fixture bytes/incoming values, a closed
117-case identity set, exact ordered callback arguments/results and complete
wrapped errors. Those assertions now include decoder chunk positions and JSON
positions. The reordered-key fixture was also corrected to write genuinely
different physical key order; the test independently expects those bytes.
The reviewer accepted the resulting bounded reference with no remaining findings.

The coordinator's final combined history/copy-order run passed ten tests with
zero failures or skips. History runs Python 3.12.13, 3.13.13 and 3.14.4 under
effective hash seeds 0, 1 and 2; the default interpreter repeats 3.14.4. These
reference checks do not accept a downstream TypeScript port or close the limits
listed above.
