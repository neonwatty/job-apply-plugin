# Native lifecycle migration boundaries

The first lifecycle tranche implements permanent job deletion in the synthetic
version 9 fixture. See [job Trash fixture](native-job-trash-fixture.md) for the
runnable CLI and HTTP contract. Resume and answer lifecycle operations below
are mapped work, not enabled native functionality.

## Python authority and remaining behavior

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
removal. Python restores quarantine on metadata write failure and tolerates an
unlink failure after successful metadata deletion. Legacy source files are not
removed. Crash recovery needs explicit fixture support before route activation.

Answer trash/restore checks revision before no-op detection, using the legacy
revision default of 1. Trash blocks immutable redirect targets. Mutation results
use the existing answer projection and reference counts. Permanent deletion
first rejects redirect source identities, then returns an absent-record no-op.
Existing records require revision, prior trash, no incoming redirect, no session
answerKeys or pendingFields reference, and no history answerKeys reference.
The session check includes terminal sessions. Do not remove protected references
to make deletion succeed. Job deletion retaining sessions is therefore material
to subsequent answer deletion behavior.

## Narrow proposed repository interfaces

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
  jobs: Document;
  requests: Document;
  saveResumes(document: Document): Promise<void>;
  deleteManaged(record: Document, document: Document): Promise<void>;
}
interface ResumeLifecycleRepository {
  resumeLifecycleTransaction<T>(
    operation: (tx: ResumeLifecycleTransaction) => Promise<T>
  ): Promise<T>;
}
```

`saveResumes` should reuse extraction request closure and its existing journal.
`deleteManaged` belongs to a new owned Store leaf, with the coordinator composing
recovery before ordinary resume recovery. This is a proposal, not a committed
API. The existing `NativeResumeFiles.validate` accepts canonical files and native
temporary files only, and its recovery journal accepts install operations only.
Adding quarantine filenames or a deletion operation requires a reviewed recovery
contract and shared wiring; do not loosen validation or create unrecognized
journals in a version 9 Store as a shortcut.

## Required next evidence

Resume acceptance needs independent cloned Python/native Stores covering default
selection, active and trashed job references, duplicate identities, extraction
cancellation, open-request delete rejection, and managed/legacy/missing files.
Inject rename, metadata write, unlink, and directory sync failures and restart
at every durable boundary. Reject links, traversal, foreign files and malformed
journals before cleanup. Check that unrelated files and metadata remain intact.

Answer acceptance needs independent Python/native comparisons for legacy
records, redirect sources/targets, sensitive projection, current/stale/no-op
revisions, pending fields, terminal sessions and protected history. Preserve raw
session/history bytes and compare redacted HTTP error counts.

The coordinator owns catalogs, normal hooks, review, browser integration and
staging publication. A browser may exercise the new job delete route after
explicit confirmation and must refresh canonical state after acknowledgment.
It must continue treating native resume/answer lifecycle routes as unsupported.
