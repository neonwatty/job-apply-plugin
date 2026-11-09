# Next reference packages after JSONL and timestamps

These packages advance the existing dependency map. They do not change node or
subset acceptance requirements and may run concurrently in disjoint files.

## History reading and identity

Allowed files for one reference owner:

- `tools/contracts/history-read-idempotency/reference.py`
- `tools/contracts/history-read-idempotency/support.py`
- `tests_js/history_read_idempotency_reference.test.mjs`
- `docs/migration/history-read-idempotency-reference.md`

Capture actual Python history validation, streaming reading, canonical comparison
and `_history_event_is_idempotent_locked` using owned synthetic files. Existing
TS object/version validation and numeric parser are reusable, but the real
history validator, streaming reader and compact non-ASCII canonical text are
not implemented. The JSONL encoder is not a canonical comparator: it adds
spaces/newline and rejects surrogates when encoding bytes.

Required cases include read/write event-policy asymmetry, missing schema,
optional fields, blank and physical-line labels, CR/CRLF, BOM, invalid UTF-8,
JSON/validation failure ordering and text read-ahead boundaries. Include duplicate
IDs with all-equal and mixed-collision records, reordered keys, numeric identity
and surrogate-containing canonical strings. Multiple invalid optional fields
must not invent a fixed first-error order where Python set iteration varies.

After independent reference review, split validation/canonical implementation
from native streaming-reader implementation, with a separate test owner. Root
integrates real history identity with the existing append primitive. Whole-file
decoding cannot replace streaming without evidence for failure ordering. Full
journal validation/recovery remains a later dependency.

## Artifact-copy metadata ordering

Allowed files for a separate reference owner:

- `tools/contracts/artifact-copy-order/reference.py`
- `tools/contracts/artifact-copy-order/support.py`
- `tests_js/artifact_copy_order_reference.test.mjs`
- `docs/migration/artifact-copy-order-reference.md`

Keep the existing nine-case metadata reference frozen. New snapshots must record
metadata before verification reads: the older snapshot reads bytes before stat
and therefore cannot establish access-time behavior.

Capture actual copyfile/copystat ordering with distinct atime/mtime, a controlled
post-data source timestamp change, source-stat failure after data, timestamp
failure, reversible nonzero flags, clearing target flags and suppressed versus
propagated flag errors. Include conflicting same-name attributes on existing
targets and source attributes copied to new targets. Exact syscall arguments,
continuation to later files and partial-copy outcomes must be witnessed.

Local Python lacks its xattr API, so generic native attribute copying would not
automatically match this profile. Linux xattr behavior and Windows copying need
their own native evidence. Source-stat timing, flags and atime observations are
prerequisites to the copy orchestrator, not proofs of full installed acceptance.

Both references bind source/stdlib hashes and Python 3.12/3.13/3.14 profiles,
reject external input and use disposable trees. Required aliases or capabilities
that are absent remain explicit unobserved cells. Independent review, exact
scenario assertions, size/matrix/inventory checks and immutable provenance are
required before downstream implementation consumes the references.
