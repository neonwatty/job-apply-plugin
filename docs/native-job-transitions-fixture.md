# Native job transitions

New v9 synthetic fixtures support ordinary job status transitions through the shared TypeScript service, authenticated HTTP adapter, native CLI and Companion Jobs dialog. Use the setup in [the native claims guide](native-claims-fixture.md). Existing fixtures and live Stores are not adopted or upgraded, and the native path never falls back to Python.

## Status changes and safeguards

`JobTransitionsService.transition(id, status, expectedRevision, closedOutcome = null, userConfirmed = false)` requires a positive `bigint` revision and a boolean confirmation. Under the Store lock it checks that the job exists and is not deleted, compares its exact revision, and rejects a claim on that job before considering a same-status no-op. An expired claim still blocks ordinary transitions. A claim on an unrelated job does not block them.

These are the supported changes for an unclaimed job:

| Current status | Ordinary transition targets |
| --- | --- |
| `saved` | `needs_info`, `ready`, `closed` |
| `needs_info` | `saved`, `ready`, `closed` |
| `ready` | `saved`, `needs_info`, `closed` |
| `in_progress` | `needs_info`, `awaiting_review`, `closed` |
| `awaiting_review` | `applied`, `closed` |
| `applied` | `closed` |
| `closed` | `saved` |

A same-status request with the current revision returns the current record without writing, including an unclaimed `in_progress` record. Entering `in_progress` requires atomic acquisition or the reviewed-restart workflow; it cannot be done with an ordinary transition.

Entering `ready` runs profile and resume preflight under the same lock. Missing profile facts, missing resumes/files, or changed managed resume content prevent readiness. A same-status `ready` no-op does not rerun preflight. Entering `applied` requires explicit user confirmation. Entering `closed` requires one of `rejected`, `withdrawn`, `expired`, `duplicate` or `not_interested`. Every transition to an open status clears the closing outcome.

## CLI and HTTP

Use the native fixture root and lock artifact:

```sh
node runtime/cli/native-jobs.js --root /absolute/synthetic/root --native-lock /absolute/posix-lock.node job-transition --id example-job --status needs_info --expected-revision 3
node runtime/cli/native-jobs.js --root /absolute/synthetic/root --native-lock /absolute/posix-lock.node job-transition --id example-job --status applied --expected-revision 4 --user-confirmed
node runtime/cli/native-jobs.js --root /absolute/synthetic/root --native-lock /absolute/posix-lock.node job-transition --id example-job --status closed --expected-revision 5 --closed-outcome withdrawn
```

The examples illustrate independent operations; the source status must allow the requested target. `--user-confirmed` is a flag, not a string value. Always use the latest job revision.

Authenticated `POST /api/jobs/{id}/transition` accepts a JSON object with required `status` and positive integer `expectedRevision`, plus optional string-or-null `closedOutcome` and boolean `userConfirmed`. Unknown fields are rejected. For example, an owner who has personally submitted an awaiting-review application can send:

```json
{"status":"applied","expectedRevision":4,"userConfirmed":true}
```

Success returns HTTP 200 and the full updated job record, or the unchanged record for a valid no-op. CLI and HTTP share the same service. Service/CLI revisions remain exact beyond JavaScript's safe integer range; Companion rejects revisions it cannot represent safely.

## Companion and recovery

The selected Jobs dialog offers targets for the current status, requests confirmation for every action, and requires an explicit choice before closing. The Applied confirmation states that the owner personally submitted the application. Errors retain the closing outcome choice and ask the owner to refresh and review current state. Controls remain busy through the write; a response must acknowledge the requested job and status before the dialog accepts it.

For a claimless interrupted `in_progress` job, transition to `needs_info` to return it for owner input; it can subsequently become ready and be acquired again. An expired claim instead requires explicit same-job recovery through [application controls](native-claims-fixture.md). Reopening a closed job sets it to `saved` and clears its outcome. Restarting an awaiting-review application uses reviewed restart and requires confirmation that it was not submitted, intact review evidence and current managed resume readiness.

## Persistence, verification and remaining work

A successful change atomically replaces only `jobs.json`, increments the job revision once, and updates the job and document metadata timestamps. It does not write a session, append application history, rotate credentials or create a coordinator journal. Reopening and ordinary transitions preserve existing session/history evidence; they do not certify fresh form readiness. Pending native journals are recovered before the transaction, so recovery can independently repair prior interrupted work.

The synthetic test suite compares all status pairs and scalar outcomes with actual Python behavior, plus preflight, stale revisions, no-ops and claim guards. Native tests cover strict direct-call inputs, large exact revisions, unchanged bytes on denial, concurrent writers and injected write/fsync/replace failures. Array/object outcomes are rejected through native validation rather than reproducing Python's raw unhashable-value error.

Trash, restore, permanent deletion, intake/upsert and legacy job import remain outside this transition fixture. Final submission on employer sites remains human-only. Live Store adoption, native writer activation and final Python-free package cutover remain separate milestones.
