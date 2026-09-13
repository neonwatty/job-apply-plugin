# Shared Job Application Workspace Design

**Date:** 2026-08-24  
**Status:** Proposed  
**Scope:** High-level product and storage contract for a local companion UX shared by people and Job Apply agents

## Summary

Job Apply will add an optional, local-first workspace that gives people and CLI agents equal access to the same durable job-application data. The browser UX is a visual CRUD client. The CLI and its skills are the agentic client. Neither client owns a separate queue, profile, or answer store.

The durable store is the prerequisite. It must become the canonical source for resume-extracted facts, resumes, search preferences, observed questions and answers, jobs, application status, resumable progress, and minimal lifecycle history before the companion UX is built.

The first UX is an information-dense, calm desktop workspace centered on a jobs table. It helps a person organize opportunities, correct resume-extracted facts, maintain reusable answers, assign resumes, and mark jobs ready for agentic application. Application execution remains in Codex or Claude Code through the existing visible-browser workflow.

## Goals

1. Give people and agents one durable source of truth for all user-owned Job Apply data.
2. Make every durable value the CLI reads or creates available through a supported CRUD interface.
3. Make resume-extracted facts fully reviewable and editable without requiring resume replacement.
4. Replace Markdown search results and application queues as the ongoing job system of record.
5. Let a person mark jobs ready and let a CLI agent list and process those same jobs.
6. Preserve the current privacy, consent, resumability, and manual-submission boundaries.
7. Support safe migration from the existing local store and compatibility Markdown files.
8. Keep the companion UX optional and host-independent.

## Non-goals

The first version will not include:

- a hosted account, cloud synchronization, collaboration, or telemetry;
- embedded agent chat, an embedded terminal, or live terminal streaming;
- automatic application submission or inferred submission confirmation;
- automated fit scores, funnel analytics, reminders, or operating-system notifications;
- proactive question packs, interview coaching, resume tailoring, or cover-letter generation;
- a contact, outreach, or recruiting CRM;
- email or calendar integrations;
- concurrent application agents;
- dedicated export workflows; or
- fully customizable pipeline stages.

## Core product principles

### One store, two equal clients

The UX and CLI use the same versioned helper contract. The UX must not read or patch canonical files directly, and agents must not recreate storage behavior in prompts or scripts.

If a record or field appears as editable user data in the UX, the CLI must be able to list, inspect, create, and update it through the same supported contract. If the UX can trash, restore, or permanently delete a record, equivalent guarded CLI operations must exist.

### Durable data before presentation

The durable store and its tests are delivered before the companion UX. The UX must not introduce a second persistence layer or use Markdown as its writable backing model.

### Human and agent share one workflow

A job's application status is the handoff protocol. There is no separate persistent, user-facing "agent state" column. Short-lived runtime ownership may be stored internally to prevent duplicate work, but it is shown only as current activity and never becomes a second job lifecycle.

### User edits are authoritative

Resume extraction and agent enrichment propose facts. A confirmed human edit wins until the person explicitly accepts a later proposed replacement. Re-importing a resume or re-enriching a job presents a diff instead of silently overwriting confirmed user data.

### Minimize sensitive duplication

Application history and resumable progress continue to reference answer keys rather than copying answer values. The workspace does not create full application snapshots. Sensitive-answer use and sensitive-answer retention remain separate decisions.

## Current repository state

The existing store contains:

- `profile.json` for resume-derived applicant data and search preferences;
- `answers.json` for scoped reusable answers and consent metadata;
- `applications.jsonl` for minimal append-only lifecycle events;
- `sessions/*.json` for resumable, value-free application progress; and
- optional closed Auto-submit policy state that does not authorize live final actions.

The existing helper supports whole-profile replacement, preference merge, answer lookup and put, history append/list, and session CRUD. It does not provide a canonical job collection, resume library, answer listing/deletion, fine-grained profile editing, trash, migration previews, or a general CRUD surface for a companion UX.

Job search results are written to timestamped Markdown files. An optional application queue is also a Markdown table. These remain import sources but will not remain authoritative after migration.

## Information architecture

The first companion UX has five primary surfaces.

### Jobs

The opening screen is a dense, searchable, filterable jobs table. It supports inline priority and status editing, column configuration, bulk URL capture, record creation, a job-detail side panel, trash, restore, and permanent deletion.

### Facts

Facts is the structured applicant profile extracted from resumes and corrected by the user. It includes identity, contact details, location, professional links, work history, education, skills, and search preferences.

### Answers

Answers contains an observed-question review inbox and a searchable reusable-answer library. It exposes state, sensitivity, scope, aliases, provenance, and confirmation metadata. It supports create, edit, merge, trash, restore, and guarded permanent deletion.

### Resumes

Resumes lists registered resume files and their stable local records. A person can label, inspect, assign, replace, trash, restore, and permanently remove records. Jobs may refer to one assigned resume. File contents are not copied into history.

### Trash

Trash contains recoverable jobs, answers, and resume records. Normal deletion moves a record to Trash. Permanent deletion requires an explicit destructive action. Minimal append-only application history remains protected unless the person deletes the complete local Job Apply store.

## Canonical entities

### Applicant facts

The profile preserves the existing applicant shape while adding supported fine-grained updates and provenance metadata. Editable facts include:

- first and last name;
- email and phone;
- city, state or region, postal code, and country;
- LinkedIn, GitHub, portfolio, and other professional links;
- work-history entries;
- education entries;
- skills; and
- other resume-derived fields retained for forward compatibility.

Each editable fact or structured entry can record its source, such as resume extraction, user edit, migration, or agent update, plus its last-updated time. Provenance is supporting metadata, not a restriction on future editing.

Resume re-extraction produces a reviewable proposal. It never silently replaces confirmed user edits.

### Search preferences

Search preferences remain part of the shared applicant profile and include target titles, minimum base salary, remote preference, exclusion patterns, and default time range. Both clients support selective updates without replacing unrelated facts.

### Resume records

A resume record contains:

- a stable opaque identifier;
- a user-facing label;
- an absolute local file path;
- optional tags or role-family labels;
- whether it is the default;
- file-observation metadata sufficient to warn when a file moved or changed;
- creation and update timestamps; and
- trash metadata when applicable.

A resume record references a file; it does not duplicate the file contents. Missing or changed files are reported as readiness issues.

### Observed questions and reusable answers

The existing answer identity, normalization, alias, scope, sensitivity, confirmation, and remember-consent rules remain authoritative.

The durable contract adds list, selective update, merge, trash, restore, and permanent-delete operations. Only questions encountered during actual search or application workflows enter the first-version review inbox. The product does not seed proactive answer packs.

Merging answers preserves stable aliases and updates job or session references safely. Permanent deletion must fail or require an explicit cascade decision when live sessions still reference the answer key.

### Job records

A canonical job record contains, at minimum:

- a stable opaque identifier;
- original and normalized application or listing URL;
- source and optional source-specific identifier;
- role and company;
- location and workplace arrangement when known;
- employment type and compensation text when known;
- job description or summary when retained;
- detected ATS family when known;
- manual priority;
- application status and optional closed outcome;
- assigned resume identifier when set;
- user notes;
- provenance and last-checked metadata;
- created and updated timestamps; and
- trash metadata when applicable.

The schema accepts partial jobs. A manually pasted URL can be saved before title, company, ATS, or description is known. Missing metadata can later be filled by the user or an agent enrichment workflow.

Duplicate detection uses normalized URLs and available source identifiers. Ambiguous matches require review rather than silent merging.

### Application progress and history

The job record carries the current application status. Resumable sessions continue to carry the current step, answer-key references, and pending-field descriptions without values. Minimal append-only history records lifecycle events and does not become a user-editable application snapshot.

Current status and append-only history must remain consistent through one atomic helper operation. A status change cannot succeed while its required lifecycle event fails to persist.

## Application status model

The focused shared workflow is:

1. `saved`
2. `needs_info`
3. `ready`
4. `in_progress`
5. `awaiting_review`
6. `applied`
7. `closed`

Closed jobs may have one outcome:

- `rejected`
- `withdrawn`
- `expired`
- `duplicate`
- `not_interested`

### Status semantics

- `saved`: Collected but not yet queued for application.
- `needs_info`: A person or agent identified missing information that blocks readiness or continuation.
- `ready`: The person has deliberately queued the job for agentic application and accepted the light preflight result.
- `in_progress`: The CLI agent has begun the selected application.
- `awaiting_review`: The application has reached final review and awaits the person; the agent must not activate the final action.
- `applied`: The person explicitly confirmed submission.
- `closed`: Work will not continue; a closed outcome explains why.

Only explicit user confirmation moves a job to `applied`. Browser text, a policy decision, or an agent inference is insufficient.

### Ready preflight

Moving a job to `ready` checks:

- a supported HTTP(S) URL exists;
- the assigned or default resume record exists and its file is currently readable;
- the applicant profile is readable and valid;
- no duplicate active application is known; and
- known unresolved issues are presented.

Unknown future form questions are expected and do not block readiness. The person may acknowledge non-blocking warnings.

## Shared CRUD contract

The storage helper remains the sole mutation authority. Its public operations expand to cover:

- profile get, patch, replace, reset, and resume-extraction proposal review;
- preference get and selective update;
- resume list, get, create, update, set-default, trash, restore, and permanent delete;
- answer list, get, find, create or put, selective update, merge, trash, restore, and permanent delete;
- job list, get, create, bulk upsert, selective update, transition, trash, restore, and permanent delete;
- readiness preflight;
- ready-job listing;
- one global runtime claim, heartbeat, release, and stale-claim recovery;
- pending-question creation and resolution;
- migration discovery, preview, and commit; and
- existing history and session operations.

List operations support stable pagination, filtering, and sorting so the CLI and UX see consistent results. Mutations support optimistic revision checks so stale UI tabs or agent turns cannot silently overwrite newer edits.

All successful CLI operations return machine-readable JSON. Errors remain terse and must not echo stored values.

## Human workflow

1. The person starts the optional local workspace with one Job Apply command.
2. The browser opens a loopback-only local application.
3. The person reviews or corrects resume-extracted facts and registers resume versions.
4. The person adds job URLs, imports discovered jobs, or edits existing job records.
5. The person assigns a resume and marks selected jobs `ready` after preflight.
6. The person returns to the CLI when they want an agent to apply.
7. The app reflects subsequent status, pending-question, and history updates from the shared store.
8. At final review, the person inspects the visible application and later explicitly marks the job `applied` if they submitted it.

## Agent workflow

1. The agent initializes the shared store through the helper.
2. On request, it lists jobs with status `ready` and presents them without exposing unrelated private values.
3. The person selects a job.
4. The helper acquires the single global runtime claim and atomically transitions the selected job to `in_progress`.
5. The agent loads the job, assigned resume, applicant facts, and applicable answers.
6. If required data is missing, it records value-free pending-question metadata and transitions the job to `needs_info` when continuation is blocked.
7. It saves resumable progress after meaningful non-final steps.
8. At final review, it records the minimal reviewed event and transitions the job to `awaiting_review`.
9. It releases the runtime claim without activating Submit, Send, Apply, or an equivalent final action.
10. Only later user confirmation transitions the job to `applied`.

## Job capture and enrichment

Jobs enter the canonical store through both clients.

### Human capture

The UX supports single-record CRUD and bulk URL paste. A partial job is valid and can remain `saved` until enriched.

### Agent capture

The CLI can import structured search results, browse a LinkedIn Saved Jobs list in the user's selected visible browser, or collect jobs from another user-selected page. It bulk-upserts canonical records with provenance rather than writing a new Markdown queue.

### Agent enrichment

The CLI can list partial jobs selected for enrichment. It uses the visible browser for authenticated sources, records proposed or newly observed metadata, and never silently overwrites authoritative human edits. Enrichment is not a separate persistent application status.

## Local companion architecture

The companion is started by one CLI command. It binds only to loopback, opens the default browser, and reports how to stop it. It requires no account and sends no Job Apply data to a plugin-owned service.

The local server calls the same storage library or helper contract as the CLI. It must not expose arbitrary filesystem access or a generic command-execution endpoint. Mutating requests use local anti-forgery protection and optimistic revisions. The process exits cleanly without corrupting canonical files.

The physical representation of new records may evolve during durable-store implementation, but the public helper contract, schemas, migration behavior, permissions, and atomicity are authoritative. Existing version-1 documents must continue to fail closed on corruption or future schema versions.

## Migration and compatibility

Migration is explicit, previewable, non-destructive, and idempotent.

The importer can discover:

- timestamped search-result Markdown files under the compatibility directory;
- an existing `application_queue.md` at its documented location;
- the existing canonical profile and answers;
- existing application history and resumable sessions; and
- the legacy profile already handled by current initialization.

The preview reports parsed records, incomplete records, likely duplicates, and skipped content without mutating the store. Commit imports selected records and retains source provenance. Original files remain untouched.

After migration, the structured job store is authoritative. Continuous two-way Markdown synchronization is not supported. Existing Markdown output may remain as an explicit compatibility export during a transition period, but skills must not treat it as the primary queue.

## Privacy and safety

1. All data remains local unless the person directs an agent to use it on a third-party site.
2. Canonical files and directories retain user-only permissions where supported.
3. The local UX displays stored values without a separate unlock screen in version one.
4. Credentials, authentication state, CAPTCHA or MFA data, payment data, and browser session data remain invalid storage inputs.
5. Sensitive-answer current-use consent remains separate from remember consent.
6. History and sessions do not duplicate answer values.
7. Normal deletion is recoverable; permanent deletion is explicit and narrowly targeted.
8. Corrupt or future-version data fails non-destructively.
9. The companion UX does not weaken the current manual final-action boundary.

## Delivery sequence

### Milestone 1: Durable contract

- Finalize canonical schemas and status transitions.
- Add job, resume, profile-patch, answer-list, trash, revision, and claim operations.
- Add unit and integration coverage for atomicity, validation, privacy, and concurrency.
- Preserve all current helper and skill behavior.

### Milestone 2: CLI integration

- Expose shared CRUD and list operations to agent workflows.
- Update search to bulk-upsert canonical jobs.
- Update application flow to consume ready jobs and persist status transitions.
- Add guided migration preview and commit.

### Milestone 3: Companion UX

- Add the loopback-only local server and one-command launcher.
- Build Jobs, Facts, Answers, Resumes, and Trash surfaces.
- Use only the shared storage contract.
- Verify accessibility, keyboard use, conflict handling, and safe shutdown.

## Acceptance criteria

1. A job created in the UX is immediately listable and editable by the CLI, and a job created by the CLI is immediately visible and editable in the UX.
2. Resume-extracted facts can be selectively edited without replacing unrelated profile data.
3. Resume re-extraction cannot silently overwrite confirmed human edits.
4. Search preferences and observed answers have full supported CRUD parity across both clients.
5. A person can mark a valid job `ready`, and the CLI can list and select it for application.
6. Only one application agent can hold the global runtime claim at a time.
7. Application progress uses the focused shared status model and no second persistent agent-status model.
8. Only explicit user confirmation can move a job to `applied`.
9. Trashed user records can be restored; permanent deletion is explicit and does not accept broad or ambiguous targets.
10. History and sessions remain value-free, and no new store accepts credentials or browser state.
11. Existing version-1 stores initialize without destructive migration and retain current behavior.
12. Existing Markdown queues and search results can be previewed and imported without modifying their source files.
13. The optional UX runs locally without an account, cloud service, or telemetry.
14. All canonical mutations go through the shared helper or storage library and are covered by validation and atomicity tests.

## Relationship to the existing repository

This design extends the current answer-memory contract rather than replacing it. The existing helper remains the trust boundary for local persistent state. The current visible-browser, sensitive-answer, resume-upload, resumable-session, replay-QA, and manual-submission rules remain in force.

The existing static `site/` is the public project website and is not the companion application described here. The local workspace will be introduced as a separate runtime surface after the durable contract and CLI integration are established.
