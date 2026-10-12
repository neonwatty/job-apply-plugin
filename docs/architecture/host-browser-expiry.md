# Host browser recovery after genuine claim expiry

The experimental `broker-expiry-recovery` scenario uses an isolated installed
fixture, a fictional Store, and its loopback page. It demonstrates recovery from
a lost broker capability after the original five-minute claim lease expires.
It never changes production lease duration or rewrites Store timestamps.

## Actual host trial

1. Start the fixture and open only its loopback URL using native host tools.
   Read context and explicitly acquire using the authorized event interface.
2. Fill the four labelled controls, preserve notes, and capture the original
   `host-browser-context` progress input. Do not report progress yet.
3. Inject `{ "kind": "broker-restart", "signal": "SIGKILL" }`. This kills and
   replaces only the fixture-owned broker. Its receipt records the original
   lease, process IDs, durable digest and page snapshot.
4. Re-read context and DOM, record `recovery-observation`, and send the captured
   original progress report. It must reject while the original lease is live.
5. Wait until the original `expiresAt` using real elapsed time. Poll context
   without browser writes. When context advertises explicit recovery for the
   expired claim, post exactly `{ "kind": "claim-expired" }` to `/checkpoint`.
   The server records its own time and verifies the original canonical state.
6. Send the context's `recover` input, with a fresh operation ID, to the explicitly
   authorized event route. The fixture records the host attestation and invokes
   the installed CLI with `--host-user-event`.
7. Re-read canonical context and the native DOM, then record another
   `recovery-observation` for the same loss sequence. Preserve the existing draft.
8. Send the exact original progress report again; it must reject without mutation.
   Use fresh guidance to report `needs_info` with `resume_upload` in the session's
   handoff checklist, because the resume upload requires owner action.
9. Grade, preserve the native tool transcript, and stop the owned fixture.

The grader requires the order above, unchanged original task input identity,
a new claim capability after authorized recovery, and a final Needs Info state
with the claim released. It checks original confirmed source facts, immutable
profile/resume inputs, unrelated job records, unchanged page events after loss,
and zero submission attempts. Broker heartbeat renewal after recovery is allowed
only when the paired timestamps preserve the five-minute lease and all other
canonical fields remain unchanged.

## Evidence boundary

`expiryCheckpoint` accepts no client time override. Fixture command and injection
receipts contain server timestamps. A checkpoint alone cannot pass the grader:
the preceding live rejection, unchanged original lease, explicit recovery, fresh
observation, stale report rejection and safe handoff are all required.

Browser observations are `agent_attested`; the observer and grader do not provide
independent browser evidence. Keep the native host transcript with the trial.
Direct installed commands outside the fixture routes are outside its receipt
coverage. No claim is made about live ATS behavior or final submission.

Fast tests construct explicitly synthetic receipt chains and test each rejection
boundary. They do not demonstrate real elapsed lease time or real browser work.
The actual host trial must wait the normal lease; no synthetic clock or timestamp
editing is part of that workflow.
