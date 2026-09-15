# Process-owned writer quiescence

## Goal

Close the process-lifecycle gap in the disposable native writer-switch rehearsal. A single controller must start the selected writer in an owned process group, stop that complete group, prove it is gone before either Store directory moves, recover failed transitions to a running known writer, and reject overlapping lifecycle operations.

This tranche does not change the ordinary Companion default, shipped skill routing, a live Store, or publication.

## Implementation

1. Add a typed process-owner and native cutover controller beside the existing writer switch. Keep command construction injectable so tests and the installed Companion use the same lifecycle implementation.
2. Start each writer in a new process group, accept only one bounded startup line, drain child output without exposing it, terminate gracefully, escalate to the complete group, and fail unless group absence is observable.
3. Quiesce the owned writer before activation or rollback. If switching or replacement startup fails, recover the directory state and restart the matching prior writer before returning the error.
4. Add deterministic child-process tests for graceful shutdown, forced descendant cleanup, startup failure recovery, and overlapping-operation rejection.
5. Route the installed native Companion rehearsal through the controller for Python-to-native activation, native restart, rollback, and retained-native inspection.
6. Update runtime emission, the native test matrix, migration inventory, and bounded migration documentation.

## Verification

Run focused controller and writer-switch tests first, then typecheck, deterministic runtime build checking, migration inventory, source-size policy, affected tests, commit checks, deep checks, independent review, and the normal push/PR/staging CI sequence.
