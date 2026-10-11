# Protected operator approval surface

`createOperatorApprovalSession` and `createTerminalApprovalSurface` compose with
`createWorkflowBrowserHost(...).host`. They provide one executable, dedicated
terminal decision surface for the experimental fixture deployment. They do not
register an approval command with the normal CLI, HTTP server, or model tools.

## Deployment boundary

The embedding must retain `host`, the approval session, and terminal streams in
its trusted process. The model receives only the existing bounded JSON proposal
transport and the five model operations: context, event, observe, execute, and
reconcile. It must have no shell, computer-use, filesystem, terminal, arbitrary
code, or sibling-process channel that can reach the operator surface or private
host port. An installed Codex transport must satisfy the same restriction;
being installed locally alone does not establish it.

The required deployment declaration (`json_proposals_only` and
`host_private_terminal`) is trusted embedding configuration. It is **not** a
runtime proof of isolation, human identity, or a human decision. Never derive it
from a proposal, transcript, or caller-controlled HTTP/CLI parameter. If the
embedding cannot establish these prerequisites, leave this surface unavailable
and explain which channel is not isolated. TTY presence only rejects accidental
pipe composition; it does not authenticate an OS user or human.

Do not use this embedding inside a model session with terminal or computer access.
The experimental implementation remains limited to fictional Stores and fixture
browsers. No real owner approval or live ATS approval was collected for its tests.

## Host composition

A trusted launcher supplies separate operator `ReadStream` and `WriteStream`
TTY handles; never pass the model transport's stdin or stdout:

```typescript
const session = createOperatorApprovalSession(ports.host, {
  modelTransport: 'json_proposals_only',
  operatorChannel: 'host_private_terminal',
});
const operator = createTerminalApprovalSurface(session, operatorInput, operatorOutput);
try {
  // The host chooses a proposal requiring explicit review. This call presents it;
  // it does not approve based on the model's assertion that the user agreed.
  await operator.review(proposedEvent);
  // Resume the host's bounded proposal loop while this approval session is alive.
  await runRemainingModelProposals();
} finally {
  // Close at host shutdown, not immediately after granting an event for retry.
  operator.close();
}
```

The terminal renders the entire reviewed event and input binding using escaped
JSON. This includes event kind, operation ID, task ID and expected revision, job
ID and revision, optional session scope, event fingerprint, and canonical input
revision. The operator must type the exact displayed `approve <challengeId>` or
`deny <challengeId>`. JSON assertions, bare “yes,” unknown IDs, expired challenges,
and model event payloads containing approval fields do not grant authority.
Terminal closure or session close revokes that session's outstanding grants.

## State and concurrency

The session owns an immutable reviewed snapshot and a random, single-use
challenge, with a default 60-second and maximum 300-second lifetime. Only one
challenge is pending at a time; at most 64 unexpired grants are retained. The
challenge deadline starts before canonical review, so slow review cannot extend
its lifetime. Expiry and clock rollback fail closed.

An approval decision consumes its challenge before awaiting a second canonical
review. Re-review must preserve the exact event fingerprint and input revision.
Task and job revision checks remain in the real workflow. Revocation, a competing
review, close, or expiry while re-review is pending prevents grant issuance. The
remaining challenge lifetime bounds the underlying grant lifetime. Subsequent
canonical execution still checks authority immediately before commit; the
session is not a replacement for those checks.

Single-use challenges and grants have different semantics: the former cannot be
answered twice, while the existing private grant permits exact idempotent event
retries until its expiry or revocation. No durable consent is inferred. Revoking
one session receipt does not revoke an independently approved, overlapping grant
from another trusted session. Embeddings should own one operator session per host.

## Evidence and limits

`tests_js/workspace_host_approval_session.test.mjs` composes the session and terminal
with the real browser host, native locking, canonical Store, and ClaimWorkflow.
It covers model self-approval denial, immutable review, changed preparation input,
stale task revision, expiry, revocation, close, asynchronous decision races,
exact retries, safe handoff, and terminal grammar. Terminal typing is simulated
fixture input, explicitly not authenticated human evidence. No terminal surface
is exposed in the default product deployment by this change.
