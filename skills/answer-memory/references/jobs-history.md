## Application history

Append minimal lifecycle events using `history-append --input <event.json>`. History may contain application metadata and `answerKeys`; it must never duplicate answer values, profile data, credentials, or browser state.

Use `reviewed` when Job Apply reaches final review. Do not record `completed` unless the user later confirms that they personally submitted the application. A policy receipt is separate and never changes legacy history semantics.

```bash
node "<plugin-root>/runtime/cli/native-jobs.js" history-list
```

## Canonical jobs

Use the job commands for durable records shared by people, the companion UX,
and agent workflows. New jobs begin in `saved`. Updates and lifecycle changes
require the current positive `revision`, so stale clients cannot silently replace
newer edits.

```bash
node "<plugin-root>/runtime/cli/native-jobs.js" job-create --input <job.json>
node "<plugin-root>/runtime/cli/native-jobs.js" job-list [--status <status>]
node "<plugin-root>/runtime/cli/native-jobs.js" job-get --id <job-id>
node "<plugin-root>/runtime/cli/native-jobs.js" job-preflight --id <job-id>
node "<plugin-root>/runtime/cli/native-jobs.js" job-update \
  --id <job-id> --expected-revision <revision> --input <patch.json>
node "<plugin-root>/runtime/cli/native-jobs.js" job-transition \
  --id <job-id> --status <status> --expected-revision <revision>
node "<plugin-root>/runtime/cli/native-jobs.js" job-trash \
  --id <job-id> --expected-revision <revision>
node "<plugin-root>/runtime/cli/native-jobs.js" job-restore \
  --id <job-id> --expected-revision <revision>
node "<plugin-root>/runtime/cli/native-jobs.js" job-delete \
  --id <job-id> --expected-revision <revision>
```

Only explicit user confirmation may transition a reviewed job to `applied`; pass
`--user-confirmed` only for that direct confirmation. A job must be in recoverable
trash before permanent deletion. Use `--include-trashed` only when the user wants
to inspect or restore trashed records. Run `job-preflight` before `ready`; the
transition fails if the profile is empty or no usable assigned/default resume file
exists. Missing role or company and a changed resume file are warnings, not hidden
assumptions.

## Resumable sessions

Use `session-save --id <application-id> --input <session.json>` only for non-canonical standalone workflows. Canonical jobs use the coordinator/attempt broker. New writes strip question, role, company, and URL copies and persist only step/status, opaque answer references, typed blockers, a current-attempt readiness proof, field-specific approvals, and closed browser-handoff state. They must never contain answer/profile/resume values, employer/role identity, credentials, codes, filenames, paths, digests, URLs, tab IDs, or browser state. Older v1 sessions remain readable and are normalized on their next successful coordinator write; corrupt/future documents remain untouched.

```bash
node "<plugin-root>/runtime/cli/native-jobs.js" session-list
node "<plugin-root>/runtime/cli/native-jobs.js" session-load --id <application-id>
node "<plugin-root>/runtime/cli/native-jobs.js" session-delete --id <application-id>
```

Delete a session after the user confirms submission or explicitly abandons it. History remains separate.
