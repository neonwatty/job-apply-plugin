# Resume-scoped facts and application input lock

## User flow

1. Import a managed resume. The import queues fact extraction by default. An
   explicit opt-out stores only the file. A queued request remains visible when
   no agent is available to process it.
2. An agent reads that exact managed file and creates a draft fact set tied to
   its resume ID and content revision. Extraction never silently writes the
   applicant-wide legacy profile.
3. The owner reviews and edits the draft under **Resumes → [resume] → Facts**.
   Confirmation marks one exact fact revision ready. Changing facts creates a
   new revision that needs confirmation. Replacing the resume makes its prior
   extraction stale; the old facts remain available for audit and review.
4. For an exact job, the agent presents available resumes and fact status in
   chat. The owner confirms the chosen resume and associated fact revision for
   that job. A default resume is only a suggestion, never implicit consent.
5. The job attempt records the chosen resume ID, resume content revision, and
   confirmed fact revision. Preflight, acquisition, progress, and handoff reject
   missing, stale, or changed input. No other resume or fact set is substituted.
   The agent pauses browser work and asks for renewed confirmation after drift.
6. The agent obtains the existing post-readiness fill consent after the exact
   application form is visible. The owner alone submits the final application.

## Store contract

- Keep resume files and metadata in the existing managed resume library.
- Store one versioned fact-set history per resume ID, bound to immutable resume
  content revisions. Each version has a state of `draft` or `confirmed`; staleness
  is derived by comparing its bound content revision with the current resume. A fact set contains applicant profile facts only; reusable answers to
  job application questions remain in the answer library.
- Extraction requests and agent-authored candidates reference the same resume
  identity. Repeated extraction or a resume replacement creates a new draft
  revision without overwriting a confirmed version.
- Confirmation requires the exact displayed fact revision and resume content
  revision. A confirmed version is immutable. Editing forks a draft revision.
- Record a separate job input selection with exact job, resume, content, and
  fact revisions plus the owner's explicit chat confirmation. The selected fact
  version is the only applicant profile source for that application attempt.
- Preserve legacy `profile.json`, CLI responses, and existing extraction records
  for compatibility. Do not assign existing profile facts to a resume by guess.
  Existing jobs need explicit resume-and-facts confirmation before using the new
  agent workflow. Never mix Python and TypeScript writers on one live Store.

## UX and agent boundaries

- Resumes shows extraction status and a Facts action for each resume. The review
  surface displays draft and confirmed revisions, field edits, and stale state.
- Overview sends scoped fact review to Resumes, including its setup link, so a
  first import does not lead to the applicant-wide legacy Facts page.
- The agent asks for the resume and facts choice in chat. The UX is for detailed
  review and correction; a UI click alone cannot authorize application use.
- Job and attempt views show the selected resume label and closed fact status,
  with no applicant values in value-free activity or diagnostic projections.
- Claim tokens, managed paths, candidate values, and browser state never enter
  the selection receipt, activity history, or logs.

## Acceptance checks

- Two resumes can hold different facts without changing each other.
- Import queues extraction by default; explicit opt-out does not queue it.
- An agent can complete an extraction, but a draft cannot start browser work.
- Chat confirmation for resume A and its confirmed facts allows only A for the
  exact job. A default resume B cannot replace it.
- Resume replacement, fact edit, or a stale job revision invalidates selection.
- Existing legacy Store documents remain readable without silent migration.
- The final third-party submit action remains human-only.
