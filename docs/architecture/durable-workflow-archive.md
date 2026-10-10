# Durable workflow archive experiment

The implemented fixture-only v2 Store uses a finite immutable archive to preserve exact accepted
receipts while reclaiming bounded hot metadata. The experiment requires explicit
synthetic-fixture migration. v1 remains readable and unchanged without migration;
older readers reject v2 instead of accepting an archived operation ID as new.

## Storage and publication

The root in workflow metadata names at most 32 immutable segments. Each segment
uses the workflow ledger codec and retains at most 64 task snapshots, 256 receipts,
and 1 MiB of JSON code units. The total horizon is finite: at most 8,192 archived
receipts plus the hot ledger. Count and serialized-size limits can stop acceptance
earlier. Exhaustion rejects new operations and preserves all replay history.

Before a new accepted operation, the adapter may stage a pure compaction plan when
hot capacity approaches its reserve. The current active or waiting task and its
pending request binding remain hot. Older receipts, including active-task receipts,
move with their task snapshots. The adapter exposes union history for authorization,
exact replay, and operation/task collisions. Failed authorization and replay do not
publish compaction.

Commit first writes and synchronizes immutable private segment files, then publishes
the new root and hot ledger through the existing atomic jobs replacement or claim
journal. A published journal references already durable segments. Recovery validates
both current and pending roots before canonical writes. An interrupted publication
can leave unreferenced segment data; it is never replay evidence. Cleanup accepts
only the exact owned private archive namespace while holding the Store lock.

## Lookup and confidentiality

Each transaction validates and loads at most 32 bounded segments. This deliberately
finite experiment has a fixed upper read bound; it does not claim indefinite Store
capacity. Exact operation IDs and fingerprints remain available with exact receipt
snapshots. Repeated snapshots for an active task must retain identity and monotonic
revision; the latest task drives historical authorization even after job trash.

The archive contains only the closed task/receipt ledger shape. It never stores
broker bearers, browser capabilities, approval grants, or applicant answers. Replay
cannot recreate private broker authority. Current authorization precedes history
publication, and corruption or missing committed segments fails closed.

## Activation and limits

The experimental host accepts `archive activate --root <fixture> --native-lock
<artifact>`, `archive inspect` with those same paths, and `archive compact`.
Activation checks the synthetic fixture marker before and inside the Store lock,
recovers existing work, validates v1 history, and atomically publishes the v2 root.
It preserves task revisions, receipt bytes, selections, and metadata timestamps.
`inspect` reports hot counts, committed segment counts, and the finite limit.
`compact` publishes a plan only when the same pressure threshold is reached.
There is no automatic upgrade on ordinary reads or application commands.

Compaction plans when hot tasks reach 63, hot receipts reach 253, or serialized
metadata exceeds 768 KiB of JSON code units. The newly accepted task/receipt must
still satisfy the strict hot codec bound. The archive stops adding segments at 32;
remaining hot slots remain usable under the existing claim recovery reserves.
At exhaustion, `history_full` rejects acceptance before domain work. The upper
8,448-receipt count is a format ceiling, not a guarantee: task pressure, receipt
size, and reserved claim slots can end acceptance earlier.

Each segment stores its own closed v2 ledger with an empty archive root. Repeated
active-task snapshots are allowed across successive segments with a stable subject
identity and workflow, monotonically increasing revisions, and no terminal task
resurrection. Resume request/fact scope may advance between revisions; historical
receipts retain their original scope exactly. Equal-revision task snapshots must
be canonically identical. Duplicate operation IDs across segments or hot state
fail closed even when their payloads match.

The archive directory is `workflow-archive` (0700), with SHA-256-named JSON files
(0600, owned, one hard link) and one recognized `.pending` file. Inventory examines
at most 34 entries; individual files are bounded to four times the segment code
unit limit before reading. Missing, malformed, hash-mismatched, foreign, linked,
or oversized committed data raises `workflow_archive_corrupt`. An unpublished
private segment or pending file remains disposable; cleanup occurs only on the
next authorized segment publication, after ordinary recovery and validation.

## Focused verification

The archive leaf suite exercises 70 terminal tasks plus 320 active receipts,
exact replay/collision/revocation, waiting-binding preservation, full 32-segment
capacity, unpublished interruption recovery, task resurrection, and corrupt or
unsafe files. The native suite performs 70 preparation lifecycles plus 260
successive broker-loss recoveries, preserves saved sessions, and replays an
archived acquisition after supported job trash without restoring a bearer.
A pending claim's missing/corrupt segment blocks ordinary and bootstrap recovery
before writes. Process-kill tests exercise archive write/sync/publication, claim
journal publication, hot-root replacement, and journal clearing. A separate
seven-boundary process-kill regression starts resume extraction from pressured v1
history and verifies both bootstrap and ordinary recovery through the first v2
publication; unpublished data grants no replay authority.

This is a deliberately finite synthetic experiment. Sustained production use
requires a separately designed growing index or an explicitly accepted finite
retention horizon. Backup/restore must retain jobs metadata and every referenced
archive segment together; copying only hot jobs history loses accepted receipts.
