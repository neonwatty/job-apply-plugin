---
name: job-search
description: Search LinkedIn, Hacker News, and Twitter/X for jobs with connections, hiring manager insights, and preference-based scoring. Use when the user wants to find jobs, search for positions, or explore job opportunities.
allowed-tools: Read, Write, Bash, WebSearch, WebFetch, mcp__claude-in-chrome__*
---

# Multi-Source Job Search

A Codex and Claude Code skill for searching jobs across LinkedIn, Hacker News Who's Hiring, and Twitter/X. Scores and ranks results against your saved preferences, highlights network advantages, and saves structured output.

---

## Phase 1: Load Preferences & Parse Overrides

### Step 1: Load Profile

Follow the bundled `answer-memory` skill (`$job-apply:answer-memory` in Codex; `/job-apply:answer-memory` in Claude Code). Resolve `<plugin-root>` as that skill directs, run `python3 "<plugin-root>/scripts/job-apply-store.py" init`, load preferences with `preferences-get`, and load location or other profile facts with `profile-get`. Never read or write persistent Job Apply files directly.

**If no preferences found**, say:

> No search preferences found. Invoke the bundled `job-preferences` skill first to set your target titles, salary range, and filters.

Then **STOP**. Do not prompt the user to set preferences inline.

**If preferences exist**, load them:

```json
{
  "targetTitles": ["Staff AI Engineer", "Principal ML Engineer"],
  "minBaseSalary": "$250K",
  "remotePreference": "remote only",
  "excludePatterns": ["junior", "associate", "intern", "entry level"],
  "defaultTimeRange": "last week"
}
```

### Step 2: Parse User Overrides

The user may pass overrides when invoking the skill:

- **Time range**: `last week`, `2 weeks`, `month` — overrides `defaultTimeRange`
- **Source filter**: `linkedin`, `hn`, `twitter`, or any combination — limits which sources to query (default: all three)
- **Keywords**: any additional keywords to use alongside `targetTitles`

Display the active search config before proceeding:

> **Search config:**
> - Titles: Staff AI Engineer, Principal ML Engineer
> - Salary floor: $250K
> - Remote: Remote only
> - Exclude: junior, associate, intern, entry level
> - Time range: last week
> - Sources: LinkedIn, HN, Twitter

---

## Phase 2a: LinkedIn Search (visible host browser)

### Navigation

1. Use the host-managed visible browser (Codex Browser plugin or Claude in Chrome) and reuse an appropriate existing tab or create a new one
2. Keep that browser/tab binding for the search instead of switching automation surfaces
3. Navigate to `https://www.linkedin.com/jobs/`
4. Verify the user is logged in from visible page state. If not logged in, say: "Please log into LinkedIn in this browser tab, then let me know when you're ready." and **wait**.

### Build Search URL

Base URL: `https://www.linkedin.com/jobs/search/`

| Parameter | Purpose | Values |
|-----------|---------|--------|
| `keywords` | Search terms | URL-encoded from targetTitles |
| `location` | Geographic area | From profile location |
| `f_WT` | Work type | `1` (on-site), `2` (hybrid), `3` (remote) |
| `f_TPR` | Time posted | `r604800` (week), `r1209600` (2 weeks), `r2592000` (month) |
| `f_E` | Experience level | `4` (mid-senior), `5` (director), `6` (executive) |
| `f_JIYN` | In your network | `true` |
| `sortBy` | Sort order | `DD` (date) |

Map `remotePreference`:
- "remote only" → `f_WT=3`
- "remote preferred" → `f_WT=2,3`
- "open to hybrid" → `f_WT=2,3`
- "open to all" → omit `f_WT`

Map time range:
- "last week" → `f_TPR=r604800`
- "2 weeks" → `f_TPR=r1209600`
- "month" → `f_TPR=r2592000`

### Extract Job Listings (max 25)

For each job card:

1. Read visible job cards from the results list with the host browser
2. Click into a job detail page through the same visible browser surface
3. Wait 2-3 seconds for detail page to load
4. Extract: title, company, location, posted date, applicant count, work type, apply method
5. Look for visible connection indicators such as "connections work here" or "connections at"
6. Look for "Meet the hiring team" or "hiring manager"
7. If hiring manager found, extract name, title, profile URL
8. Store result, navigate back to results list
9. **2-3 second delay** between each job

### Scrolling for More Results

LinkedIn uses infinite scroll:
1. Scroll the results list through the host-managed browser
2. Wait 2-3 seconds for new results
3. Read the newly loaded visible cards
4. Repeat until desired count or no more results

---

## Phase 2b: Hacker News Who's Hiring (shell + host web search)

### Find Current Thread

1. Use the host's supported web-search tool to search for: `"Ask HN: Who is hiring?" site:news.ycombinator.com {current_month} {current_year}`
2. Extract the thread ID from the HN URL in the search results (e.g., `https://news.ycombinator.com/item?id=XXXXXXXX` → `XXXXXXXX`)

If no thread found for the current month, try the previous month. If still nothing, skip HN and report it.

### Fetch Comments via Firebase API

3. Fetch the thread: `curl -s "https://hacker-news.firebaseio.com/v0/item/{THREAD_ID}.json"`
4. Parse the `kids` array — these are top-level comment IDs (job postings)
5. Fetch each comment (up to 50): `curl -s "https://hacker-news.firebaseio.com/v0/item/{COMMENT_ID}.json"`
6. **0.5 second delay** between API calls

### Parse Comments

HN Who's Hiring comments typically follow this format in the `text` field:

```
Company Name | Role Title | Location | Remote | Salary Range
Description text...
Apply: URL
```

For each comment:
- Extract company, title, location, remote status, salary from the first line (pipe-delimited)
- Extract application URL if present (look for "apply" or "http" links)
- Parse salary range if present (look for patterns like `$XXXk-$XXXk`, `$XXX,XXX`)
- Extract the full text as description

### Filter Against Preferences

Skip comments that:
- Don't match any `targetTitles` (fuzzy match — "AI Engineer" matches "Staff AI Engineer")
- Match any `excludePatterns`
- Don't meet `remotePreference` (if "remote only", skip non-remote postings)
- Fall below `minBaseSalary` (if salary is listed)

---

## Phase 2c: Twitter/X Search (visible host browser)

### Navigation

1. Use the existing host-managed browser context (or create a new tab in that browser)
2. Navigate to `https://x.com/search`
3. Verify login from visible page state by checking for a profile avatar or compose button. If not logged in, **skip Twitter entirely** and continue with other sources. Report: "Skipped Twitter — not logged in."

### Build Search Query

Construct a Twitter advanced search query:

```
("hiring" OR "open role" OR "we're hiring" OR "join our team") ("AI engineer" OR "ML engineer" OR "{title1}" OR "{title2}") ("remote") since:YYYY-MM-DD -is:reply
```

Map time range to `since:` date:
- "last week" → 7 days ago
- "2 weeks" → 14 days ago
- "month" → 30 days ago

### Execute Search

4. Navigate to the search URL with the query
5. Wait for results to load (3 seconds)
6. Switch to "Latest" tab if available
7. Extract tweet content, author handle, engagement (likes/retweets), and any URLs (max 20 tweets)
8. **2-3 second delays** between interactions

### Filter Against Preferences

Apply the same filtering as HN — title match, exclude patterns, remote, salary if mentioned.

### Graceful Failure

If Twitter is inaccessible, rate-limited, or not logged in — skip entirely and continue. Report which sources succeeded and failed at the end.

---

## Phase 3: LinkedIn Detail Extraction

For LinkedIn results that passed initial filtering, extract additional network signals:

1. Connection count and names (1st-degree, 2nd-degree, alumni)
2. Hiring manager name, title, profile URL
3. Easy Apply availability
4. Applicant count and posting age

This data feeds into the scoring in Phase 4.

---

## Phase 4: Cross-Source Scoring

Score every result on a 0-100 normalized scale.

### Scoring Rubric

| Category | Points | Applies to |
|----------|--------|-----------|
| Title match (exact vs partial) | 0-20 | All sources |
| Salary meets/exceeds floor | 0-10 | All sources |
| Remote preference match | 0-10 | All sources |
| Recency (newer = higher) | 0-5 | All sources |
| Low competition (<50 applicants) | 0-5 | All sources |
| Hiring manager listed | 20 | LinkedIn only |
| 1st-degree connections | 15 | LinkedIn only |
| 2nd-degree or alumni connections | 10 | LinkedIn only |
| Easy Apply available | 5 | LinkedIn only |
| Salary explicitly listed | 10 | HN only |
| Application URL provided | 10 | HN only |
| High engagement (50+ likes) | 10 | Twitter only |

### Normalization

Max possible per source: LinkedIn 100, HN 80, Twitter 70.

Normalize all scores to 0-100:
- LinkedIn score: `raw_score`
- HN score: `raw_score * (100 / 80)`
- Twitter score: `raw_score * (100 / 70)`

Round to nearest integer. Sort all results by normalized score descending.

---

## Phase 5: Output

### 1. Terminal Display

```
============================================================
  Multi-Source Job Search Results
============================================================
  Titles: Staff AI Engineer, Principal ML Engineer
  Filters: Remote only | Last week | Salary >= $250K
  Sources: LinkedIn (12), HN (8), Twitter (5)
  Total: 25 results | Showing top 25 by score
============================================================

Score | Source   | Title                        | Company       | Salary   | Location        | Signals
----- | -------- | ---------------------------- | ------------- | -------- | --------------- | --------------------------
  92  | LinkedIn | Staff AI Engineer            | Acme Corp     | $280K    | Remote          | Hiring mgr, 2 connections
  87  | LinkedIn | Principal ML Engineer        | TechStart     | $300K    | SF (Remote OK)  | 5 connections, Easy Apply
  81  | HN       | AI Engineer (Staff)          | CoolStartup   | $250-300K| Remote          | Salary listed, Apply URL
  76  | Twitter  | Head of AI                   | DataCo        | —        | Remote          | 120 likes
  ...

============================================================
  Summary
  - 4 with hiring managers | 8 with connections
  - 3 sources queried | 0 failed
  - Saved to: ~/.claude-job-searches/search-2026-02-28T14-30-00.md
============================================================
```

### 2. Markdown File

Save full details to `~/.claude-job-searches/search-{timestamp}.md`:

```markdown
# Job Search Results — 2026-02-28

## Search Parameters
- Titles: Staff AI Engineer, Principal ML Engineer
- Salary floor: $250K
- Remote: Remote only
- Time range: Last week
- Sources: LinkedIn, HN, Twitter

## Results (ranked by score)

### 1. Staff AI Engineer — Acme Corp (Score: 92)
- **Source**: LinkedIn
- **Location**: Remote
- **Salary**: $280K
- **Posted**: 2 days ago | 45 applicants
- **Hiring Manager**: Jane Smith (Engineering Manager) — linkedin.com/in/janesmith
- **Connections**: 2 (John Doe, Sarah Lee)
- **Apply**: Easy Apply
- **URL**: https://linkedin.com/jobs/view/123456

### 2. AI Engineer (Staff) — CoolStartup (Score: 81)
- **Source**: Hacker News
- **Location**: Remote
- **Salary**: $250-300K
- **Description**: Building next-gen AI infrastructure...
- **Apply**: https://coolstartup.com/careers/ai-engineer

...
```

Create the `~/.claude-job-searches/` directory if it doesn't exist.

### 3. Queue Append (Optional, User Confirms)

If any results scored 70+, ask the user:

> **{N} jobs scored 70+.** Would you like me to add them to your application queue at `~/Desktop/jobs/application_queue.md`?

If confirmed, append to `application_queue.md` under a new "## Tier 3 — Auto-Discovered" section:

```markdown
## Tier 3 — Auto-Discovered

| Score | Source | Role | Company | URL | Status |
|-------|--------|------|---------|-----|--------|
| 92 | LinkedIn | Staff AI Engineer | Acme Corp | [link](https://...) | New |
| 81 | HN | AI Engineer (Staff) | CoolStartup | [link](https://...) | New |
```

**Never modify application_queue.md without explicit user confirmation.**

---

## Safety Rules

1. **Never handle credentials** — pause for the user to complete login, password, CAPTCHA, or MFA steps manually
2. **Never click Apply** — this skill is for searching only, not applying
3. **Never create accounts** — stop and inform user if account creation is required
4. **Respect rate limits per source**:
   - LinkedIn: 2-3 second delays between page loads
   - HN Firebase API: 0.5 second delays between requests
   - Twitter: 2-3 second delays between interactions
5. **Max results per source**: LinkedIn 25, HN 50 comments, Twitter 20 tweets
6. **Graceful degradation** — if any source fails, skip it and continue with the others. Report which sources succeeded and which failed at the end.
7. **Never modify application_queue.md without user confirmation**
8. **HN Firebase API only** — never scrape the Hacker News website directly. Always use `https://hacker-news.firebaseio.com/v0/` endpoints.
9. **Handle errors gracefully** — if a job page fails to load, skip and continue

---

## Example Invocations

**Standard search (all sources):**
```
User: $job-apply:job-search (Codex) or /job-apply:job-search (Claude Code)
Agent: [Loads preferences, searches LinkedIn + HN + Twitter, displays ranked results]
```

**With time range override:**
```
User: Invoke job-search with "2 weeks"
Agent: [Uses 2-week time range instead of default]
```

**Single source:**
```
User: Invoke job-search with "hn"
Agent: [Searches only Hacker News Who's Hiring]
```

**Multiple source filter:**
```
User: Invoke job-search with "linkedin hn"
Agent: [Searches LinkedIn and HN, skips Twitter]
```

**With extra keywords:**
```
User: Invoke job-search with "agentic systems"
Agent: [Adds "agentic systems" to title-based keywords]
```
