# Current parity evidence batch 02: job lifecycle CLI

Base: merged `staging` revision `6d863520b5e5208884017b8dd4a6e8c55966598f`.
This batch compares the original Python Store CLI with the native TypeScript
Store CLI on separate disposable roots. It records requirement-to-test bindings,
not accepted migration evidence.

## Differential test

`native_job_cli_lifecycle_parity.test.mjs` starts with the same Python-created
`jobs.json` document in both roots. The Python CLI uses `init`; the native CLI
uses its synthetic `fixture-init`. Those initializers differ in
`metadata.createdAt`, so the shared jobs document removes that fixture-only
starting difference without normalizing any document field away.

For each command the test compares exit status, parsed JSON response, diagnostic
text, and the full persisted jobs document. It removes only the Python CLI's
`job-apply-store:` diagnostic prefix and normalizes ISO timestamps that are
sampled independently by the two processes. A rejected operation or read must
leave every JSON/JSONL state file unchanged. A successful mutation may change
only `jobs.json`.

The success sequence covers create, get/list, update, transition, trash,
trashed reads, restore, and permanent delete. The rejection sequence covers a
duplicate create, stale revisions, unsupported transition, active-job deletion,
and repeated lifecycle operations. The tested commands showed no response,
diagnostic, or durable jobs document difference after the stated normalization.

## Requirement mapping

`requirements-current-job-cli-01.json` maps 20 cells across eight native CLI
surfaces: eight valid, one invalid, six conflict, two missing, and three no-op.
The exact Python parser, dispatch, and job-domain bytes are bound as oracle
files; the registered Node test names are execution bindings. The inventory
backlog falls from 7,691 to 7,671 unmapped cells. Every acceptance state remains
open; the checker validates declarations and does not accept passing receipts.

This batch does not cover concurrent CLI processes, interruption/recovery,
native Windows/Linux cells, installed router activation, or the remaining
commands and scenarios. Those need separate differential sequences and reviewed
execution receipts before acceptance.
