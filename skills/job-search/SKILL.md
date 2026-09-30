---
name: job-search
description: Find jobs on LinkedIn, Hacker News, and Twitter/X using the user's criteria.
allowed-tools: Read, Write, Bash, WebSearch, WebFetch, mcp__claude-in-chrome__*
---

# Job Search

Return current job opportunities matching explicit criteria, with source links, relevant facts, and visible unknowns. Do not assign numerical suitability scores, normalize rankings across sources, or restrict queue selection with a score cutoff.
For first use or a handoff into the canonical job queue, read the shared [workflow map](../answer-memory/references/workflow-map.md).

## Criteria and source selection

Read [answer-memory](../answer-memory/SKILL.md) for root resolution and initialization. Use `node "<plugin-root>/apps/companion/command.mjs" store preferences-get` for saved criteria. Read only relevant additional profile facts when needed.

Apply the current request over saved preferences. Missing saved preferences do not block a search when the request provides sufficient criteria. Ask only for missing information that materially determines the search, such as the target role if none is known. Do not require a separate setup invocation or persist transient overrides without a request to save them. A corrupt/unavailable Store is a storage error, not an empty preference set; report it without repairing or overwriting data.

Search the requested sources; otherwise use LinkedIn, HN, and X where available. Read the applicable sections of [source guidance](references/sources.md) and the [worker result contract](references/worker-results.md). The host agent assigns one source-specific research worker per requested source, passing only the effective search criteria and that source's guidance. Use the host's agent delegation facility; Companion does not launch workers. Run workers concurrently when their browser surfaces do not interfere, otherwise run them in sequence. The host owns aggregation, filtering, reporting, and any later Store preview or commit. If delegation is unavailable, perform the same source-specific work in the host and disclose that fallback. If one source fails or requires login, continue available sources and disclose the gap.

When supported, read the `searchModel` key returned by `preferences-get` (the canonical `profile.preferences.searchModel` value) as the worker model preference. Until then, use the host's normal worker model. A request-only model choice takes precedence for this search when the host supports it. Never write a model setting from this skill or require one to search; [Job Preferences](../job-preferences/SKILL.md) owns saved preference changes.

Apply explicit requirements as filters. Exclude known conflicts. Keep unknown salary, location eligibility, or other required facts visibly marked as **Unknown—verify**, rather than assuming a match or silently excluding the job. If the user explicitly requires a verified fact (for example, listed salary), exclude unknowns for that fact. Do not infer seniority, salary floors, remote-only status, or demographic criteria.

## Results and completion

Validate each worker's source status and evidence before using its listings. Default to newest first using observed posting dates, unless the user requests another transparent ordering. Put unknown dates last and preserve source order for ties. Deduplicate identical job URLs; combine cross-posts only when their job identity is established, preserving every source link. Connections, hiring managers, application method, and engagement are descriptive facts, never hidden ranking weights.

Show a readable table: role/company, date, location/work arrangement, listed compensation, relevant facts or unknowns, and source/application links. State the active filters, ordering, each source's complete/partial/unavailable status, inspected count and result limit. No results is a valid outcome; explain which constraints or source gaps limited the search. Never present a partial source as exhaustively searched.

Save a timestamped Markdown report to `~/.claude-job-searches/search-{timestamp}.md`, preserving the compatibility shape below without scores. This is a search report, not the canonical application queue. Include no applicant profile or saved-answer values.

```markdown
# Job Search Results — YYYY-MM-DD
## Search Parameters
- Order: newest first; unknown dates last
- Sources: sources actually searched
- Source status: complete, partial, or unavailable for every requested source, with limits and reasons
## Results (newest first)
### 1. Role title — Company
- **Source**: source name
- **Posted**: observed date or Unknown
- **Location**: observed location and work arrangement or Unknown
- **Salary**: listed compensation or Unknown
- **URL**: exact job URL
- **Other source links**: exact cross-post URLs, if identity was verified
```

Let the owner select any returned jobs for the queue. For selected results or an explicit request to import old reports, read [queue intake](references/queue.md). Preview the exact selected changes, obtain confirmation for that preview, and commit only those items through the canonical Store. Do not auto-select jobs by position or invent a minimum quality threshold. Report the helper's committed results and conflicts; search completion does not imply application submission.
