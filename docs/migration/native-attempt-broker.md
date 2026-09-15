# Native attempt broker runtime

The native attempt entry point is `runtime/cli/native-attempt.js`. It implements
`start`, `restart-review`, `heartbeat`, `progress`, and `handoff`, with the existing
`--root` / `JOB_APPLY_STORE_DIR` / home-directory precedence. The entry point
resolves its installation from `import.meta.url` and verifies the packaged POSIX
lock artifact. It has no public lock argument and does not build, download, or
invoke Python at runtime.

The public result is one canonical JSON line. Successful acquisition exposes
only the existing job and resume projections; heartbeat, progress, and handoff
return their existing event envelopes. Invalid arguments return
`invalid_invocation`, rejected broker requests return `request_rejected`, and
input/bootstrap/transport failures return `attempt_unavailable`, with exit 2 and
no exception details. Help exits successfully. Missing restart confirmation is
parsed as false and reaches Store rejection, preserving the Python boundary.
Revisions use the shared Python-compatible integer parser and canonical document
representation, including integers above JavaScript's safe-number range.

The broker holds its bearer in an ECMAScript private field. No bearer is placed
in client arguments, environment, output, PID files, or socket metadata. Store
claim hashes remain the existing Store representation. ClaimsService owns
acquisition, restart, progress validation, current-attempt review evidence,
heartbeat, and terminal handoff. The authority serializes those operations and
retains the post-acquisition revision for handoff. Rejected live requests leave
the authority active. A successful handoff cancels the heartbeat timer and ends
the broker.

The transport accepts one UTF-8 newline frame per connection, bounded at 1 MiB
including the newline. Empty, non-object, invalid UTF-8, over-limit, and trailing
frames are rejected without reflecting their contents. Newline clients do not
need to close their write side to receive a response. The runtime directory is
`/tmp/job-apply-attempt-<uid>`, a real owned directory with mode 0700. Socket names
use SHA-256 over the canonical root's Python-compatible filesystem bytes; socket
mode is 0600 and listen backlog is 8. Authentication uses this private directory
and socket mode boundary, including on Node builds without peer-credential APIs.
The platform gate accepts macOS/Linux and refuses other platforms. The execution
receipt for this tranche is macOS; Linux still requires its host release receipt.

A persistent, private `.sock.lock` file holds an inode-stable flock for the broker
lifetime. This file contains no authority and is deliberately not unlinked, so a
contending launcher cannot lock a different inode. A reachable endpoint always
wins; an unreachable owned socket can be removed after ownership is acquired.
The Store's optional `.job-apply-attempt.pid` remains the existing positive ASCII
PID plus newline. Native Store validation requires an owned regular file with
one link, mode 0600, and at most 21 bytes. It does not infer authority from process
liveness. Invalid/symlink/special PID metadata fails closed. Publication writes and
fsyncs the private `.job-apply-attempt.pid.pending` staging file on the same
filesystem, atomically renames it to the final PID, and fsyncs the Store directory.
An interruption leaves the final PID unchanged or wholly replaced. The optional
staging file permits incomplete PID prefixes while retaining the same ownership,
mode, single-link and size checks, so an orphan from interrupted publication does
not block Store status or explicit claim recovery. Failed bootstrap releases
endpoint ownership without deleting metadata it did not write.

Detached spawning survives launcher process-group loss. The default heartbeat is
60 seconds; an unacquired broker exits after 10 seconds. Scheduled heartbeat
failure stops the broker. Process death, normal broker close, and failed startup
never clear the Store claim. Expiry and explicit same-job recovery remain
canonical. The broker removes its endpoint and its own PID on orderly exit;
SIGKILL may leave those metadata files for stale-endpoint handling.

This tranche does **not** switch shipped routing or activate native canonical
Stores. Integration must register the new test/runtime paths, run installed
package and supported-host release checks, and refuse or quiesce a live attempt
broker before writer cutover without clearing its claim. Prepared native
fixtures/clones remain the supported Store roots at this stage.
