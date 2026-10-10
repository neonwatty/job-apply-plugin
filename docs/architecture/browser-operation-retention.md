# Browser operation retention and recovery

The durable synthetic browser boundary now retains terminal operations outside the
hot jobs document. The canonical Store lock still governs every read and commit.
This remains experimental plugin code with synthetic browser evidence. Archive
records never grant approval, a claim capability, or permission to submit.

## Organization

- `src/contracts/workspace/browser-operation-archive.ts` defines closed immutable
  segment references and the finite archive bound.
- `src/store/native-browser-archive-files.ts` validates the private filesystem
  namespace and publishes immutable, content-addressed segments.
- `src/store/native-browser-archive.ts` validates global identities and stages
  rollover, keeping unresolved operations in the hot ledger.
- `src/store/native-browser-operations.ts` makes segment publication precede the
  atomic canonical jobs update, while preserving unrelated Store data.
- `src/app/browser-recovery-guidance.ts` produces a public recovery summary without
  opaque value references, applicant values, or claim capabilities.
- `tests_js/workspace_browser_archive*.mjs` covers pressure, native execution,
  interrupted publication, corruption, history replay, and the finite horizon.

## Versioning and publication

Existing version 1 ledgers remain valid and retain their representation until the
first committed rollover. Version 2 adds `archive`, with version 1 ordered
references `{digest, operationCount}`. A segment contains a version 1 browser
ledger with only `verified` or `rejected` operations. Workflow-task archives remain
independent. An older decoder rejects the new closed schema rather than resetting
or silently ignoring retained operation IDs.

Preparation validates every referenced segment and builds a complete history
lookup. At 63 hot operations or approximately 768 Ki JSON code units it stages
terminal records for archival. Pending and uncertain records remain hot. A read,
replay, failed proposal, or inspection does not publish the staged rollover.
On commit the segment is written, synced, renamed, and its directory synced before
the atomic jobs publication makes its reference authoritative.

The `browser-operation-archive` directory is owned by the current user and mode
0700; files are regular, singly linked, owned, mode 0600, bounded, and opened with
no-follow checks. Segment hashes cover their complete UTF-8 bytes. Referenced
counts, payloads, and globally unique operation IDs are validated. Even identical
IDs in two locations are corruption. Segments cannot contain unresolved effects.
Canonical and pending extraction references are checked before recovery writes.

An interruption may leave a private unreferenced segment or `.pending` file. Its
path and file properties are validated, but it never supplies replay history.
A later publication can remove disposable unreferenced data under the Store lock.
No referenced segment is evicted. Missing, malformed, aliased, or nonprivate
referenced data causes a closed `invalid_browser_state` failure.

## Finite capacity and handoff

The bound is 64 hot operations plus at most 32 segments of up to 64 terminal
operations each, with a 1 Mi JSON code-unit hot bound. Actual retained capacity
can be lower because rollover starts early or payload sizes reach the byte bound.
This is a finite replay horizon, not indefinite compaction or a counter reset.
When no further segment can be published, new operations fail with
`capacity_reached` before dispatch. Exact historical replay still requires current
authority and returns the recorded receipt. Changed input under an existing ID
conflicts. Neither replay nor archival retries a browser write.

`NativeBrowserOperations.inspect()` reads the committed ledger without preparing
or publishing a rollover. `browserRecoveryGuidance` reports hot/archive counts, remaining segment slots,
and one unresolved operation ID. `reconciliation_required` recommends explicit
read-only reconciliation or human handoff. A fresh observation, a new operation
ID, a new process, or archival never clears the Store-wide uncertainty barrier.
If readback cannot prove the effect, preserve the draft and hand off; do not delete
Store state or repeat the mutation. At `capacity_reached`, hand off the current
browser draft and stop automated writes. Extending retention requires a further
versioned migration; creating a replacement Store is not a supported reset.

Synthetic draft preservation is not evidence that a real ATS draft survives.
Live host and browser capabilities require their own demonstrated integration.
