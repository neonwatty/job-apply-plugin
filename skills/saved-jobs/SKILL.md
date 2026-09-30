---
name: saved-jobs
description: Retrieve and filter the user's canonical saved jobs without changing them or searching the web.
---

# Saved Jobs

Read [answer-memory](../answer-memory/SKILL.md) for safe plugin root and Store routing, including an approved QA route. Check whether the resolved Store root directory exists without opening Store files. If it is absent, report that there is no canonical saved-job list yet; do not invoke `job-list` or `init`. For an existing root, retrieve canonical job records through the packaged TypeScript CLI:

```bash
node "<plugin-root>/apps/companion/command.mjs" store job-list
```

Use `--status <status>` for an exact lifecycle status, and `--include-trashed` or `--trashed-only` only when the owner asks about trashed jobs. For company, role, location, source, or text filters, filter the returned records in memory; the CLI does not provide those selectors. State the filters applied and show the matching role, company, status, location, source, and job URL when present. A missing field is unknown, not a reason to invent a value. If there are no matches, say so and identify the active filters. Report Store errors as errors; never repair or replace data to answer a read request.

This skill issues only job-record reads. The standard command router may activate or migrate an existing Store on first use; if the owner requires zero disk writes, explain that limitation and stop before calling it. Never call job mutations, launch a browser search, write a report, or start an application. Timestamped `~/.claude-job-searches/search-*.md` reports are historical search output, not the canonical saved-job list. For new opportunities use [Job Search](../job-search/SKILL.md); for an application handoff use [Job Apply](../job-apply/SKILL.md), which obtains the owner's exact job choice and preserves manual final submission.
