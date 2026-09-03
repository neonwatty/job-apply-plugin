# Resume Extraction Requests and Profile Preparedness Design

**Date:** 2026-09-03
**Status:** Proposed for implementation after owner review
**Base:** `origin/staging` at `7e3f489b63b8265fdcb49738edcc09b858eaf0a0`

## Summary

Job Apply will connect the existing resume library and resume-extraction proposal
workflow with a durable, value-free request queue. A person will be able to
import a resume in the Companion, explicitly request fact extraction, and later
review the resulting proposal in the same UX. The existing Job Apply agent—not
the browser workspace and not a newly embedded model—will perform extraction
from the managed local resume and complete the request through the canonical
Store.

The same slice will add a Store-owned profile-preparedness projection. It will
show whether essential setup is present, where common profile coverage is thin,
and whether extraction review needs attention. It will remain advisory and will
not claim that a profile is sufficient for any particular job.

This design closes the current orchestration gap without creating a second data
model: resumes, extraction requests, proposals, profile facts, and review
decisions all remain shared between the human UX and the CLI agent.

## Problem

The repository already supports most of the underlying workflow:

- The Companion can import managed PDF, DOCX, and TXT resumes; edit labels and
  tags; replace or adopt files; set a default; preview or download; and use
  trash, restore, and guarded permanent deletion.
- The canonical Store supports resume-extraction proposals, revision-aware
  review, automatic filling of missing unprotected facts, explicit resolution
  of conflicts, supersession, and crash-safe profile/proposal persistence.
- The Facts workspace can display existing proposals and collect per-path
  review decisions.

The missing link is authorship. The browser workspace cannot ask for
extraction, and its skill correctly does not invent proposals. A person can
import a resume and then reach a dead end unless they know how to prompt an
agent out of band. The UX also lacks a shared, explainable view of whether the
basic applicant profile is prepared.

## Goals

1. Let a person explicitly request fact extraction for a managed resume from
   the Companion.
2. Let an existing Job Apply agent discover and fulfill that exact request
   through supported CLI operations.
3. Reuse the existing proposal and review semantics rather than silently
   replacing human-confirmed facts.
4. Give the CLI and UX identical, Store-owned profile-preparedness information.
5. Keep resume bytes and extracted values out of the request queue, public
   projections, logs, activity receipts, and agent handoff text.
6. Preserve optimistic concurrency and crash-safe persistence across request,
   proposal, and profile changes.
7. Make waiting, cancellation, failure, staleness, retry, and review states
   obvious to a non-technical user.

## Non-goals

This slice will not:

- embed an extraction model in the Companion or Store;
- automatically launch, wake, or control a Codex task;
- extract automatically on resume import;
- add OCR or special handling for scanned documents;
- edit, generate, tailor, or score resumes;
- add cloud processing, synchronization, or telemetry;
- treat general profile coverage as proof that a specific application is ready;
- add resume-extraction requests to the job-focused Needs Attention workspace;
- expose resume paths, filenames, bytes, content digests, extracted candidates,
  or raw extraction errors in request list output; or
- activate a browser application flow or any final action.

## Product Principles

### One store, two clients

The Store is the sole mutation authority. The Companion and agent CLI use the
same revisioned request, proposal, profile, and preparedness contracts. The
browser server must not read or patch canonical JSON directly, and skills must
not recreate persistence rules in prompts.

### Explicit human intent

Importing a resume registers a local document. It does not authorize parsing or
profile mutation. Extraction begins only after a person selects **Request fact
extraction**, or explicitly asks an agent to create the same request.

### Honest agentic handoff

Creating a request records durable work; it does not imply that an agent is
currently running. The UX says that the next active Job Apply agent can process
the request and offers a value-free, copyable handoff prompt. It never displays
an artificial progress spinner or claims that extraction is underway.

### Human-confirmed facts remain authoritative

Extraction is a proposal workflow. Missing, null, unprotected facts may use the
existing safe auto-fill behavior. Conflicting or human-protected facts remain
pending until the person makes an explicit per-path decision.

### Preparedness is not job readiness

The new projection reports setup and coverage. It never predicts whether an
unknown employer form can be completed, and it does not replace the existing
job-specific readiness preflight.

## Architecture

### 1. Durable extraction request collection

Add a canonical extraction-request collection beside the existing proposal
collection. A request represents human intent and orchestration state, not a
partially formed extraction proposal. The two records stay separate so that a
waiting or failed request cannot be mistaken for extracted data.

Resume records already carry an opaque `contentRevision` distinct from their
general record revision. Import, replacement, adoption, or another operation
that changes the managed bytes replaces `contentRevision`; label, tag, and
default-selection edits do not. A request binds this existing token, so cosmetic
library organization cannot stale extraction while a real content change always
does. Request creation may assign a fresh opaque token to an older managed
record that predates this field only after the Store privately verifies its
current bytes against the stored digest.

New proposals created by request completion bind `resumeContentRevision` and
use it for content staleness, rather than treating an unrelated metadata
revision as a changed resume. Existing proposals retain their legacy
revision-and-digest validation for compatibility.

At most one open request may exist for a resume. `requested` is the only open
state. Terminal states are:

- `completed`: atomic completion created a proposal and records its opaque ID;
- `failed`: the agent closed the attempt with one approved reason code;
- `stale`: the selected resume content changed before completion; and
- `cancelled`: the person or agent explicitly cancelled the request.

There is deliberately no durable `processing` state in the first version.
Extraction has no external side effect, and an abandoned processing lease would
create misleading UX and recovery complexity. Multiple agents may perform the
same local computation, but revision validation ensures that only one can
complete the request.

### 2. Request-to-proposal completion

The agent resolves the managed resume privately, extracts a candidate, and asks
the Store to complete the open request. Completion is one atomic Store
operation:

1. Validate the request ID, open status, and expected request revision.
2. Validate the managed resume ID and expected resume content revision.
3. Validate the extracted candidate against the existing profile schema.
4. Validate the expected current profile revision.
5. If a pending proposal exists for the resume, validate the caller's explicit
   expected proposal ID and use the existing proposal-supersession contract.
6. Run the existing safe auto-fill logic for missing, null, unprotected facts.
7. Create the existing reviewable proposal for all remaining changes.
8. Mark the request `completed` and link the opaque proposal ID.
9. Commit request, proposal, and profile effects through the existing crash-safe
   transaction or journal boundary.

No proposal exists if candidate validation or any revision check fails. No
partial profile update exists if request completion fails.

If the profile changes between extraction and completion, the Store returns a
conflict. It does not silently rebase or automatically retry the candidate.

### 3. Profile-preparedness projection

Add one Store-owned, read-only projection consumed unchanged by both clients.
The projection has no aggregate percentage or quality score. It contains field
paths, group identifiers, presence states, and closed reason codes, never fact
values.

It has three layers:

#### Essential setup

- applicant name;
- applicant email; and
- a readable default managed resume.

Missing essentials are genuine onboarding blockers. The resume result is
derived from the existing managed-file observation contract, not from a
browser-maintained completion flag.

#### Common coverage

- phone;
- location;
- work history;
- education;
- skills; and
- professional links.

These are advisory `present` or `not_present` signals. Missing common coverage
does not block profile setup, job readiness, or agent use.

#### Review health

- open extraction request;
- failed or stale extraction request;
- proposal with unresolved conflicts; and
- human-protected facts retained during extraction.

Review-health items use stable IDs and reason codes so clients can link to the
right resume or proposal without copying its contents.

Presence is schema-aware and deterministic:

- essential identity requires non-blank `firstName` and `lastName` paths;
- essential email requires a non-blank canonical email value, but the
  projection does not claim inbox ownership or deliverability;
- essential resume requires a selected, managed, non-trashed default whose
  current private observation exists and matches its stored content;
- phone and professional-link coverage require at least one non-blank value in
  their respective path group;
- location coverage requires at least one meaningful location leaf supported
  by the existing profile schema; and
- work history, education, and skills require at least one non-empty entry.

Whitespace-only strings, empty objects, empty arrays, and null values are
`not_present`. Stable reason codes distinguish a missing value from an
unreadable or changed default resume. Clients may change wording, but they must
not recalculate these results.

### 4. Companion boundary

The authenticated Companion API may:

- list and inspect value-free extraction-request projections;
- create a request for a managed, non-trashed resume;
- cancel an open request;
- retry a failed or stale request by creating a new request that explicitly
  supersedes the old one; and
- read the preparedness projection.

The browser boundary cannot submit an extracted candidate, complete or fail a
request, specify a profile revision, or create a proposal. Those are agent/CLI
operations. This prevents a browser client from bypassing candidate validation
or impersonating extraction work.

### 5. Agent boundary

The helper exposes these supported commands:

```text
resume-extraction-request-create
resume-extraction-request-list
resume-extraction-request-get
resume-extraction-request-cancel
resume-extraction-request-complete
resume-extraction-request-fail
profile-preparedness-get
```

Create, cancel, complete, and fail require expected revisions. Retry is not a
special state mutation: it creates a new request with the terminal predecessor
as `supersedesRequestId`.

Completion also accepts an optional expected pending-proposal ID. It is required
when the resume already has a pending proposal and rejected otherwise, matching
the existing explicit supersession rule. The Store never guesses which proposal
an agent intended to replace.

The workspace-facing API maps only list, create, cancel, retry, and preparedness
read operations. The agent-facing helper is the only public surface that can
complete or fail a request.

The Job Apply resume/onboarding instructions check for open extraction requests
when the person asks to work on resumes, facts, or onboarding. They do not scan
for requests during every job application. When fulfilling a request, the agent
must resolve the exact managed resume through the private content path, use a
permission-restricted temporary candidate file if the helper requires one, and
delete that file after completion or failure.

## Data Contract

An extraction request contains only:

```json
{
  "requestId": "opaque-id",
  "resumeId": "opaque-id",
  "resumeContentRevision": "content_opaque-token",
  "revision": 1,
  "status": "requested",
  "createdAt": "timestamp",
  "updatedAt": "timestamp",
  "completedAt": null,
  "proposalId": null,
  "failureReason": null,
  "supersedesRequestId": null
}
```

Terminal timestamps may use one closed field or state-specific fields, provided
the schema is deterministic. The record must not contain resume text, extracted
values, local paths, filenames, content hashes, prompts, model output, stack
traces, or raw errors.

Approved failure reasons are:

- `content_unreadable`;
- `unsupported_resume`;
- `extraction_failed`;
- `candidate_invalid`; and
- `interrupted`.

User-facing copy is owned by clients and mapped from these codes. Arbitrary
failure strings are rejected and never persisted.

Replacing, adopting, or otherwise changing the managed resume content revision
atomically marks its open request `stale`. Trashing or permanently deleting a
resume must either stale or cancel its open request according to the existing
resume lifecycle transaction; it must never leave an actionable request that
resolves to unavailable content.

## User Experience

### Resumes workspace

Each active resume shows one extraction state and one primary action:

| State | Primary action | Supporting behavior |
| --- | --- | --- |
| No request or proposal | **Request fact extraction** | Explain that an active Job Apply agent will process it |
| `requested` | **Cancel request** | Show waiting state and copyable agent handoff |
| `completed` with pending proposal | **Review changes** | Link directly to grouped proposal review |
| `completed` with no pending review | **View facts** | Confirm that extracted facts were applied or previously reviewed |
| `failed` | **Try again** | Show friendly mapped reason and create a superseding request |
| `stale` | **Request fresh extraction** | Explain that the resume changed |
| `cancelled` | **Request fact extraction** | Create a new request without reviving the old record |

Request creation copy must say, in substance: “Request saved. The next active
Job Apply agent can extract facts from this resume.” It must not say “Extracting”
unless a future, separately designed worker lease provides truthful execution
state.

The copyable handoff contains only the request ID and a request to use the Job
Apply resume workflow. It contains no resume label, filename, path, facts, or
other applicant data.

### Profile readiness panel

The Facts workspace opens with a compact **Profile readiness** panel:

- an essential-setup section that distinguishes complete setup from blockers;
- grouped common-coverage rows with `Present` or `Not added` states;
- a review-health section linking to the relevant resume or proposal; and
- a standing reminder that individual jobs can require additional information.

There is no overall score, red/yellow/green employability signal, or “application
ready” badge.

### Grouped proposal review

Proposal changes are grouped as:

1. Identity
2. Contact
3. Location
4. Experience
5. Education
6. Skills
7. Links

For each conflict, the UX shows the current canonical value and provenance next
to the extracted candidate, then offers **Keep current** or **Use extracted**.
Conflicts start unselected. A safe **Keep all current** action is allowed;
**Accept all extracted** is not.

Replacing structured arrays such as work history or education requires an
additional confirmation that explains the whole collection will change.
Partial review remains pending and can be resumed. A stale proposal is not
reviewable; it links back to **Request fresh extraction**.

## Concurrency and Recovery

- **No agent is active:** the request remains `requested` indefinitely. There
  is no automatic timeout.
- **Two agents extract:** both may read the document, but only the first valid
  revision-aware completion succeeds. The second receives a conflict and must
  discard its candidate.
- **Person cancels during extraction:** cancellation increments the request
  revision. Later completion fails without creating a proposal or changing the
  profile.
- **Resume changes during extraction:** the open request becomes `stale` and
  later completion fails its content-revision check.
- **Profile changes during extraction:** completion fails its profile-revision
  check; no automatic merge or retry occurs.
- **Process interruption before completion:** the request remains `requested`
  or may be explicitly failed as `interrupted` by an agent that can prove the
  interrupted attempt. No `processing` cleanup is required.
- **Persistence interruption:** recovery yields either the complete old state
  or the complete new request/proposal/profile state through the existing
  transaction mechanism.

## Privacy and Security

1. Request list/get output is value-free and path-free.
2. General activity and receipts may record request IDs, state transitions, and
   reason codes only.
3. Resume content is available solely through the existing authenticated,
   managed private-content path.
4. Temporary candidate files are owner-readable only and are deleted on both
   success and failure.
5. Raw parser/model output, exception messages, and stack traces never enter the
   Store.
6. Existing authenticated proposal review may display candidate values locally;
   this is not broadened to request APIs, logs, or handoff prompts.
7. Browser-originated requests cannot complete extraction or inject candidate
   values.

## Delivery Slices

### Slice A: Store and CLI contract

- request schema, validation, and lifecycle;
- atomic completion into the existing proposal workflow;
- concurrency, staleness, supersession, and crash recovery;
- profile-preparedness projection; and
- value-free CLI commands and tests.

### Slice B: Companion API and Resumes workspace

- authenticated list/create/cancel/retry endpoints;
- extraction state and honest handoff copy in the Resumes workspace;
- direct navigation to proposal review; and
- adversarial browser-boundary tests proving candidate completion is absent.

### Slice C: Facts readiness and review polish

- shared preparedness panel;
- grouped conflict review;
- structured-array replacement confirmation;
- partial-review and stale-proposal UX; and
- responsive and accessibility verification.

### Slice D: Agent workflow and acceptance

- resume/onboarding request-discovery instructions;
- deterministic redacted-fixture extraction acceptance;
- temporary-file and output privacy checks; and
- cross-platform packaging verification.

Slices may be implemented on separate branches only after Slice A's interfaces
are fixed. Slice B and Slice C can then proceed in parallel because they consume
different Store projections and own different workspace components. Slice D
depends on the final CLI contract and must be integrated before the feature is
considered complete.

## Acceptance Proof

The complete feature must prove all of the following without using private owner
data or activating an application browser flow:

1. Import the repository's committed redacted resume fixture through the
   Companion.
2. Explicitly request extraction in the Resumes workspace.
3. List the exact same value-free request through the CLI.
4. Complete it with a deterministic extracted candidate.
5. Observe safe auto-filled missing facts and grouped pending conflicts in the
   Companion.
6. Keep one current value and accept one extracted value.
7. Read the same resulting profile and provenance through the CLI.
8. Replace the resume and prove the prior open request becomes stale.
9. Prove cancellation, two-agent completion conflict, profile-revision conflict,
   and crash recovery leave no partial profile or proposal state.
10. Prove request APIs, CLI output, logs, receipts, and handoff copy contain no
    resume bytes, paths, filenames, digests, fact values, or raw errors.
11. Run a fresh skill-driven agent acceptance against the redacted resume that
    stops at proposal/review and performs no job application or browser action.
12. Pass focused Store, CLI, Companion API, real-browser UX, packaging, Linux,
    macOS, and Windows validation while preserving existing behavior.

## Success Criteria

The feature is complete when a non-technical person can move from imported
resume to a truthful waiting state, an agent can fulfill that same durable
request, and the person can safely reconcile the resulting facts—all without
either client holding a private side channel or silently overwriting confirmed
data. The CLI and UX must report identical request and preparedness state from
the canonical Store.
