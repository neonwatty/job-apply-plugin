# Codex host protocol

Package: `@lineagehq/workflows@0.1.0`

Protocol: `1.0`

Use `workflow agent <command> --store <path>` and send one JSON request on standard input. Every request uses schema `agent-workflow-protocol-request/v1`, `protocolVersion: "1.0"`, a unique `req_...` ID, the run ID, the stable host actor, an ISO timestamp, and the exact command payload. Every mutation includes the latest `expectedRevision`.

## Sequence

1. `inspect` with `{}`. It does not require `expectedRevision`.
2. `claim` with `{ "hostInstanceId": "host_..." }`.
3. `capabilities` with truthful capability records. For Codex Browser screenshots, include `browser.control`, adapter identity, supported browser operations, `evidenceTypes: ["screenshot"]`, and a finite `constraints.maxBytes`.
4. For each step, `propose` one reversible action batch. Use only a returned lease whose decision is `allowed` and whose `expiresAt` has not passed.
   Verify its `leasePolicy` equals the inspection/manifest snapshot. Standard is rolling/hard/threshold 30/120/15 seconds; a human-selected training-only `supervised-codex-browser` run is 120/300/90. Agents cannot select or enlarge either policy.
5. Execute that batch with the installed Browser control skill.
6. For a screenshot requirement, call `evidence` with:

```json
{
  "action": "issue",
  "leaseId": "lease_...",
  "stepId": "current-step",
  "checkpoint": "declared-checkpoint",
  "capabilityId": "browser.control",
  "type": "screenshot"
}
```

In the same Browser Node session, capture and write the bytes without transformation:

```js
const screenshotOutput = await tab.screenshot();
if (
  !ArrayBuffer.isView(screenshotOutput) ||
  screenshotOutput.BYTES_PER_ELEMENT !== 1 ||
  Object.prototype.toString.call(screenshotOutput) !== "[object Uint8Array]"
) throw new Error("Browser screenshot did not return bytes");
const screenshotBytes = new Uint8Array(
  screenshotOutput.buffer,
  screenshotOutput.byteOffset,
  screenshotOutput.byteLength,
);
const { writeFile } = await import("node:fs/promises");
await writeFile(slot.stagingPath, screenshotBytes, { flag: "wx" });
```

Do not choose or modify `slot.stagingPath`. Then call `evidence` with:

```json
{ "action": "register", "leaseId": "lease_...", "slotId": "slot_..." }
```

The runner validates the neutral slot and exact bytes as either conforming PNG (including clear chunk reserved bits) or bounded 8-bit baseline JFIF JPEG. JFIF permits only APP0(JFIF), DQT, SOF0, DHT, SOS, and EOI markers; extensions and other JPEG processes are rejected. The runner does not convert Browser output and alone derives canonical `mimeType` (`image/png` or `image/jpeg`) and the durable `.png` or `.jpg` extension. Do not infer format from `slot.stagingPath` or add an extension.

7. `commit` the lease result and complete step assessment. Set `artifacts` and every evidence reference to registered artifact ID strings only.
8. Repeat from `inspect`. Release only when no lease is active.

Heartbeat before expiry when runner-reported remaining time is at or below the pinned threshold. The runner derives the new expiry as `min(runnerNow + rollingSeconds, hardExpiresAt)`. At runner time `>= expiresAt`, do not heartbeat, issue/register evidence, or commit. An identical request that was already durable may be retried with the same request ID and replay the exact response after expiry.

## Honest capability boundary

Training preflight can report `missingCapabilities` while remaining active. Continue only through steps whose evidence can be proven. At the first step requiring a recorded gap, propose only the capabilities needed to execute the bounded browser action; do not falsely request the unavailable proof capability. After the action lease is issued, commit the following assessment fragment with the full committed result:

```json
{
  "assessment": {
    "stepId": "inspect-preview",
    "expectations": [
      {
        "expectation": "Exact workflow expectation",
        "outcome": "blocked",
        "observation": "Not assessable because media-inspection is unavailable.",
        "evidence": []
      }
    ],
    "proposedOutcome": "blocked",
    "block": {
      "code": "capability_unavailable",
      "capability": "media-inspection"
    }
  },
  "artifacts": []
}
```

Include every expectation exactly once. The runner rejects this block unless the run is training, preflight recorded the named gap, and the current step requires it. Descendants become dependency-blocked and cleanup still runs.

## Recovery

- On `REVISION_CONFLICT`, inspect and rebuild the request against current state; do not reuse the request ID with changed input.
- Retry an identical evidence request with the same request ID after interrupted response delivery. The runner reconstructs the exact response.
- On `LEASE_EXPIRED`, stop browser mutation and inspect.
- On ownership or reconciliation errors, do not claim success from visible state alone.

## Fresh-agent handoff

Before a production run, start a new Codex agent in the repository root. Ask it to report whether `agent-workflows` appears in the skill catalog supplied to that fresh session and to read the installed contract through `$agent-workflows`. Keep that report with the readiness audit. Do not treat a directory listing or the installer test as runtime discovery evidence.
