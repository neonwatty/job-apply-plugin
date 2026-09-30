---
name: saved-jobs
description: Retrieve and present the user's canonical saved jobs from the Job Apply Store without changing them.
---

# Saved Jobs

Read [answer-memory](../answer-memory/SKILL.md) for installed root resolution and the QA-route rule. Before listing, run `store paths` through the same command router and check whether its returned Store root directory exists. If it does not, report that there are no canonical records to retrieve; do not initialize the Store for a read request. When it exists, use the canonical TypeScript command router:

```bash
node "<plugin-root>/apps/companion/command.mjs" store job-list --status saved
```

This shows active canonical records whose status is `saved`; it excludes trashed records. Do not read Store files directly or substitute LinkedIn's Saved Jobs page, search reports, or the legacy Markdown queue. Treat corrupt or unavailable Store data as an error, never as an empty list. The command router may perform its normal activation for an existing Store; this skill makes no job mutation.

Present each record's role, company, location or work arrangement, source, URL, and last update when present. Mark absent fields as unknown, preserve the exact canonical job ID for follow-up, and state the number returned. Avoid printing descriptions, notes, provenance, resume references, or applicant data unless the owner specifically asks for a relevant field. If the user asks for another active status, use `job-list --status <status>` and label it accurately. Trash is not a status: only when explicitly requested, use `job-list --trashed-only` for trashed records or `job-list --include-trashed` for active and trashed records; add `--status saved` if the owner wants that status within the requested trash scope.

This skill only retrieves and presents records. It never searches sites, changes status, edits jobs, previews or commits queue imports, opens application forms, or launches a worker. For a selected application, hand the exact canonical ID to [Job Apply](../job-apply/SKILL.md); for a new opportunity search, use [Job Search](../job-search/SKILL.md).
