# Native active-claim fixture

New v8 synthetic roots support selection, acquisition, public status, heartbeat,
expired-claim recovery, progress and durable handoff. Follow the setup in
[native Jobs](native-jobs-fixture.md); existing fixtures and live Stores are not
adopted or upgraded. The native implementation uses no Python subprocess.

## Companion

In Jobs, confirm selection after the profile and resume preflight succeeds,
then acquire the ready job. The page keeps its bearer credential in memory and
heartbeats every 60 seconds. The lease lasts 300 seconds. Public status contains
no credential or persisted token hash. Reloading loses the credential; wait for
expiry and explicitly recover the named job. Recovery rotates the credential
without increasing the job revision. Returning a job for owner input writes a
session, records history and releases the claim.

## CLI and HTTP

Use `node runtime/cli/native-jobs.js --root ROOT --native-lock ADDON COMMAND`
with these command arguments:

| Command | Arguments |
| --- | --- |
| `task-select` | `--id ID --expected-revision N --owner-confirmed` |
| `job-acquire` | `--id ID --owner LABEL --expected-revision N` |
| `claim-status` | none |
| `claim-heartbeat` | `--id ID --token TOKEN` |
| `claim-recover` | `--id ID --owner LABEL` |
| `claim-progress` | `--id ID --token TOKEN --input SESSION_JSON` |
| `claim-handoff` | `--id ID --token TOKEN --status STATUS --input SESSION_JSON --expected-revision N` |

Only acquisition and recovery return a new bearer token. Session input accepts
stdin with `--input -`. Progress and handoff use the existing Python-compatible
session packet contract. Handoff accepts `needs_info` or `awaiting_review`;
review handoff recomputes readiness against current answers, approvals, attempt
revision and trusted fixture evidence. It does not submit an application.

The authenticated native HTTP adapter exposes `GET /api/claims` and POST routes
under `/api/claims/`: `select`, `acquire`, `heartbeat`, `recover`, `progress` and
`handoff`. They share the CLI service and Store lock. Selection takes
`ownerConfirmed: true`; writes use `jobId`, applicable `expectedRevision`,
`ownerLabel`, `token`, `session` and `status` fields.

## Persistence and boundaries

Acquisition, recovery and handoff use the coordinator journal and append durable
application history. Replay validates identities and event collisions before
writing documents, repairs an interrupted final history append and avoids duplicate
events and revision increments. All domain entry points recover pending journals.

Ordinary edits cannot change a claimed job; unrelated jobs remain editable.
Answer merge and pending-answer resolution require an idle coordinator, including
when they concern a different job. Complete the handoff first. Reviewed restart,
broader attention projections and live Store activation remain separate work.
