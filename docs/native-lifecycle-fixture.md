# Native lifecycle migration boundaries

The synthetic version 10 fixture implements trash, restore and permanent delete
for jobs, resumes and answers. See [job Trash fixture](native-job-trash-fixture.md)
for the shared listing and browser contract.

## Python authority and native behavior

| Record | Store authority | HTTP authority |
| --- | --- | --- |
| Job | `scripts/job_apply_store/domains/jobs/crud.py` | `scripts/job_apply_workspace/domains/jobs.py` |
| Resume | `scripts/job_apply_store/domains/resumes/lifecycle.py` | `scripts/job_apply_workspace/domains/resumes.py` |
| Answer | `scripts/job_apply_store/domains/answers/mutations.py` | `scripts/job_apply_workspace/domains/answers.py` |

All lifecycle POST routes accept exactly `{expectedRevision: positive integer}`.
Python `auth.py` owns operation-aware redacted failures. Job delete returns
`{deleted, id}`; answer delete returns `{deleted, key}`. Resume HTTP mutations
run through `public_resume`, including deletion; preserve that projection rather
than assuming all lifecycle mutations return full records.

Resume trash checks revision before no-op detection. It blocks assignments by
active jobs and implicit use of the default resume by active unassigned jobs.
Trash clears the default flag and cancels open extraction requests through the
extraction journal. Restore checks managed digest identity or legacy path
identity against active resumes; it sets default only when no other active
resume exists. Neither operation changes managed content identity.

Resume delete returns an absent-record no-op before checking revision. Existing
records require revision, prior trash, no open extraction request, and no job
reference, including trashed jobs. Managed content is quarantined before record
removal. A metadata failure before replacement restores the canonical filename.
If replacement succeeded before a later failure was reported, the durable intent
remains and restart completes deletion. Cleanup failure after metadata deletion is
tolerated. Legacy source files are not removed.

Answer trash/restore checks revision before no-op detection, using the legacy
revision default of 1. Trash blocks immutable redirect targets. Mutation results
use the existing answer projection and reference counts. Permanent deletion
first rejects redirect source identities, then returns an absent-record no-op.
Existing records require revision, prior trash, no incoming redirect, no session
answerKeys or pendingFields reference, and no history answerKeys reference.
The session check includes terminal sessions. Do not remove protected references
to make deletion succeed. Job deletion retaining sessions is therefore material
to subsequent answer deletion behavior.

## Repository interfaces

Job deletion uses the existing `ClaimRepository.claimTransaction` snapshot,
`requireJobUnclaimed` contract, and `saveJobs`. It needs no new journal because
only jobs.json changes. Shared recovery remains the repository's responsibility.

Answer lifecycle can use existing `AnswerRepository.answerTransaction` with
`document`, `save`, and `AnswerReferenceCounts`. Redirect protection precedes
reference checks, so redirect-resolved reference counts do not weaken deletion
guards. Reuse `answerProjection` for mutation responses. The coordinator wires
the new leaf's HTTP/CLI entry points into shared dispatch.

Resume lifecycle needs one lock-consistent repository callback:

```ts
interface ResumeLifecycleTransaction {
  resumes: Document;
  jobs(): Promise<Document>;
  requests(): Promise<Document>;
  saveResumes(document: Document, closeRequests: boolean): Promise<void>;
  deleteManaged(record: Document, previous: Document, document: Document): Promise<void>;
}
interface ResumeLifecycleRepository {
  resumeLifecycleTransaction<T>(
    operation: (tx: ResumeLifecycleTransaction) => Promise<T>
  ): Promise<T>;
}
```

`saveResumes` should reuse extraction request closure and its existing journal.
`deleteManaged` uses `NativeResumeFiles`, and recovery runs under the Store lock
before ordinary resume access. Validation accepts canonical files, native staging
files and the exact owned quarantine pattern. Install and delete journal payloads
are closed schemas; foreign names and malformed recovery identities fail closed.

## Verification

Focused resume tests cover default selection, active and trashed job references,
extraction cancellation, managed-file removal, synchronous rollback and restart
at every durable delete boundary. Quarantine reconciliation restores the unique
referenced digest, removes owned orphans and rejects foreign names before cleanup.

Answer tests compare the native implementation with independent Python Stores
for legacy records, redirect sources and targets, sensitive projections,
current/stale/no-op revisions, pending fields, terminal sessions and protected
history. Raw session and history evidence remains intact.

The production browser exercises job, resume and answer restore/delete through
the native HTTP adapter with Python absent from the CLI PATH. It verifies exact
revision bodies, typed deletion, stale-conflict handling, redaction, managed-file
removal and canonical refresh after every acknowledged mutation.
