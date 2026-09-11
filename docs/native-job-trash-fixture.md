# Native Trash and job recovery fixture

The opt-in version 9 native fixture supports a unified Trash listing and reversible
job trash/restore and permanent deletion through its CLI and authenticated HTTP API. A trashed job is
hidden from ordinary Jobs results. Restoring it makes it visible in Companion
Jobs after Refresh or reload, retaining its saved fields and local status.

This tranche adds API and CLI operations only. The native Companion has no Trash
section or browser trash/restore buttons yet. Full Trash UI and
resume/answer lifecycle operations remain separate integration work.

## Use a synthetic fixture

Follow [Native Jobs fixture](native-jobs-fixture.md) to initialize a new disposable
Store and build the native lock addon. Keep real applicant data and Python
writers away from this fixture. With a synthetic job ID and its current revision:

```sh
node runtime/cli/native-jobs.js --root /private/tmp/new-native-jobs --native-lock /absolute/flock.node trash-list
node runtime/cli/native-jobs.js --root /private/tmp/new-native-jobs --native-lock /absolute/flock.node job-trash --id SYNTHETIC_JOB_ID --expected-revision 1
node runtime/cli/native-jobs.js --root /private/tmp/new-native-jobs --native-lock /absolute/flock.node job-restore --id SYNTHETIC_JOB_ID --expected-revision 2
```

Use the revision returned by the preceding operation, rather than assuming the
example numbers. The fixture CLI returns the updated job directly. Trash sets
`deletedAt`; restore clears it. A state change increments revision and updates
timestamps. Repeating the operation at the current revision when already in the
requested state returns the current job without rewriting it.

Both operations reject stale revisions and existing coordinator claims, including
expired leases. Restore also rejects
an unavailable associated resume or an active job with the same normalized URL.
These failures leave the job unchanged. The commands do not submit an application,
change its local status, or permanently remove stored content.

## Permanent job deletion

`job-delete --id SYNTHETIC_JOB_ID --expected-revision CURRENT_REVISION` and
`POST /api/jobs/:id/delete` permanently remove a trashed job. The POST accepts
only `{"expectedRevision": CURRENT_REVISION}`. The response is `{deleted, id}`,
not a job record. Missing jobs return `deleted: false`, even with an old revision.
Existing jobs require the current revision, no coordinator claim (including an
expired claim), prior trash, and an absent or completed/abandoned session, in
that order. Session and application history evidence remains byte-for-byte intact.
Failures before atomic replacement preserve the record. A later failure can
report an error after deletion has taken effect. Refresh canonical state after
any failed deletion before deciding whether another attempt is appropriate.

HTTP failures use redacted lifecycle metadata: `recordType: "job"`,
`operation: "delete"`, and fixed blocker counts. Nonterminal sessions return
409 `session_reference_blocked` with `nonterminalSessions: 1`. Confirmation is
an explicit UI responsibility; it is not an additional HTTP request field.
A client should refresh after success and must not blindly retry conflicts.

## Listing and HTTP contract

`trash-list` and authenticated `GET /api/trash` return `{items, counts, total}`.
The listing includes trashed jobs, resumes and answers already present in the
fixture, with deterministic ordering, revisions, labels, deletion timestamps and
reference blocker counts. Job rows include local status and company; answer rows
include state and review status. It excludes job URLs and notes, resume paths,
answer values and claim credentials. Blocker counts describe references; they
are not a promise that every restore or deletion request would be accepted.

Authenticated `POST /api/jobs/:id/trash` and `POST /api/jobs/:id/restore` accept
`{"expectedRevision": CURRENT_REVISION}` and return the updated job. The normal
loopback authorization and origin checks still apply. Unlike the redacted Trash
listing, these job mutation responses retain the ordinary full job contract.

The existing fixture marker, lock, validation and recovery boundaries remain in
force. This does not activate native writes for existing owner Stores, change the
installed launcher default or authorize simultaneous Python and native writers.

## Browser proof

The production browser walkthrough uses an isolated fixture with Python absent
from the native CLI's PATH. It checks that external trash preserves an open
editor draft, Refresh hides the trashed card, native CLI and authenticated HTTP
Trash listings agree and omit private fields, stale restoration leaves Jobs
unchanged, and restoration survives reload with the saved content intact. It
exercises both CLI trash with HTTP restore and HTTP trash with CLI restore.
