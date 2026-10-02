---
name: job-search
description: Find current jobs on LinkedIn, Hacker News, and Twitter/X using saved search preferences and related titles.
---

# Job Search

Return current job opportunities matching explicit criteria, with source links, relevant facts, and visible unknowns. Do not assign numerical suitability scores, normalize rankings across sources, or restrict queue selection with a score cutoff.
For first use or a handoff into the canonical job queue, read the shared [workflow map](../answer-memory/references/workflow-map.md).

## Criteria and source selection

Read [answer-memory](../answer-memory/SKILL.md) for root resolution and initialization. Use `node "<plugin-root>/apps/companion/command.mjs" store preferences-get` for saved criteria, including approved related `targetTitles` from Job Title Discovery. Read `store profile-inspect` for relevant current skills and work history. If managed resumes exist, use `store resume-list` and `store resume-facts-list` to identify the active default resume, or the sole active resume, with a latest current, confirmed fact version. Only then use `store resume-facts-get --resume-id <id>` privately for relevant skills, experience, and role history. Ignore draft, stale, older, and trashed resume facts. If several resumes could materially change the search and none is the default, ask which one to use. If no eligible facts exist, continue with current profile facts and disclose the narrower context. Never read raw resume files or reusable answers for job search.

Treat saved titles as starting queries, not verified qualifications or an exact-title requirement unless the owner explicitly asks for exact titles. Build a small related-role or capability query lane from demonstrated skills and experience. Search both lanes where the source permits within its stated inspection limit. Include a different-title role only when its observed responsibilities support the connection and no explicit requirement conflicts; explain the connection and any gap without inventing qualifications or changing seniority. Keep public search terms broad and non-identifying. Never send raw profile or resume facts, names, contact details, employer history, exact tenure, or saved answers to a site or research worker. On every search, read [model defaults](references/model-defaults.md) and inspect the current host's saved search model and Codex effort preference. A saved model cannot change the active task model, and a saved effort cannot change its active effort; direct research uses that task's model and effort.

Apply the current request over saved preferences. Missing saved preferences do not block a search when the request provides sufficient criteria. Ask only for missing information that materially determines the search, such as the target role if none is known. Do not require a separate setup invocation or persist transient overrides without a request to save them. A corrupt/unavailable Store is a storage error, not an empty preference set; report it without repairing or overwriting data.

Search the requested sources; otherwise use LinkedIn, HN, and X where available. Read the applicable sections of [source guidance](references/sources.md), including the host-specific browser route. The host agent owns research, private comparison to canonical facts, aggregation, and reporting. In Codex desktop, browser-bound research runs in the current top-level task or, when the owner explicitly requests a new task using the selected model, in one dedicated top-level local task under [model defaults](references/model-defaults.md). The dedicated task owns its browser and completes this skill without creating another task. When the host's delegation policy and browser surfaces actually permit source-specific workers, give each worker one source, only broad search terms and effective filters, and the [worker result contract](references/worker-results.md). Run workers concurrently only when their browser surfaces do not interfere. Otherwise research that source in the host and disclose the fallback. Companion does not launch tasks or workers. If one source fails or requires login, continue available sources and disclose the gap. The TypeScript Store CLI only previews and commits selected queue changes.

Apply explicit requirements as filters. Exclude known conflicts. Keep unknown salary, location eligibility, or other required facts visibly marked as **Unknown—verify**, rather than assuming a match or silently excluding the job. If the user explicitly requires a verified fact (for example, listed salary), exclude unknowns for that fact. Do not infer seniority, salary floors, remote-only status, or demographic criteria.

## Results and completion

Validate source status and evidence before using a listing, including any worker result. Default to newest first using observed posting dates, unless the user requests another transparent ordering. Put unknown dates last and preserve source order for ties. Deduplicate identical job URLs; combine cross-posts only when a shared application URL or other direct evidence establishes the same job, preserving every source link. A matching title and company alone do not establish identity. Connections, hiring managers, application method, and engagement are descriptive facts, never hidden ranking weights.

Show a readable table: role/company, date, location/work arrangement, listed compensation, relevant facts or unknowns, and source/application links. Include credible capability-lane roles even when their titles differ from saved titles. State the active filters, search lanes actually inspected, ordering, and each source's complete, partial, or unavailable status with inspected count, limit, and reason for any gap. No results is a valid outcome; explain which constraints or source gaps limited the search. Never present a bounded sample as exhaustive coverage.

Save a timestamped Markdown report to `~/.claude-job-searches/search-{timestamp}.md`, preserving the compatibility shape below without scores. This is a search report, not the canonical application queue. Include no applicant profile or saved-answer values.

```markdown
# Job Search Results — YYYY-MM-DD
## Search Parameters
- Order: newest first; unknown dates last
- Sources: sources actually searched
- Search lanes: saved-title and capability lanes actually inspected
- Source status: complete, partial, or unavailable for each requested source, with limits and reasons
## Results (newest first)
### 1. Role title — Company
- **Source**: source name
- **Discovery lane**: saved-title or capability
- **Posted**: observed date or Unknown
- **Location**: observed location and work arrangement or Unknown
- **Salary**: listed compensation or Unknown
- **URL**: exact job URL
- **Other source links**: exact cross-post URLs when identity was verified
```

Let the owner select any returned jobs for the queue. For selected results or an explicit request to import old reports, read [queue intake](references/queue.md). Preview the exact selected changes, obtain confirmation for that preview, and commit only those items through the canonical Store. Do not auto-select jobs by position or invent a minimum quality threshold. Report the helper's committed results and conflicts; search completion does not imply application submission.
