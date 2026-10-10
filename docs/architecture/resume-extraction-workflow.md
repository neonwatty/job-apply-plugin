# Resume extraction workflow extension

Status: implemented in the bounded experimental workflow, using disposable fixture host entry.
Baseline: `193358336d4fe74b9e8f2a675758bc48f0fd4a86` (stacked PR #207).

## Canonical services and approval boundary

`ExtractionRequests.createRequest` establishes a request bound to managed resume
content. `ResumeFactsService.completeRequest` creates an immutable resume-scoped
draft and completes that request. `ResumeFactsService.confirm` checks the exact
latest draft revision and current content revision before appending confirmation.
These services preserve the applicant-wide profile and other resumes' facts.

The legacy `ExtractionProposals` service auto-fills some unprotected profile paths
while creating proposals. The new workflow must use scoped requests and fact
drafts; it must not wrap that legacy path as if all writes awaited owner review.
A proposal in this extension means a canonical resume fact draft, not a legacy
applicant-wide profile proposal.

## State and guarded transitions

- Start verifies the exact managed resume revision, creates a scoped extraction
  request, and records a value-free request reference in the workflow subject.
- Propose accepts only validated candidate facts and the expected task revision.
  Code completes the exact canonical request into a draft. A candidate never
  changes the applicant-wide profile or marks facts confirmed.
- Review creates a pending question with a code-generated identity. The question
  binds the exact draft revision and resume content through the input scope hash.
- Accept requires a host user event matching the entire pending review. Code
  checks the live canonical draft and content before calling `confirm`.
- Reject closes the workflow and leaves the draft unconfirmed. There is no
  canonical rejected-fact state, so rejection must not invent one or mutate facts.
- Cancel safely closes an open request and clears the workflow pending question.
  A completed request and its draft remain intact.
- Interruption closes an open request with the canonical `interrupted` reason and
  terminalizes this workflow. A subsequent extraction starts through a fresh
  request or explicit canonical retry, never unseen reuse of candidate values.
- Stale content, missing managed bytes, a newer draft, or revision drift blocks
  proposal/review/accept. Safe cancellation and rejection remain available.

The LLM proposes facts or selects permitted actions. Code owns pending review,
revision increments, service calls and task completion. Resume bytes, fact values,
paths and filenames never enter workflow metadata or receipts.

Host attestation remains an explicit limitation: a parser flag or
`ownerConfirmed: true` is not independent evidence of a human approval. A fixture
host entry may require an explicit user-event flag, label it as attestation and
bind it exactly; it cannot advertise authenticated owner approval.

## Shared contract

The v1 job-only subject and closed outcome enum prevent this extension from being
registered without a versioned codec change. Keep existing job subjects compatible
and add a closed v2 resume subject containing `kind: resume`, `resumeId`,
`resumeRevision`, `inputRevision`, `requestId`, `requestRevision`, and nullable
`factRevision`. The request reference survives request completion and process
replacement; fact revision binds the review to one canonical immutable draft.

Closed outcomes: `extraction_requested`, `extraction_proposed`,
`extraction_review_pending`, `extraction_accepted`, `extraction_rejected`, and
`extraction_interrupted`, plus existing `cancelled`. The integration-owned
v2 codec and archive lookup contract preserve existing job receipt shapes. Resume IDs never occupy
`jobId` and resume operations never require an unrelated job.

Reuse route/action parsing, registry/profile access, action validation, the tool
gateway and `runDurableOperation`. Resume-specific leaves supply state guards and
canonical domain handlers. Global operation-ID lookup and replay continue through
the shared transaction-local hot/archive interface. Authorization precedes replay;
matching operations return exact old receipts without domain writes.

## Atomic persistence

Existing extraction transactions run under the canonical Store lock and buffer
profile/resume/request/proposal/fact updates through `NativeExtractionJournal`.
The workflow adapter must buffer service operations and append the updated jobs
workflow ledger to the same recovery boundary. Add a closed journal shape with a
validated `jobsDocument` destination and `workflow-extraction` kind. Validate every
destination before the first write; recover before ordinary Store access.

Never commit request/fact changes first and metadata second. That would permit
interruption to lose operation identity and repeat canonical work. Archive-aware
publication and lookup are shared interfaces owned by the integration and archive
workers. An unpublished archive must never become replay evidence.

## Verification scope

Use disposable native fixtures only. Focused tests must cover exact start and
proposal replay, changed-payload collision, profile/fact preservation, fabricated
or absent approval, exact pending review binding, stale request/content/draft,
reject/cancel/interruption, process replacement, profile revocation, failure before
and after journal publication, and installed executable fixture entry. A fresh
ordinary Store read must recover any accepted partial commit before replay.

No owner Store, live model, browser, dependency installation or publication is
part of these tests. Keep each source/test/runtime file at or below 500 lines.

## Executed verification receipt

The focused native suite passed scoped start/propose/review/accept/reject, exact
replay and collision, canonical request adoption, stale replacement/newer draft,
revocation, safe cancellation and interruption. Injected exceptions after journal,
request, fact and jobs publication recover through ordinary Store access without
duplicate draft creation. These are write-boundary exception tests, not a claim
of operating-system process-kill coverage for proposal/review commits. The
integration adds a separate seven-boundary process-kill regression for first
resume start from pressured v1 history, including archive and extraction journal
publication before v2 jobs are durable.

The installed runtime copy passed the same fixture host start/proposal/review and
accept flow with an empty PATH, a disposable HOME, explicit fixture paths, absent
and explicit attestation, process replacement between operations, and inert
replay. Existing native extraction recovery tests passed. The deterministic build
and source-size check passed. Integration owns affected/release and archive-wide
acceptance checks; no live model or owner Store was used.
