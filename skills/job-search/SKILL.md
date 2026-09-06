---
name: job-search
description: Find jobs on LinkedIn, Hacker News, and Twitter/X using the user's criteria.
allowed-tools: Read, Write, Bash, WebSearch, WebFetch, mcp__claude-in-chrome__*
---

# Job Search

Return current job opportunities matching explicit criteria, with source links, relevant facts, and visible unknowns. Do not assign numerical suitability scores, normalize rankings across sources, or restrict queue selection with a score cutoff.

## Criteria and source selection

Read [answer-memory](../answer-memory/SKILL.md) for root resolution and initialization. Use `python3 "<plugin-root>/scripts/job-apply-store.py" preferences-get` for saved criteria. Read only relevant additional profile facts when needed.

Apply the current request over saved preferences. Missing saved preferences do not block a search when the request provides sufficient criteria. Ask only for missing information that materially determines the search, such as the target role if none is known. Do not require a separate setup invocation or persist transient overrides without a request to save them. A corrupt/unavailable Store is a storage error, not an empty preference set; report it without repairing or overwriting data.

Search the requested sources; otherwise use LinkedIn, HN, and X where available. Read the applicable sections of [source guidance](references/sources.md). If one source fails or requires login, continue available sources and disclose what was skipped.

Apply explicit requirements as filters. Exclude known conflicts. Keep unknown salary, location eligibility, or other required facts visibly marked as **Unknown—verify**, rather than assuming a match or silently excluding the job. If the user explicitly requires a verified fact (for example, listed salary), exclude unknowns for that fact. Do not infer seniority, salary floors, remote-only status, or demographic criteria.

## Results and completion

Default to newest first using observed posting dates, unless the user requests another transparent ordering. Put unknown dates last and preserve source order for ties. Deduplicate identical job URLs; combine cross-posts only when their job identity is established, preserving source links. Connections, hiring managers, application method, and engagement are descriptive facts, never hidden ranking weights.

Show a readable table: role/company, date, location/work arrangement, listed compensation, relevant facts or unknowns, and source/application links. State the active filters, ordering, searched sources, unavailable sources, and result limits. No results is a valid outcome; explain which constraints or source gaps limited the search.

Save a timestamped Markdown report to `~/.claude-job-searches/search-{timestamp}.md`, preserving the compatibility shape below without scores. This is a search report, not the canonical application queue. Include no applicant profile or saved-answer values.

```markdown
# Job Search Results — YYYY-MM-DD
## Search Parameters
- Order: newest first; unknown dates last
- Sources: sources actually searched
## Results (newest first)
### 1. Role title — Company
- **Source**: source name
- **Posted**: observed date or Unknown
- **Location**: observed location and work arrangement or Unknown
- **Salary**: listed compensation or Unknown
- **URL**: exact job URL
```

Let the owner select any returned jobs for the queue. For selected results or an explicit request to import old reports, read [queue intake](references/queue.md). Preview the exact selected changes, obtain confirmation for that preview, and commit only those items through the canonical Store. Do not auto-select jobs by position or invent a minimum quality threshold. Report the helper's committed results and conflicts; search completion does not imply application submission.
