### Phase 1: Profile Setup

If `profile-get` returns an empty object, or if the user requests a reset:

1. **Import the resume into canonical managed storage**. Put only `{"label":"Primary resume","path":"<user-provided-source>"}` in a private temporary input, run `resume-import --input <private-temp.json>`, retain the returned opaque resume ID, and immediately remove the input. Never use the source path for a browser upload.
2. **Resolve the managed resume** with `resume-resolve --id <resume-id>`. Treat its returned private path as ephemeral sensitive output: use it only for local reading and visible file upload, and never quote it to the user or place it in logs, profile data, history, or sessions.
3. **Read the resolved managed resume file** using the Read tool
4. **Extract structured data** into these categories:
   - `firstName`, `lastName`
   - `email`, `phone`
   - `location` (city, state, country, zip)
   - `linkedInUrl`, `portfolioUrl`, `githubUrl` (if present)
   - `workHistory[]`: array of { company, title, startDate, endDate, current, description }
   - `education[]`: array of { school, degree, field, startDate, endDate, gpa }
   - `skills[]`: array of skill strings
   - Do not store a resume path in the profile; the resume ID and managed library are authoritative.
5. **Obtain profile review** without echoing raw applicant values in chat; use the owner-visible canonical workspace for reviewing values and ask about missing facts by field name.
6. **Inspect and save confirmed profile** by running `profile-inspect`, retaining its revision, then calling `profile-replace --input <private-temp-profile.json> --expected-revision <inspected-revision> --source user`. Remove the temporary input. If the revision conflicts, stop and review the newly inspected profile; never replace unseen changes.

For re-extraction from a managed resume, do not replace the profile wholesale or
create a proposal outside the bounded request workflow in [extraction.md](extraction.md). The store auto-fills
only absent/null unprotected facts. Leave every pending conflict for the owner's
explicit per-path review through `resume-proposal-review`.
