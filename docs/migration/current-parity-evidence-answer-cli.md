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

The invalid confirmed answer exposed a **real diagnostic mismatch**:
`answer-put --input '{"question":"Invalid?","state":"confirmed"}'` exits 2
without changing either Store, but Python reports `confirmed answers require a
value` while native previously reported `confirmed answer record has no value`.
The native `AnswersService.put` now performs the Python command-specific check
before generic record validation, preserving the generic validator's separate
diagnostic for persisted records. The equality assertion remains as a passing
regression.

`requirements-current-answer-cli-01.json` maps 14 specifically exercised cells.
The mapping remains planned evidence even though the integrated suite passes.
It does not imply coverage of observe,
review, merge, semantic lookup, cleanup, process contention, interrupted writes,
recovery, or other answer scenarios.
