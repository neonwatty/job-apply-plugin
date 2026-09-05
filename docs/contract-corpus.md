# TypeScript migration contract corpus

This foundation freezes a deliberately small first slice of the authoritative
Python Store interface. It is evidence for future differential TypeScript work,
not evidence that the full migration contract is complete.

## Frozen in this slice

The committed `python-store-read-v1` vector records the exact ordered command
inventory obtained from the real Store parser. The inventory contains 98 public
commands. Nine read-only commands currently have golden behavior:

- `profile-inspect` and `profile-preparedness-get`
- `fact-group-list`, `job-list`, and `resume-list`
- `resume-extraction-request-list` and `resume-proposal-list`
- `history-list` and `session-list`

The same vector freezes corrupt and future-version profile rejection. Those
rejections must preserve the input bytes, input mtime, and canonical Store tree.
Every successful read in this slice must also leave canonical bytes and mtimes
unchanged. The transient Store lock is excluded from this comparison because
lock acquisition may change its metadata without changing canonical state.

Capture uses only a tool-owned temporary directory. It injects the fixed clock
`2026-09-05T00:00:00Z`; captured reads use no nonces. A secret canary is placed
inside rejected ephemeral inputs, then the artifact is checked to ensure the
canary never reaches stdout, stderr, fixture descriptors, or committed JSON.
Owned temporary root paths in Python errors are normalized to `<store-root>`.
Captured process stream newlines are normalized to LF so Windows does not create
a false differential; persisted Store bytes are never newline-normalized.

## Review and refresh rules

`tools/capture-python-contracts.mjs --output <temporary-path>` creates a new
candidate with exclusive-create semantics. It rejects caller-provided Store
roots, existing destinations, and every destination inside the repository.
Consequently it cannot refresh committed vectors. A maintainer must inspect a
candidate and deliberately add or update a golden through normal review.

`tools/verify-contract-redaction.mjs <vector...>` validates the supported
closed vector shape and rejects secret canaries and absolute filesystem paths.
Diagnostics are generic and never repeat rejected content or filenames.

## Explicitly pending

The other 89 Store commands are inventory-only, not behaviorally frozen here.
In particular, `automation-settings-get`, `employer-account-list`, and
`claim-status` currently cross lazy startup/write boundaries even after `init`;
they require write-aware disposable-clone contracts before read-only shadowing.

Still pending are mutation results, permissions and journal stages, crash and
restart recovery, legacy and trashed stores, all other corrupt/future documents,
authenticated HTTP routes, and the task, attempt, QA, and policy command
families. Full secret-bearing output projections and platform parity also remain
pending. No Python removal or TypeScript writer cutover is justified by this
foundation slice.
