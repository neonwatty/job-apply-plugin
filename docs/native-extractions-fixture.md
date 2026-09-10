# Native extraction review

The synthetic native workspace supports resume extraction requests, proposals,
and review through shared TypeScript services. Create a fresh fixture using
[the native launcher guide](native-jobs-fixture.md). Extraction support was introduced in fixture version 5 and continues in version 7. It adds
`resume-extractions.json`, `resume-extraction-requests.json`, and
`resume-extraction-journal.json`. Earlier fixtures must be recreated at a new
path. Existing Python Stores remain unsupported.

## Workflow

Import a managed resume in Resumes, then open Resume extraction and choose it.
Request extraction records work for an agent; it does not run a model or extract
the file by itself. The native CLI exposes request get/list and complete/fail
commands for the agent. The agent must supply candidate facts and the expected
request and profile revisions. Direct proposal creation remains available.

Missing facts can be filled automatically with resume provenance. Existing
facts become pending comparisons. The review screen shows current and extracted
values and lets the user keep the current value or use the extracted value.
Replacing an existing ancestor, such as an array with a nested object, requires
an explicit confirmation. Accepted values receive user provenance.

The screen retains unsaved decisions after a failed save or refresh. Loading
new comparisons requires explicit reapply, which clears replacement consent and
drops decisions for fields already resolved. Stale proposals cannot be reviewed;
request another extraction. Requests can be cancelled, and failed or stale
requests can be retried. A retry creates a new request linked to the previous one.

## CLI and recovery

Use the native CLI with `--root` and `--native-lock` as in the launcher guide.
Request commands use the prefix `resume-extraction-request-` and suffixes
`create`, `get`, `list`, `cancel`, `fail`, `retry`, and `complete`. Proposal
commands use `resume-proposal-create`, `get`, `list`, and `review`.

Completion requires `--id`, `--input`, `--expected-request-revision`, and
`--expected-profile-revision`. If another pending proposal exists, completion
also requires its exact `--expected-pending-proposal-id`. Review requires
`--id`, `--input`, `--expected-revision`, and `--expected-profile-revision`.
The input contains `decisions` and, where needed, `replacementConfirmations`.
Candidate creation and completion accept up to 2 MiB on stdin to accommodate
JSON formatting and escapes; normalized candidates retain their 256 KiB limit.

All native domains share the Store lock and replay extraction recovery before
reading state. The extraction journal validates all destination documents
before writing them. Resume replacement closes open requests as stale together
with the new resume metadata, including recovery after an interrupted file
installation. Metadata-only resume edits preserve content-bound requests.

The focused extraction suites exercise domain contracts, HTTP/CLI integration,
review models and interrupted persistence. This fixture does not activate a
general Store writer, migrate live applicant data, or complete release acceptance.
