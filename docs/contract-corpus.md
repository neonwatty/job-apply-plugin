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

The separate `python-store-startup-read-v1` vector covers the three commands
that cross lazy write boundaries after `init`: `automation-settings-get`,
`employer-account-list`, and `claim-status`. Eight disposable-clone cases freeze
their control-document bootstrap, second-run idempotence, and pre-write rejection
of corrupt or future controls. The account cases prove that both reads preserve
a valid pending account-operation journal byte-for-byte. The coordinator case
freezes the opposite behavior: `claim-status` rolls a valid pending `recover`
operation forward exactly once, appends its history event, installs the public
claim, and clears the journal.

Startup-read effects record exact expected and observed file write sets, stable
content digests and byte sizes, whether mtimes changed, and the private-file
mode contract. Every unlisted file is compared by kind, bytes, mtime, and mode;
directory identity and presence are also compared. POSIX captures require mode `0600`; the committed
format names that portable contract instead of storing platform-specific mode
bits. The Python clock is fixed and nonce generation is replaced with a
fail-on-use counter that must remain zero.

## Review and refresh rules

`tools/capture-python-contracts.mjs --output <temporary-path>` creates a new
read candidate; adding `--corpus startup-read` creates a startup-read candidate.
Both use exclusive-create semantics. The tool rejects caller-provided Store
roots, existing destinations, and every destination inside the repository.
Consequently it cannot refresh committed vectors. A maintainer must inspect a
candidate and deliberately add or update a golden through normal review.

`tools/verify-contract-redaction.mjs <vector...>` validates the supported
closed vector shape and rejects secret canaries and absolute filesystem paths.
Diagnostics are generic and never repeat rejected content or filenames.

## Explicitly pending

Across the two vectors, 86 Store commands remain inventory-only rather than
behaviorally frozen.
The startup-read corpus does not make these three commands pure reads; it freezes
their current write-aware behavior so a future implementation cannot silently
omit or broaden it.

Still pending are mutation results, other journal kinds and crash boundaries,
restart recovery, legacy and trashed stores, all other corrupt/future documents,
authenticated HTTP routes, and the task, attempt, QA, and policy command
families. Full secret-bearing output projections and cross-platform permission
parity also remain pending. No Python removal or TypeScript writer cutover is
justified by these foundation slices.
