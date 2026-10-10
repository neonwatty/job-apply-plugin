# Durable synthetic browser operations

This slice adds a Store-backed counterpart to the
[browser boundary experiment](browser-boundary-design.md). It remains a plugin
component using a synthetic adapter and a trusted embedding authority port.
It does not demonstrate host authentication, a supported live browser adapter,
external exactly-once effects, or automatic final submission.

## Files and ownership

- `src/contracts/workspace/browser-boundary.ts`: shared closed browser schemas;
  `src/integrations/browser/contract.ts` preserves the existing import path.
- `src/contracts/workspace/browser-operations.ts`: versioned operation ledger,
  immutable request fingerprints, strict receipt states, and monotonic commits.
- `src/integrations/browser/durable-contract.ts`: canonical transaction port.
- `src/integrations/browser/durable-boundary.ts`: durable proposal execution and
  explicit read-only reconciliation. The original memory-only boundary remains
  available for its existing consumers.
- `src/store/native-browser-operations.ts`: stages metadata-only changes under
  `ClaimRepository.claimTransaction`, publishing one atomic `jobs.json` write.
- `tests_js/workspace_durable_browser*.mjs`: isolated boundary, native publication,
  process interruption, corruption, concurrency, and replay fixtures.

Composition is explicit:

```ts
const store = new NativeBrowserOperations(repository);
const browser = new DurableBrowserBoundary(adapter, authority, binding, store);
```

Only the embedding supplies the adapter, authority, binding, and repository.
Model proposals supply the existing closed `BrowserMutation` shape. Values remain
opaque references, never applicant values, resume paths, credentials, or scripts.
All observations and receipts retain `synthetic_adapter` provenance.

## Code-owned state and execution

`jobs.metadata.durableBrowserOperations` contains schema version 1 and a map
from operation ID to immutable request, fingerprint, state, and public receipt.
The closed states are:

| State | Meaning | Next permitted transition |
| --- | --- | --- |
| `pending` | Intent committed; dispatch/completion may be unknown | uncertain, verified, rejected |
| `uncertain` | No matching completion proof available | verified, rejected if the original in-flight conditional call proves no effect |
| `verified` | Exact matching readback persisted | terminal |
| `rejected` | Original call proved no effect, or authority was revoked before dispatch | terminal |

A public pending/uncertain receipt remains `uncertain`; a rejected record returns
`not_applied`, preserving the existing receipt vocabulary. An authority rejection
after reservation uses the additional fixed reason `authority_denied`.

Execution parses and snapshots the proposal, checks existing operation identity,
requires fresh scope and current authority, then commits pending intent under the
canonical Store lock. After releasing the lock, it checks authority again to
close the Store I/O gap, then invokes the adapter's conditional mutation once.
The adapter must compare the exact form and observation revision before writing.
The boundary verifies a successful write using the existing exact private
readback comparison before committing a verified result.

No Store lock is held while calling authority or browser adapters. Authority may
inspect the canonical Store itself. Every state update rereads the current ledger
under lock. Concurrent instances cannot reserve another operation while one is
pending or uncertain, replace an operation's request, or downgrade a terminal
receipt. Duplicate delivery may return an uncertain receipt while the original
call is still in flight; it never issues a second write.

Current authority is required for historical replay and reconciliation. Changed
input under an existing ID conflicts. Changed task/attempt/authorization binding
cannot reuse a boundary. Unknown/final actions, arbitrary scripts, and malformed
provenance are rejected before adapter dispatch.

## Restart, interrupted publication, and recovery

Pending or uncertain state is a **Store-wide write barrier**, across tasks,
processes, and new boundary instances. A fresh observation does not clear it.
The boundary never resumes a recorded mutation after restart. Only explicit
`reconcile(operationId)` can read the original request's effect again. It checks
current authority and invokes readback only; it never invokes mutation.

Reconciliation requires the exact operation and request fingerprint, same form,
next observation revision, complete target with a private value match, and an
untouched final action. Absent, malformed, stale, or mismatching evidence keeps
uncertainty and the write barrier. No reset or automatic retry API is provided.
A crash after intent but before dispatch can therefore require human handoff,
even when no effect occurred. This is an explicit limitation of this experiment.

Atomic `jobs.json` publication provides the durable fence. A lost acknowledgement
of the pending write stops dispatch; a lost acknowledgement after verified
publication is recoverable by exact replay. A crash after browser effect and
before receipt publication leaves pending intent, requiring read-only
reconciliation. Filesystem errors are sanitized as `storage_unavailable` and
never converted into successful browser completion.

Jobs validation recognizes the optional ledger, and recovery preflight validates
browser ledgers in canonical and pending extraction jobs documents before publishing any recovery
destination, including history. Corrupt states fail closed with
`invalid_browser_state`. Other Store documents, metadata, facts, and preferences
are preserved byte-for-byte by normal browser ledger commits.

## Finite retention and pressure

The durable ledger preserves the existing **64-operation cap**, now Store-wide,
and is bounded to 1 Mi JSON code units. It never evicts operation IDs, prunes by
age, resets on a new task, or depends on in-memory state for replay protection.
A reservation also leaves room for its terminal representation. At capacity,
new operations fail with `capacity_reached` before adapter dispatch; historical
replay and read-only reconciliation continue. The workflow archive from PR #208
is independent and does not yet archive browser operations. Extending this
horizon needs an explicit durable replay-preserving migration, not an automatic
counter reset.

## Verification and remaining integration work

Focused tests cover two independent boundary instances, persisted intent before
mutation, reauthorization after reservation, authority using the canonical Store,
no-effect rejection, interrupted writes, replay, finite pressure, malformed state,
and a real child-process kill after intent publication. Synthetic adapter state
is never presented as evidence of a real ATS operation.

A production host still needs authenticated authority, a demonstrated conditional
browser write/readback mechanism, and a human handoff flow for unresolved effects
or exhausted retention. The current code owns the operation lifecycle without
claiming that those deployment capabilities already exist.
