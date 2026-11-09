# P07 reference: immutable task history and rejected contracts

This reference records the accepted P06 checker behavior before adding task
lineage. Three existing suites bind manifest scope and execution identities,
exact receipt/TAP identities, and immutable metadata lifecycle. All 21 tests
must pass without skips on the same immutable subject. No new lineage behavior
is accepted by this baseline.

The motivating S02 attempt passed its decoder and supporting tests, but its
frozen PythonText cell declared four literal names while the existing suite
executes eight names, including four generated interpreter cases. Its original
manifest and actual logs must remain intact and unaccepted. Exact-name checks
must continue rejecting that mismatch.

P07 will explicitly cover replacement of an executed but unaccepted attempt, in
addition to refinements of tasks that have not executed. This clarifies the
original narrower “unexecuted tasks” planning text. Accepted assignments,
receipts, manifests, subjects, dependency edges and logs remain immutable. An
independently reviewed lineage transition may retire an unaccepted attempt and
introduce a unique replacement identity. It cannot turn the retired attempt into
a passed task or reuse old execution as proof of the replacement contract.

The corrected attempt must freeze its own reviewed contract, activate afterward,
then obtain fresh exact-subject execution and independent review. Adoption of
existing implementation bytes is explicit input provenance, never retroactive
acceptance. The original S02 reference acceptance and all predecessor gates stay
required. The replacement PythonText witness must verify all eight existing
behaviors without mutating the original test or hiding child skips.

Only synthetic Git fixtures are permitted. No Store, owner browser or release
activation is part of P07. Final implementation scope and tests must be frozen
separately after independent design review.
