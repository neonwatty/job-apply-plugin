# Installed native Companion

## Activation integrity

A canonical clone marker binds both the source Store tree copied under the
source lock and the complete prepared candidate tree before activation.
Activation holds the source and candidate Store locks, recomputes both digests,
and rejects candidate content changed after preparation. The marker itself is
excluded from the candidate digest. Native writes after activation do not need
to match the preparation digest.

The process-owned controller proves the owned writer group is quiescent before
the atomic switch. The ordinary command router also holds attempt exclusion and
writer ownership while it prepares and activates a fresh or existing Store.
Any ambiguous recovery state fails closed.

## Installed artifact

The installed critical-byte inventory includes the complete
`apps/companion` and `native` trees, the standalone server assets, and reviewed
lock receipts and artifacts for macOS arm64 and Linux x64. Each supported host
selects and verifies its own artifact. The installed runtime does not build or
download an addon; unsupported hosts fail closed.

## Acceptance

Installed tests exercise the production Companion and documented Store, task,
attempt, and policy routes with an empty `PATH`. They cover fresh initialization,
activation of Python-created state, profile and resume behavior, task snapshots,
native mutation across restart, and exact retained rollback bytes. Resume import
keeps its documented input-only contract and does not expose the local source
path.

Python assets remain for explicit whole-process rollback, differential oracles,
QA, and compatibility validation. They are not an ordinary writer route. Older
cached plugin versions must not be pointed at a Store after native activation.
