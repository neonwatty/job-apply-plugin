# P04.R — heavy-run coordination reference and proposed boundary

Status: source audit plus bounded native inheritance witnesses; P04 is not accepted.
This reference package owns this document and the two reference/test files named
below. No production runner, lease, native source, configuration or runtime
changes are authorized here. P04.I remains gated by P01.V and an
independently reviewed P04.R manifest. The integrating owner binds the final
inputs and scenarios to immutable revisions through P01.

## Scope and existing evidence

The established need is exclusion between cooperative, same-user local Codex
workers and worktrees running heavy checks. Cross-account exclusion, hostile
same-user processes, and coordination across containers or virtual machines on a
physical host are not established support promises. No TCP port is proposed.

| Inspected source | Established behavior and limit |
| --- | --- |
| `tools/local-checks/hook.mjs` and `run.mjs` | Hook cancellation, isolated snapshots, deep concurrency one and push receipt reuse exist; no cross-process exclusion. Receipt age concerns reuse, not lock ownership. |
| `tools/local-checks/process.mjs` | Detached POSIX command groups; TERM then KILL; forced resolution can happen without proof that descendants stopped. |
| `tools/test-runner.mjs` and `tools/test-runner/execute.mjs` | Direct fast/affected/full/platform/release path also launches suites, with bounded in-process concurrency but no common host lock. |
| `tools/test-runner/process.mjs` | Separate timeout/group cleanup logic; direct-child close, pipe drain and forced-resolution timers do not prove every descendant exited. |
| `tools/local-checks/policy.mjs` and `git.mjs` | Light/heavy selection and worktree-specific receipts exist; receipt roots are unsuitable shared lock identities. |
| `native/posix/flock.c` | Existing Node-API addon exports nonblocking exclusive `tryLock(fd)` and explicit `unlock(fd)`. It neither opens descriptors nor supervises processes. |
| `src/store/posix-flock.ts` | Explicit absolute addon loader; no runtime compilation/download. Windows is rejected. |
| `src/store/exclusive-file-lock.ts` | Callback-scoped Store compatibility wrapper, including deliberately preserved failure/cleanup behavior. Its semantics are not a general heavy-run lifecycle guarantee. |
| `tools/build-native-lock.mjs` | Explicit development builder records source/header/artifact hashes. This does not yet establish how a hook finds a compatible prebuilt artifact. |
| `tests_js/posix_flock.test.mjs` | Existing kernel-lock argument and descriptor ownership regressions; not an acceptance test for inherited descriptors or orphaned command trees. |

The initial audit used source inspection only. The bounded disposable native
experiments recorded below now supplement it. No production lease, live endpoint
or heavy suite was used.

## Reuse assessment: kernel lock first

Prefer the existing flock primitive on supported POSIX systems. It avoids a port
reservation and does not require a network service. Use one stable private state
directory for the operating-system account, independent of worktree, branch,
repository, receipt key and caller-selected `CODEX_HOME`. A directory beneath the
account's OS-resolved home is a candidate; canonical account-home resolution,
permissions and rejection of symlink/non-directory state must be specified before
freezing. A caller's altered `HOME` must not silently select a second namespace.
The namespace is versioned, but concurrent supported tool versions must still
contend on one agreed lock inode rather than each inventing a separate lock.

Keep the lock file at a stable inode: never unlink/replace it on release or stale
recovery. Open it safely, retain its descriptor while owned and close only that
owned descriptor. Metadata lives separately. A successful kernel acquisition is
necessary, but does not alone prove a prior heavy process tree is gone.

Descriptor inheritance is worth testing before adding a supervisor. A child can
receive the locked descriptor through an explicit extra `spawn` stdio slot. On
platforms where flock ownership survives the relevant duplication/exec path,
that retained descriptor can keep exclusion after coordinator death. Acceptance
must witness the actual Node spawn path on each native platform; existing addon
unit tests do not establish this property.

There are critical limitations:

- Existing launchers supply only three stdio entries, so they currently do not
  transfer a lease descriptor. Nested subprocess launchers can drop an extra
  descriptor; a grandchild can outlive every process that retained it.
- Explicit `LOCK_UN` on a shared inherited lock can release ownership even while
  another holder remains. A heavy-run implementation must not reuse the Store
  wrapper's unconditional unlock pattern as a death-safe inheritance protocol.
- Inheriting a descriptor into a direct child does not enforce arbitrary
  descendant containment. Processes may close it or leave a process group.
- A separate lock-holder helper has the same flaw when killed while heavy work
  survives. A TCP listener owned by that helper would have the same lifecycle
  gap; replacing flock with TCP does not solve it.

## Smallest safe protocol and unresolved native boundary

Use a portable state machine over injected lock/process observations:
`waiting -> locked -> recovery-check -> prepared -> running -> verified-clean`.
Cancellation before ownership must not alter another owner's state. After kernel
acquisition, unresolved prior state prevents launch. Before spawning heavy work,
write a durable unresolved generation record while holding the stable lock.
Failure to establish that record means no spawn. The record identifies the run
with an unpredictable generation token and bounded diagnostic command/suite
identity, without environment dumps or applicant data.

A process crash may release the kernel lock; the unresolved record must then
block a successor even if acquisition succeeds. PID, process-group number,
heartbeat age, executable name or a stale receipt never authorizes signalling,
record deletion or declaring prior work dead. Corrupt, inaccessible or ambiguous
state fails closed. No automatic timeout-based stale-owner takeover is proposed.
Only matching-generation verified completion can mark the record clean.

This gives a narrow safe initial failure mode: an orphan or uncertain run blocks
subsequent heavy launches rather than overlaps them. It does not yet provide
usable automatic crash recovery. An implementation that merely strands all
crashed runs cannot claim the recovery scenarios complete. Recovery requires a
separately evidenced process-lifetime observation, or an explicit diagnostic
resolution procedure that actually proves prior work stopped. Deleting a marker
because the coordinator PID disappeared is not such a procedure.

Normal completion and cancellation also need evidence before clean release.
Direct-child exit, pipe EOF and successful `kill` are insufficient by themselves.
Review the actual managed command tree and descriptor propagation; define which
owned processes must settle and how their termination is witnessed. If ordinary
Node supervision plus inherited ownership cannot establish that invariant,
register a bounded platform-native lifetime/containment prerequisite. Do not
preselect a new daemon, TCP supervisor or process-identity subsystem before that
reference demonstrates a need. Process-group checks can contribute evidence but
must not imply coverage for escaped descendants. Ambiguous identity must prevent
signalling or clean release, including after PID reuse.

Portable protocol tests can prove generation safety and fail-closed decisions.
They cannot prove macOS/Linux flock inheritance, process birth identity or Windows
containment. Windows needs an equivalent native ownership backend and its own
acceptance cells; absent platforms remain explicitly open. No arbitrary process
killing or cross-account infrastructure belongs in this proposal.

## Proposed bounded implementation ownership

First freeze the protocol and native feasibility witnesses below. Subject to
that result, the portable/integration package proposes seven production modules:

1. `tools/local-checks/host-lease.mjs` — namespace, stable lock, generation record,
   waiting/cancellation and fail-closed recovery decisions.
2. `tools/local-checks/host-process.mjs` — explicit ownership/termination evidence
   interface, descriptor transfer and verified completion boundary.
3. `tools/local-checks/process.mjs` — hook command lifecycle bridge.
4. `tools/local-checks/run.mjs` — selected heavy scope and reuse bypass.
5. `tools/local-checks/hook.mjs` — cancellation of waiters and active work.
6. `tools/test-runner/execute.mjs` — same shared ownership for direct launches.
7. `tools/test-runner/process.mjs` — direct command lifecycle bridge.

Reuse the existing flock addon/loader without changing Store semantics. Resolve
its explicit artifact availability before enabling hooks; a missing artifact
must produce a clear failure, never silent overlap or an automatic compiler run.
If a development loader adapter, native lifecycle backend or runner extraction
is needed, revise the manifest explicitly within the eight-module limit or split
a prerequisite. Do not hide that work in tests or a general supervisor module.

Proposed test ownership: `tests_js/host_lease.test.mjs`,
`tests_js/host_lease_process.test.mjs`, `tests_js/host_lease_support.mjs`,
`tests_js/local_checks_run.test.mjs`, `tests_js/local_checks_process.test.mjs`,
`tests_js/test-runner-execution.test.mjs`. Documentation includes this file and
`docs/local-testing-protocol.md`; registration remains integration-owned.

Heavy classification must cover both entry paths and conservatively handle
unknown selections. Reused receipts and light-only work need no heavy ownership.
Nested managed runners need an evidenced inherited capability or rejection before
launch, not an environment-token bypass or recursive-acquisition deadlock.

## Required independent reference scenarios

Use disposable small processes, unique owned test state and explicit handshake
acknowledgements. Never touch a running worker's production lock. Assert ordering
of entry/exit acknowledgements instead of inferring non-overlap from sleeps.

| Proposed literal test name | Required witness |
| --- | --- |
| `P04 separate worktrees share same-user ownership` | Independent coordinators with different worktree/cwd/receipt roots and altered caller HOME resolve one account namespace and serialize. |
| `P04 direct and hook heavy runners contend` | Both entry paths contend; configured runner concurrency cannot bypass exclusion. |
| `P04 light checks and reused receipts avoid acquisition` | No heavy child or ownership record for legitimate light-only/reuse paths. |
| `P04 cancelled and abandoned waiters preserve the holder` | Pre-acquisition cancellation and killed waiters never launch later or mutate the owner; remaining waiters can proceed. |
| `P04 inherited flock survives coordinator death` | Native Node spawn transfers descriptor; kill coordinator, observe child still excludes a contender, then close final owned descriptor and observe acquisition. No explicit shared unlock. |
| `P04 dropped inherited descriptors leave unresolved work blocked` | Deliberately drop descriptor before a live grandchild outlives its parents; kernel availability does not bypass unresolved generation. |
| `P04 crash boundaries cannot launch overlapping work` | Kill before record, after record/before spawn, after spawn and during cleanup; no spawn before prepared record, and uncertain state blocks the successor. |
| `P04 active cancellation requires descendant completion` | Cooperative and TERM-ignoring descendants, early direct-parent exit and descriptor closure; cleanup timeout fails without claiming verified clean release. |
| `P04 stale metadata never authorizes PID signalling` | Reused PID/group fixtures, mismatched boot/birth identity and unknown observations produce no unsafe signals or deletion. Native recovery remains a separate platform gate. |
| `P04 stale completion cannot clear a new generation` | Duplicated/reordered completion and replaced metadata preserve current generation and stable lock inode. |
| `P04 malformed state and missing native artifacts fail closed` | Bad schema, truncation, symlink paths, inaccessible metadata, failed record write and absent addon cause no heavy launch. |
| `P04 spawn errors and cleanup failures preserve truthful receipts` | Failure before/after spawn, output limit and timeout retain failed status and unresolved ownership when appropriate. |
| `P04 nested runner ownership cannot be forged` | Actual inheritance/rejection rule prevents recursive deadlock; copied environment token alone grants nothing. |
| `P04 recovery proves completion before clearing unresolved state` | Independently observe supported native recovery; ambiguous orphan/escaped descendant stays blocked. Simulated evidence alone does not pass the native cell. |

## Verification and readiness

Retain existing local process tests for output limits, missing executables, Git
environment isolation and cancellation; runner tests for result order, bounded
concurrency, timeout after parent exit and receipt privacy; and local run tests
for exact snapshots, failure receipts and reuse. Proposed independent commands:

```text
node --test --test-concurrency=1 tests_js/host_lease.test.mjs tests_js/host_lease_process.test.mjs
node --test --test-concurrency=1 tests_js/local_checks_process.test.mjs tests_js/local_checks_run.test.mjs tests_js/test-runner-execution.test.mjs
npm run check:size
```

These are future commands, not audit receipts. The next feasible boundary is a
reference-only inherited-flock and orphan-marker witness on owned subprocesses,
plus portable generation/cancellation assertions. Resolve native completion and
recovery evidence and artifact discovery before freezing P04.R or enabling the
integration package. Full deep validation remains with the integrating owner
once focused gates pass and the host is free. No P04 acceptance is claimed.


## Bounded native inheritance observations

`tools/contracts/heavy-run-lease/reference.mjs` now supplies four fixed disposable
native scenarios. It explicitly builds the existing flock addon in a new owned
temporary directory through `tools/build-native-lock.mjs`. No production native
source, runner, Store wrapper or runtime module is changed. The reference loads
that explicit artifact directly; it does not claim this is hook artifact discovery.

Each scenario starts a holder in an owned POSIX process group. The holder locks
an independently opened temporary file, then starts exactly one grandchild with
the existing locked descriptor explicitly mapped into Node stdio slot 3, or an
ignored slot for the drop case. Fresh contender processes independently open the
same file and call nonblocking `tryLock`; closing their descriptors releases any
lock they acquire. Grandchild acknowledgements bracket the decisive contender
observation, establishing that the same owned grandchild remained alive across
that observation without relying on timing or PID liveness guesses.

| Fixed scenario | Before boundary | While grandchild acknowledges | After owned completion |
| --- | --- | --- | --- |
| Parent closes its descriptor, grandchild retains inherited descriptor | Contended | Contended | Acquired |
| Parent receives SIGKILL, grandchild retains inherited descriptor | Contended | Contended | Acquired |
| Parent receives SIGKILL, grandchild did not inherit locked descriptor | Contended | Acquired despite live orphan | Acquired |
| Parent explicitly calls LOCK_UN while both processes retain descriptors | Contended | Acquired despite retained descriptors | Acquired |

These are actual darwin/arm64 observations on Node 22.22.3. They demonstrate both
the useful inheritance behavior and two concrete gaps; they do not prove arbitrary
subprocess trees propagate the descriptor or that production cleanup is safe.

Grandchild control uses tiny files inside its owned temporary directory, not a
socket or production host lease. The one grandchild explicitly closes its retained
descriptor on stop and also has a fixed eight-second self-expiry on failed probes.
Successful observations require its stop acknowledgement and closure of inherited
output before final contention. The holder exits after that child's completion,
or its earlier SIGKILL is explicitly observed. Cleanup awaits those owned outputs
and removes the temporary tree; no stale PID/group lookup or arbitrary group
signalling is used. This is cleanup of these exact fixed graphs, not a reusable
containment or orphan-recovery algorithm.

`tests_js/heavy_run_lease_reference.test.mjs` has five literal top-level names,
four for the fixed scenarios and one for provenance/cleanup. It asserts exact
closed case IDs, event ordering, contention results and descendant acknowledgements.
It independently hashes the actual resolved Node executable, native source and
Node headers; the builder artifact hash is checked against independently reread
artifact bytes before cleanup. The receipt binds platform, architecture, Node and
Node-API versions, source/header/artifact hashes and removed temporary paths.
Unsupported native hosts visibly skip and remain unaccepted.

Observed focused verification:

```text
node --test --test-concurrency=1 tests_js/heavy_run_lease_reference.test.mjs
```

Five tests passed, zero skips, on darwin/arm64. Linux, Windows, production namespace
selection, unresolved-generation durability/recovery, nested runner authorization,
production cancellation and artifact provisioning remain open. The previous
reference-only inheritance boundary is now evidenced locally; the next boundary
is the fail-closed generation protocol and native completion/recovery assessment.
No P04.I or P04.V completion follows from these witnesses alone.
