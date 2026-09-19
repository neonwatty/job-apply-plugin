# Current parity evidence: answer CLI

This batch compares the Python Store CLI and native TypeScript CLI on separate,
disposable Stores with a common `answers.json` baseline. It declares planned
test bindings; it does not grant migration acceptance.

The lifecycle covers key derivation, missing and existing reads, put, find,
filtered list, update, trash, trashed reads and list, restore, and permanent
delete. The privacy case rejects sensitive value storage without explicit
consent, stores with consent, checks redacted ordinary reads and explicit
reveal, then checks a stale revision and an invalid confirmed answer. Parsed
responses and diagnostics, normalized timestamps, the complete durable answers
document, and all other Store files are compared after each command. Every
read and rejected write is checked for byte-identical Store state.

The invalid confirmed answer currently exposes a **real diagnostic mismatch**:
`answer-put --input '{"question":"Invalid?","state":"confirmed"}'` exits 2
without changing either Store, but Python reports `confirmed answers require a
value` and native reports `confirmed answer record has no value`. The equality
assertion remains in the test as a regression for the integration fix. The
native validation message comes from `src/contracts/workspace/answers.ts`; the
Python command-specific validation comes from
`scripts/job_apply_store/domains/answers/mutations.py`.

`requirements-current-answer-cli-01.json` maps 15 specifically exercised cells.
The mapping remains planned and unverified until the mismatch is fixed and the
suite passes in the integrated branch. It does not imply coverage of observe,
review, merge, semantic lookup, cleanup, process contention, interrupted writes,
recovery, or other answer scenarios.
