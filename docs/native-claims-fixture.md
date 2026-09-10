# Native active-claim fixture

New v9 synthetic roots support selection, acquisition, public status, heartbeat,
expired-claim recovery, progress, durable handoff and reviewed restart. Follow the setup in
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

For an awaiting-review job, choose **Restart reviewed application** and confirm
that you have not submitted it. Restart requires intact prior review evidence,
the exact job revision, an idle coordinator and a current managed resume. It
preserves the old session, records a new attempt and acquires a fresh credential.
The new attempt must produce fresh readiness evidence before another review handoff.

## CLI and HTTP

Use `node runtime/cli/native-jobs.js --root ROOT --native-lock ADDON COMMAND`
with these command arguments:

| Command | Arguments |
| --- | --- |
| `task-select` | `--id ID --expected-revision N --owner-confirmed` |
| `job-acquire` | `--id ID --owner LABEL --expected-revision N` |
| `job-review-restart` | `--id ID --owner LABEL --expected-revision N --owner-confirmed-not-submitted` |
| `claim-status` | none |
| `claim-heartbeat` | `--id ID --token TOKEN` |
| `claim-recover` | `--id ID --owner LABEL` |
| `claim-progress` | `--id ID --token TOKEN --input SESSION_JSON` |
| `claim-handoff` | `--id ID --token TOKEN --status STATUS --input SESSION_JSON --expected-revision N` |

Only acquisition, reviewed restart and recovery return a new bearer token. Session input accepts
stdin with `--input -`. Progress and handoff use the existing Python-compatible
session packet contract. Handoff accepts `needs_info` or `awaiting_review`;
review handoff recomputes readiness against current answers, approvals, attempt
revision and trusted fixture evidence. It does not submit an application.

The authenticated native HTTP adapter exposes `GET /api/claims` and POST routes
under `/api/claims/`: `select`, `acquire`, `heartbeat`, `recover`, `progress` and
`handoff`, plus `review-restart`. Restart takes `jobId`, `ownerLabel`,
`expectedRevision` and `ownerConfirmedNotSubmitted: true`. They share the CLI service and Store lock. Selection takes
`ownerConfirmed: true`; writes use `jobId`, applicable `expectedRevision`,
`ownerLabel`, `token`, `session` and `status` fields.

## Persistence and boundaries

Acquisition, reviewed restart, recovery and handoff use the coordinator journal and append durable
application history. Replay validates identities and event collisions before
writing documents, repairs an interrupted final history append and avoids duplicate
events and revision increments. All domain entry points recover pending journals.

Ordinary edits cannot change a claimed job; unrelated jobs remain editable.
Answer merge and pending-answer resolution require an idle coordinator, including
when they concern a different job. Complete the handoff first. A legacy session
with no review envelope can be rebuilt once, only with complete final-review
evidence and reviewed history; a partial or null envelope is rejected. Broader
attention projections and live Store activation remain separate work.
