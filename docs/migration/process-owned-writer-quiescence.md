# Process-owned writer quiescence

The disposable writer-switch controller holds an OS-backed ownership lease for the Store across the complete writer lifetime. A competing controller cannot start another writer while that lease is held. The lease descriptor is inherited by the owned Companion and its Store/Next children, so it remains contended if the controller or launcher dies before those writers. The owner starts one writer in a new process group, accepts one bounded readiness line, drains later output, and rejects overlapping start, stop, restart, activation, or rollback operations.

Activation begins only after the controller sends `SIGTERM`, waits for the owned group, escalates the same group with `SIGKILL` when necessary, and observes that the group no longer exists. The first Store rename cannot run before that proof. A Companion launched under this controller keeps its workspace and Next children in the controller's process group, so abrupt parent or descendant shutdown cannot leave a separately detached writer behind.

A denied exit probe does not prove that a group has gone. The controller retries
within its bounded deadline; persistent denial blocks the transition before any
rename. Delivery errors from termination signals still propagate.

After quiescence, Store and candidate locks protect digest verification and
same-parent renames. The current installed supervisor selects native writers
only and uses the same lifetime lease for its Store and Next.js children. It
exposes no Python writer or transitional Python rollback command.

Historical switch rehearsals could supply a Python writer specification and
exercise explicit rollback. Current quiescence regression fixtures use Node
children even when their compatibility mode is named `python`. The separate
one-time historical Store acceptance actually runs the pinned Python release,
stops it before native activation, and reads with it again only after rollback.
See [testing](../testing.md) for the distinction.

This controller does not discover or terminate arbitrary external processes.
Owners must stop old plugin sessions, workspaces, and attempts before upgrading
or restoring data; a lifetime lease does not retroactively enroll older Python
writers. See the [transition guide](../typescript-transition.md) for recovery
boundaries. Tests use disposable fictional Stores and do not activate an owner
Store or publish a release.
