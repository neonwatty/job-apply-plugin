---
name: hidden-jobs
description: Hunt the hidden job market — roles on niche boards, small-company ATS pages, and LinkedIn/Twitter/Reddit posts where a hiring manager drops a direct email for resumes. Scores results to reward direct-contact, low-competition roles and drafts personalized outreach. Use when the user wants hidden, unadvertised, or direct-to-hiring-manager roles, or wants to skip the saturated public listings.
allowed-tools: Read, Write, Bash, WebSearch, WebFetch, mcp__claude-in-chrome__*, mcp__plugin_playwright_playwright__*
---

# Hidden Job Hunt

Finds roles the saturated public listings miss:

- **ATS board APIs** — small companies' Greenhouse / Lever / Ashby boards (public JSON, no auth)
- **Niche aggregators** — RemoteOK, Remotive, WeWorkRemotely (remote-first, startup-heavy)
- **Direct-contact posts** — LinkedIn / Twitter-X / Reddit posts where a hiring manager writes "send your resume to <email>" or "DM me"
- **Small-company careers pages** — direct, for a user-supplied target list

It scores results to **reward a direct line to a human** (an email or named hiring manager beats an ATS black hole), dedups across channels, and drafts a personalized outreach email for every direct-contact role.

---

## Phase 1: Load Preferences & Parse Overrides

### Step 1: Load Profile

Read `~/.claude-job-profile.json`. Check for `preferences`.

**If no preferences found**, say:

> No preferences found. Run `/job-preferences` first to set target titles and filters.

Then **STOP**.

**If preferences exist**, load `targetTitles`, `remotePreference`, `excludePatterns`, `defaultTimeRange`, `keywords`, `needsRemoteOrVisa`, `basedIn`, and `atsCompanyTokens`. Also load top-level `name`, `email`, `links`, `topSkills`, `headline` — these feed the outreach drafts in Phase 6.

### Step 2: Parse Overrides

The user may pass, when invoking:

- **Channels**: `ats`, `aggregators`, `social`, `careers` (or combinations). Default: all.
- **Time range**: `last week`, `2 weeks`, `month` → overrides `defaultTimeRange`.
- **Companies**: a list of company names → triggers ATS-token discovery + careers-page channel.
- **Keywords**: extra search terms.

Display the active config before proceeding (titles, remote, exclude, time range, channels).

---

## Phase 2: ATS Board APIs (Bash — `scripts/hunt.py`)

Most startups host roles on **public, auth-free** ATS JSON endpoints. The fetcher hits them and normalizes the output.

### Seed company tokens

`hunt.py` reads `preferences.atsCompanyTokens` from the profile:

```json
"atsCompanyTokens": {
  "greenhouse": ["companytoken1", "companytoken2"],
  "lever": ["companytoken3"],
  "ashby": ["companytoken4"]
}
```

A company's **token** is the slug in its board URL:

| Provider | Board URL | API endpoint | Token |
|----------|-----------|--------------|-------|
| Greenhouse | `boards.greenhouse.io/{token}` | `boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` | `{token}` |
| Lever | `jobs.lever.co/{token}` | `api.lever.co/v0/postings/{token}?mode=json` | `{token}` |
| Ashby | `jobs.ashbyhq.com/{token}` | `api.ashbyhq.com/posting-api/job-board/{token}` | `{token}` |

**To grow the token list** for the user's targets:
1. If the user named companies, `WebSearch` `"{company} greenhouse OR lever OR ashby careers"` and read the board URL to extract the token, then add it to `atsCompanyTokens` (Write back to profile).
2. For startup breadth, seed from public YC / startup lists the user provides.
3. If a company uses a different ATS (Workable, SmartRecruiters, Rippling), fetch its `/careers` page directly in Phase 5 instead.

### Run the fetcher

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/hidden-jobs/scripts/hunt.py" --channels ats,aggregators --since-days {N}
```

(Use the absolute path to this skill's `scripts/hunt.py`.) It prints JSON: `{jobs, errors, counts, total, with_email}`. Each job: `source, company, title, location, remote, salary, url, email, posted, description`. The fetcher already extracts any email embedded in a job description and dedups.

---

## Phase 3: Niche Aggregators (same fetcher)

The `aggregators` channel (included in the call above) pulls:

- **RemoteOK** — `remoteok.com/api`
- **Remotive** — `remotive.com/api/remote-jobs`
- **WeWorkRemotely** — programming-jobs RSS

All remote-first, startup-heavy — strong for an international / remote-needed candidate. No auth.

---

## Phase 4: Direct-Contact Posts (the core "hidden" channel)

Posts where a hiring manager gives a **direct email or DM** for resumes. This is where competition is lowest.

### 4a: LinkedIn post search (Chrome MCP)

1. `tabs_context_mcp` → `tabs_create_mcp`, navigate to LinkedIn.
2. Verify logged in via `read_page`; if not, ask the user to log in and **wait**.
3. Search **content/posts** (not the jobs tab). Navigate to:
   `https://www.linkedin.com/search/results/content/?keywords={query}&datePosted=%22past-week%22` (or `past-month`).
   Build `{query}` from hiring intent + titles, e.g.:
   `("we're hiring" OR "now hiring" OR "looking for") ("backend" OR "full stack" OR "software engineer") ("send your resume" OR "send your CV" OR "DM me" OR "email me")`
4. `read_page` the feed; for each post extract: author name, author title, author profile URL, post text, post URL.
5. **Extract email** from post text with regex `[\w.+-]+@[\w.-]+\.\w{2,}`. Capture "DM" intent if no email.
6. 2-3s delays. Max ~25 posts.

### 4b: Twitter/X post search (Chrome MCP)

1. If logged in, navigate to `x.com/search` with:
   `("hiring" OR "we're hiring") ("backend" OR "software engineer" OR "ML engineer") ("send" OR "DM" OR "email") ("resume" OR "CV") since:YYYY-MM-DD -is:reply`
2. Switch to **Latest**. Extract tweet text, author handle, URL, engagement.
3. Extract email via the same regex. If none, note the handle for a DM.
4. Skip gracefully if not logged in or rate-limited.

### 4c: Reddit hiring threads (WebFetch)

Reddit blocks datacenter IPs, so do **not** use the Bash fetcher for Reddit — use `WebFetch` (different egress):

1. `WebFetch` `https://www.reddit.com/r/forhire/search.json?q=hiring&restrict_sr=1&sort=new&limit=50` and likewise for `r/remotejs`, `r/hiring`.
2. If WebFetch is also blocked, fall back to Chrome MCP on `old.reddit.com/r/forhire/`.
3. Keep only `[Hiring]` posts. Extract title, body, permalink, and email via regex.

For every direct-contact hit, store `email` (or `dmHandle`) — these score highest.

---

## Phase 5: Small-Company Careers Pages (optional, user supplies companies)

For each company the user named that wasn't resolved to an ATS token in Phase 2:

1. `WebSearch` `"{company} careers"` → find the careers URL.
2. `WebFetch` the careers page; extract role titles, locations, and any apply email.
3. If it's an ATS board, capture the token and prefer the API (Phase 2) next time.

---

## Phase 6: Normalize, Filter, Score

### Filter against preferences

Drop any role that:
- Matches an `excludePatterns` term in the title (e.g. `principal`, `staff`, `director`).
- Doesn't fuzzy-match a `targetTitle` or `keyword`.
- Violates `remotePreference` (if "remote only", keep only remote — critical when `needsRemoteOrVisa` is true).

### Scoring rubric (reward direct contact + low competition)

| Category | Points | Notes |
|----------|--------|-------|
| **Direct email present** | **+30** | the whole point — a line to a human |
| **Named hiring manager (social)** | +15 | author of a hiring post |
| Title match (exact vs partial) | 0-20 | |
| Remote / location-fit | 0-15 | weight up when `needsRemoteOrVisa` |
| Visa / sponsorship mentioned | +10 | when relevant to the user |
| Small company / non-FAANG | +10 | hidden-market bonus |
| Recency | 0-5 | newer = higher |
| Low-competition signal | 0-5 | few applicants / niche board |

Sum, cap at 100. A role from a niche board with the hiring manager's email and a title match should land 80+.

### Dedup

Already deduped within the Bash fetcher; when merging social + careers results, dedup again on `(company, title)` and on `email`.

---

## Phase 7: Output

### 1. Terminal — ranked table

```
============================================================
  Hidden Job Hunt — Results
============================================================
  Titles: Backend Engineer, Full Stack Engineer, ML Engineer
  Filters: Remote only | Last month
  Channels: ATS (12), Aggregators (40), Social (7), Careers (3)
  Total: 62 after filter | 9 with direct contact
============================================================

Score | Source         | Title                   | Company     | Contact            | Remote
----- | -------------- | ----------------------- | ----------- | ------------------ | ------
  91  | linkedin-post  | Backend Engineer        | Nimbus AI   | jane@nimbus.ai     | Yes
  86  | remoteok       | Full Stack Engineer     | Pier        | apply link         | Yes
  84  | greenhouse     | Software Engineer       | Loopwork    | careers form       | Yes
  ...
============================================================
  9 direct-contact roles → outreach drafts below
  Saved to: ~/.claude-job-searches/hidden-{timestamp}.md
============================================================
```

### 2. Markdown file — `~/.claude-job-searches/hidden-{timestamp}.md`

For each role: score, source, company, title, location/remote, salary, URL, **contact (email or DM handle)**, description snippet. Create the directory if missing.

### 3. Outreach drafts (direct-contact roles only)

For every role with an `email` or `dmHandle`, draft a short, personalized message using the profile (`name`, `email`, `links`, `topSkills`, `headline`) and the role's text. Keep it ~120 words, specific to the role, with the user's relevant experience and links. Save under an `## Outreach Drafts` section in the same MD file. **Never send** — hand the drafts to the user to review and send themselves.

Template:

```
Subject: {Role} — {User Name}

Hi {Hiring Manager / there},

Saw your post about {role} at {company}. I'm a {headline} — recently {one
relevant line from experience matching the role's stack}.

A few things that map to what you described:
- {relevant skill/project 1}
- {relevant skill/project 2}

Resume: {link} · GitHub: {github} · Portfolio: {portfolio}
Open to {remote / the role's arrangement}. Would love to talk.

{User Name}
{email}
```

### 4. Queue append (optional, user confirms)

If any roles scored 70+, ask before appending to `~/Desktop/jobs/application_queue.md` under `## Hidden-Market`. **Never modify it without confirmation.**

---

## Safety Rules

1. **Never enter credentials** — if a login is needed, stop and ask the user to log in.
2. **Never send outreach or click Apply** — this skill discovers and drafts only. The user sends.
3. **Never create accounts.**
4. **Respect rate limits** — 2-3s between LinkedIn/Twitter interactions; the Bash fetcher already paces API calls.
5. **Reddit**: never hit it from the Bash fetcher (datacenter IPs are blocked). Use WebFetch or Chrome MCP.
6. **Graceful degradation** — if a channel fails, skip it and report which channels succeeded/failed.
7. **Email handling** — only extract emails the poster published publicly for applications. Never scrape private contact info or guess addresses.
8. **Never modify `application_queue.md` without explicit confirmation.**

---

## Example Invocations

```
/hidden-jobs                          # all channels, default time range
/hidden-jobs social                   # only direct-contact posts (LinkedIn/X/Reddit)
/hidden-jobs ats aggregators 2 weeks  # boards only, last 2 weeks
/hidden-jobs companies: Linear, Resend, Supabase   # discover their ATS + careers pages
```
