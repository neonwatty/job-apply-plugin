# Native Attempt Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Python attempt broker with an installed TypeScript broker that preserves the public CLI, keeps bearer authority private, and uses the native Store implementation.

**Architecture:** Split protocol parsing, in-memory authority, Unix broker transport, and executable bootstrap into focused modules. Reuse `ClaimsService`, `NativeJobsRepository`, canonical JSON, and the packaged POSIX lock provider. Keep shipped routing on Python until the integration tranche proves the complete cutover.

**Tech Stack:** TypeScript, emitted ESM JavaScript, Node.js Unix sockets and child processes, Node test runner, Python differential oracle.

**Spec:** `docs/migration/acceptance-contract.md`

## Global Constraints

- Preserve the exact `scripts/job-apply-attempt.py` command surface and public JSON envelopes.
- Never expose or serialize the claim bearer token or raw application values.
- Use the installed lock provider; do not add a public `--native-lock` argument.
- Preserve claims after broker death; expiry and explicit recovery remain authoritative.
- Fail closed outside proved POSIX transport behavior.
- Keep every source file and emitted runtime file below the repository size limit.
- Do not edit launcher, skill, migration-catalog, review-lock, or shared Store files in this tranche.

---

### Task 1: Attempt protocol and public envelopes

**Files:**
- Create: `src/cli/attempt-protocol.ts`
- Create: `tests_js/native_attempt_support.mjs`
- Create: `tests_js/native_attempt_protocol.test.mjs`

**Interfaces:**
- Produces: `parseAttemptArgs(args, env, home): AttemptInvocation`.
- Produces: `resolveAttemptRoot(root, env, home): string`.
- Produces: `attemptSocketPath(root, uid): string`.
- Produces: `encodeAttemptFrame(value): Buffer` and `AttemptFrameDecoder`.
- Produces: helpers for success, `invalid_invocation`, `request_rejected`, and `attempt_unavailable` output.

- [ ] **Step 1: Write protocol tests that execute the Python CLI as the oracle**

Cover `start`, `restart-review`, `heartbeat`, `progress`, and `handoff`; `--root`/`JOB_APPLY_STORE_DIR`/home precedence; help; duplicate and malformed arguments; Unicode and signed revisions; strict JSON input; the 1 MiB newline frame bound; socket-path hashing; and one-line stdout with empty stderr on success.

- [ ] **Step 2: Run the protocol test and confirm the missing native module fails**

Run: `node --test tests_js/native_attempt_protocol.test.mjs`

Expected: FAIL because `src/cli/attempt-protocol.ts` and its runtime emission do not exist.

- [ ] **Step 3: Implement the protocol module**

Define the public union around these exact operations:

```ts
export type AttemptInvocation =
  | { kind: 'start'; root: string; id: string; owner: string; expectedRevision: bigint }
  | { kind: 'restart-review'; root: string; id: string; owner: string; expectedRevision: bigint; ownerConfirmedNotSubmitted: true }
  | { kind: 'heartbeat'; root: string }
  | { kind: 'progress'; root: string; input: string }
  | { kind: 'handoff'; root: string; status: 'needs_info' | 'awaiting_review'; input: string };

export const attemptFrameLimit = 1024 * 1024;
export const attemptHeartbeatMilliseconds = 60_000;
export const attemptIdleMilliseconds = 10_000;
```

Use `parseTaskRevision` and canonical document parsing rather than JavaScript number conversion. Reject bytes after the first newline and frames above the limit.

- [ ] **Step 4: Run the protocol test to green**

Run: `node --test tests_js/native_attempt_protocol.test.mjs`

Expected: PASS with no skips.

### Task 2: Private attempt authority

**Files:**
- Create: `src/cli/attempt-authority.ts`
- Extend: `tests_js/native_attempt_protocol.test.mjs`

**Interfaces:**
- Consumes: `ClaimsService` acquisition, restart, heartbeat, progress, and handoff methods.
- Produces: `AttemptAuthority.acquire(request)` and `AttemptAuthority.dispatch(request)`.

- [ ] **Step 1: Add failing direct authority tests**

Assert acquisition returns only job and resume projections, the token never appears in results or object inspection, post-acquisition revision is used for handoff, rejected commands leave the authority live, and a terminal handoff marks the broker complete.

- [ ] **Step 2: Implement the minimal state machine**

```ts
export class AttemptAuthority {
  async acquire(request: AttemptStartRequest | AttemptRestartRequest): Promise<AttemptResponse>;
  async dispatch(request: AttemptLiveRequest): Promise<{ response: AttemptResponse; complete: boolean }>;
  async close(): Promise<void>;
}
```

Store the bearer token only in a private field. Schedule heartbeats through injected timers. On close, cancel timers without clearing the Store claim.

- [ ] **Step 3: Run the focused protocol/authority tests**

Run: `node --test tests_js/native_attempt_protocol.test.mjs`

Expected: PASS with no token or value leakage.

### Task 3: Secure broker and executable

**Files:**
- Create: `src/cli/attempt-broker.ts`
- Create: `src/cli/native-attempt.ts`
- Create: `tests_js/native_attempt_lifecycle.test.mjs`
- Generate: `runtime/cli/attempt-protocol.js`
- Generate: `runtime/cli/attempt-authority.js`
- Generate: `runtime/cli/attempt-broker.js`
- Generate: `runtime/cli/native-attempt.js`

**Interfaces:**
- Produces: `runAttemptBroker`, `requestAttempt`, and `spawnAttemptBroker`.
- Consumes: packaged native lock resolution and `NativeJobsRepository`.

- [ ] **Step 1: Write failing lifecycle tests**

Cover detached broker survival, independent heartbeat/progress/handoff clients, review restart confirmation, rejected live commands, process-loss claim retention, stale socket cleanup, simultaneous launcher one-winner behavior, idle timeout, heartbeat failure, socket/directory modes, frame bounds, and operation with Python absent from `PATH`.

- [ ] **Step 2: Run the lifecycle test and observe failure**

Run: `node --test --test-concurrency=1 tests_js/native_attempt_lifecycle.test.mjs`

Expected: FAIL because the broker and executable are missing.

- [ ] **Step 3: Implement the Unix broker**

Create `/tmp/job-apply-attempt-<uid>` as a real owned `0700` directory and the socket as `0600`. Hash `os.fsencode(root)` equivalently for its filename. Probe before removing `EADDRINUSE`; a reachable broker wins. Accept one newline-framed request per connection, use backlog 8, remove only the broker's socket/PID on exit, and keep a rejected post-acquisition request from terminating the broker.

- [ ] **Step 4: Implement the native executable**

Resolve the plugin root from `import.meta.url`, load the packaged lock provider, construct `NativeJobsRepository` and `ClaimsService`, and select client or hidden `--broker` mode. Map parser errors to `invalid_invocation`, Store rejections to `request_rejected`, and bootstrap/transport errors to `attempt_unavailable`, each as one canonical JSON line with exit 2.

- [ ] **Step 5: Emit runtime JavaScript and run focused tests**

Run: `npm run build:runtime`

Run: `node --test --test-concurrency=1 tests_js/native_attempt_protocol.test.mjs tests_js/native_attempt_lifecycle.test.mjs`

Expected: PASS with no skips.

### Task 4: Differential and tranche verification

**Files:**
- Create: `docs/migration/native-attempt-broker.md`

- [ ] **Step 1: Run the Python oracle**

Run: `python3 -m unittest -v tests.test_job_apply_attempt`

Expected: all ten existing cases pass.

- [ ] **Step 2: Run source/runtime verification**

Run: `npm run typecheck && npm run build:check && npm run check:size -- --base origin/staging`

Expected: all checks pass.

- [ ] **Step 3: Document the bounded result**

Record the protocol, bearer privacy, Store behavior, process-loss semantics, and POSIX scope. State that shipped routing and activation remain integration work and that cutover must refuse or quiesce a live attempt broker without clearing its claim.

- [ ] **Step 4: Commit the independent tranche**

```bash
git add src/cli/attempt-*.ts src/cli/native-attempt.ts runtime/cli/attempt-*.js runtime/cli/native-attempt.js tests_js/native_attempt_*.mjs docs/migration/native-attempt-broker.md
git commit -m "Add native attempt broker runtime"
```

