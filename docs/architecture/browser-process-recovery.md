# Browser host process-loss fixture

This experimental check extends [the controlled browser fixture](local-browser-fixture.md)
with an actual operating-system process boundary. It remains `synthetic_adapter`
evidence, using fictional loopback pages and temporary canonical Stores.

## Ownership and channels

- The test controller owns fresh headless Chromium and its private page driver.
- A forked Node process owns the native Store repository, workflow host, durable
  browser boundary, and `BrowserWorkflowBroker`.
- The child's stdin/stdout channel accepts only the existing broker proposals.
  A model-originated `browser_approve` command is rejected. Acquisition and
  recovery require a decision delivered through the separate private IPC channel.
- The private IPC channel also exposes exactly three fixture driver operations:
  observe, compare-and-fill, and readback. The controller supplies the driver;
  model proposals never receive the IPC channel or browser page object.

These are trusted fixture channels, not an authenticated human interface or an
OS sandbox for arbitrary model-generated programs. The separate approval
integration defines any deployable user-decision guarantees.

## Failure injection and evidence

The controller blocks the trusted page-port exchange at either of two barriers:

1. Before the first DOM mutation, after the child committed its durable intent.
2. After the synchronous DOM mutation completed, before the child receives the
   mutation response or performs readback.

At each barrier the test reads the canonical `pending` operation and its uncertain
receipt, verifies the recorded source-grant fingerprint, and sends `SIGKILL` to
an actual child PID. It checks the exit signal and unchanged durable operation.
No graceful close or simulated exception substitutes for this process death.

A fresh child opens the same Store. A deterministic test clock advances beyond
claim expiry. Both self-approved recovery and reconciliation through the stale
claim are rejected. A private fixture decision authorizes explicit recovery;
readback uses the original persisted operation rather than a new write request.

| Failure | Recovery result | Browser evidence |
| --- | --- | --- |
| Host killed before mutation | Uncertain | Zero name writes; unrelated draft preserved |
| Host killed after mutation | Verified by matching readback | One name write total; unrelated draft preserved |
| Host killed, then page reloaded | Uncertain | New document identity; drafts reset by reload, never restored or replayed |
| Host killed, then browser closed | Uncertain | Driver unavailable; no browser recreation or write retry |

Repeated reconciliation cannot duplicate a fill. An unresolved operation blocks a
new mutation. A verified operation returns its durable receipt on repeated
reconciliation without another page read. The fixture's final-action counter
remains zero wherever a surviving document can be inspected.

## Running the checks

```sh
node --test tests_js/workspace_browser_process_recovery.test.mjs
```

Implementation lives in `workspace_browser_process_child_support.mjs` (child channels),
`workspace_browser_process_support.mjs` (trusted controller and setup), and
`workspace_browser_process_recovery.test.mjs` (four failure cases), all under
`tests_js/`. The existing local browser fixture additionally exposes its owned
browser handle solely so the test can close that isolated Chromium instance.

## Limits

The checks prove recovery across a killed workflow-host process while an external
browser survives. They do not establish recovery from OS/power loss, filesystem
corruption, arbitrary network failures, live ATS behavior, resume uploads, or
final submission. Claim expiry uses a deterministic clock rather than waiting
six real minutes. Browser destruction loses browser drafts; durable uncertainty
is retained and the test makes no restoration claim. The fixture contains no
real applicant data and never connects to the owner's browser or Store.
