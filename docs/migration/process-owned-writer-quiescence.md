# Process-owned writer quiescence

The disposable writer-switch controller holds an OS-backed ownership lease for the Store across the complete writer lifetime. A competing controller cannot start another writer while that lease is held. The lease descriptor is inherited by the owned Companion and its Store/Next children, so it remains contended if the controller or launcher dies before those writers. The owner starts one writer in a new process group, accepts one bounded readiness line, drains later output, and rejects overlapping start, stop, restart, activation, or rollback operations.

Activation begins only after the controller sends `SIGTERM`, waits for the owned group, escalates the same group with `SIGKILL` when necessary, and observes that the group no longer exists. The first Store rename cannot run before that proof. A Companion launched under this controller keeps its workspace and Next children in the controller's process group, so abrupt parent or descendant shutdown cannot leave a separately detached writer behind.

After quiescence, the existing Store and candidate locks still protect digest verification and same-parent renames. The controller starts the native writer only after activation completes. If the switch or native readiness fails, it recovers the directory state, rolls back a completed native selection, and restarts Python before returning the original failure. Rollback applies the same rule in reverse and restarts whichever unambiguous Store state recovery finds.

The installed-package rehearsal uses this controller for the initial Python process, native activation, native restart, Python rollback, and retained-native inspection. Its forced-shutdown fixture also proves that an uncooperative child and descendant are gone before the Store moves.

This is bounded evidence on disposable owned clones. It does not discover or terminate arbitrary external processes, change the ordinary Companion default, activate an owner Store, or publish a release. Attempt-broker, final-action-policy, and remaining native Store command closure are still required before default activation.
