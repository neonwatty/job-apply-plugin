### Agent-first resume onboarding

Use this flow for initial setup or a user-requested resume import. The companion
is optional. Reuse a supplied local resume path; otherwise ask for one. Do not
open an application browser or invent a synthetic job during onboarding.

1. Import the selected resume through `resume-import --input <private-temp.json>`.
   The input contains `label` and the user-provided `path`. Retain the returned
   opaque resume ID and revision, then delete the temporary input. If the owner
   selected an existing managed resume, use its current ID/revision instead of
   importing another copy. Never use a source path for browser upload.
2. For the selected managed resume, check
   `resume-extraction-request-list --resume-id <id> --status requested` and reuse
   its exact open request if present. Otherwise create
   `resume-extraction-request-create --resume-id <id>
   --expected-resume-revision <revision>` and retain that exact request ID. Follow
   [extraction](extraction.md) to read the complete managed document and complete
   the request semantically. Do not route the owner to the UI to create a request
   or make them invoke another skill to finish this already-requested extraction.
   On a conflict, inspect the current state; do not silently create duplicate work.
3. Present a readable review in the conversation: contact details, work history,
   education, skills, and relevant links. Preserve separate promotion-related
   positions and their dates; associate shared descriptions only where the source
   supports them. Mark uncertain facts and omissions instead of guessing.
   Use canonical fields: `firstName`, `lastName`, `email`, `phone`, `location`,
   `linkedInUrl`, `portfolioUrl`, `githubUrl`, `workHistory[]` (company, title,
   startDate, endDate, current, description), `education[]` (school, degree,
   field, startDate, endDate, gpa), and `skills[]`. Never store resume paths in facts.
4. Explain which absent facts were filled and which conflicts need review. Keep
   existing user-confirmed facts. Apply only the owner's explicit per-path choices
   through `resume-proposal-review` at the inspected revisions. Do not replace the
   whole profile or mark extracted facts as user-confirmed merely because they
   were parsed. Facts/Resumes are optional review/edit destinations.
5. After the owner finishes resume review, offer either a job URL/browser page
   (for example, saved jobs or selected search results) or manual Jobs entry.
   Ask for the source and count/filter if missing. Wait for that selection; do not
   automatically browse, import a sample job, mark jobs Ready, or begin applying.
   For agent intake, follow [queue intake](../../job-search/references/queue.md).

Keep private managed paths, candidate files, and claim tokens out of chat. A
user-directed fact review may contain applicant values; operational logs,
handoff packets, and durable QA receipts stay value-free. Clean up temporary
resume material on success, failure, conflict, or interruption.
