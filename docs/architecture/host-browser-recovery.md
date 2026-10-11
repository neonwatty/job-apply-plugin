# Bounded host browser recovery fixture

This is opt-in, loopback-only test support. The fixture has a copied installed
runtime, synthetic Store, and fixture-owned broker child. Final submission stays
human-only; the fictional form records and prevents any attempted submission.
No production schema or browser authority changes are introduced.

## Broker replacement

Start with `host-browser-cli.mjs start --scenario broker-restart --output ABS_PATH`.
Use the returned installed launcher to perform the existing authorized acquire.
Fill the labelled fictional fields using native host tools, preserve notes, and
capture `host-browser-context` through `/command` before the fault. Save the
pre-fault progress action as a future rejected-report probe.

Authenticated `POST /inject` accepts exactly:

```json
{"kind":"broker-restart","signal":"SIGKILL"}
```

`SIGTERM` is also supported. The endpoint never accepts a PID. It signals only a
child created by this fixture, awaits confirmed exit, spawns a new child, checks
that child's PID readiness file, and performs a read-only startup context
handshake. The handshake also clears the broker's initial idle timeout.

The returned append-only observer receipt has `sequence`, `status`, `oldPid`,
`newPid` on successful replacement, `startupContext`, before/after page and
canonical snapshots, and before/after complete durable Store digests. Transient
PID/lock bookkeeping is excluded from durable snapshots. Failure remains in the
observer with `status: failed` and `error`. Cleanup tracks a replacement from
spawn, including one that fails readiness; it never selects a process from a
caller-supplied PID. Unconfirmed shutdown preserves the installation. Lifecycle shutdown is terminal: it
drains queued startup/stop work, then stops every owned child. Fixture shutdown
rejects new requests and drains its active HTTP request before preserving receipts
and cleaning the Store; a replacement cannot start after lifecycle shutdown.

A live claim outlives its broker. The replacement must expose unavailable claim
ownership and no automatic acquisition. Reobserve context and DOM, then probe
an old progress report; it must fail without durable or browser mutation. The
broker scenario returns `recoveryOutcome: blocked_safely` and passes only when
its preservation, active-claim, no-write, reobservation and rejection checks pass.
It does not claim completed handoff. It never rewrites lease time to manufacture
recovery. Genuine expiry plus explicit authorized recovery remains a separate
readiness boundary.

For the probe, remove `kind` from the saved progress action's `input`, set a new
valid `operationId`, and add `evidenceKind: agent_attested`, `outcome: progress`.
The grader binds the rejected payload to that pre-fault action, rather than
accepting arbitrary malformed report rejection as recovery evidence.

## Browser checkpoints

Authenticated `POST /checkpoint` accepts exactly `{"kind":"tab-closed"}` or
`{"kind":"browser-tool-reconnect"}` and returns its receipt `sequence`. Perform
actual tab close/reopen or host tool binding reset at that boundary and preserve
the external tool transcript. These checkpoint receipts are
`host_attested_loss`; the fixture does not execute or independently verify them.

The `browser-tool-reconnect` scenario presently means `cua_repl.js_reset` followed
by documented rebind to the existing task-owned tab. It does **not** establish a
browser process crash or network transport disconnect. A genuine host transport
disconnect remains untested unless a safe host-supported injection is available.

Read `host-browser-context` through `/command` after the latest loss. Inspect the
current DOM using native browser tools and send:

```json
{
  "kind": "recovery-observation",
  "lossSequence": 1,
  "evidence": {
    "source": "native_host_browser",
    "url": "http://127.0.0.1:PORT/",
    "title": "Fictional host browser acceptance",
    "values": {
      "name": "Fictional Candidate",
      "level": "senior",
      "remote": true,
      "detail": "Synthetic",
      "notes": "Preserve this fictional unrelated note."
    }
  }
}
```

Values must match the observer at that moment; use actual observed values rather
than the example. Missing fresh context, a stale loss sequence, or mismatching
values fails validation. CLI supports `checkpoint --input ABS_JSON_PATH` and
`inject --kind broker-restart --signal SIGKILL`, both with `--manifest ABS_PATH`.

Closing the tab loses its DOM draft. The page queues a `page-load` event before
its field events. This resets observer values to initial HTML values and keeps
cumulative input/change counts. Reobserve the blank/reopened page before fresh
reconstruction, fill required fields again, then record the final report. The
tab scenario requires its first valid recovery observation to show the initial
reset values after page load, with no reconstruction input/change event between
loss and that observation. The final page must contain fresh reconstruction
events after the reset observation. Later updated observations are permitted. It intentionally
does not assert zero repeated field writes. Broker and tool binding reset
scenarios require unchanged page snapshots through reobservation.

## Evidence and limits

New fixture HTTP reports are gated until latest loss has a fresh context and
matching native observation attestation. An exact previously successful report
may replay without another browser action; a caller's `replay` label alone
cannot bypass the gate. The replay result and before/after snapshots remain
available for independent checking. Requests are serialized so restart cannot
interleave with another fixture mutation.

This gate covers fixture HTTP commands, not arbitrary native browser tools or
direct installed CLI invocations. A direct CLI mutation might leave no command
receipt: externally retained tool traces and canonical snapshots are necessary
to audit those paths. A passing grade is not independent proof of a browser
interaction. Unit tests send synthetic HTTP events only and must never be cited
as actual host browser evidence. Every grading attempt is saved separately;
failed attempts and cleanup receipts remain in the output directory.
