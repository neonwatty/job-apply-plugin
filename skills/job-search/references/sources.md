# Search sources

Read only the section for the requested source. Use visible, current results as evidence; URL patterns are hints to verify, not proof that a filter was applied.

## LinkedIn

Use the host-managed visible browser and its existing session. Search jobs using the requested titles, location, work arrangement, and date range; verify selected filters on the page. Do not impose an experience level that the user did not request. Inspect up to 25 listings by default and report truncation.

Capture title, company, URL, posting date, location, work arrangement, listed compensation, and application method. Connections, hiring-manager links, and applicant counts are optional context when visible; they do not create a ranking. Avoid visiting a detail page twice for the same facts. Observe page readiness instead of fixed loading sleeps. Respect rate limits with a conservative request cadence/backoff.

If login is needed, leave authentication to the owner and continue any other requested sources that are available. Report the unavailable source.

## Hacker News

Find the current monthly “Ask HN: Who is hiring?” thread using host web search. Fall back to the previous month if necessary and label the date accurately. Read the thread and top-level comments via `https://hacker-news.firebaseio.com/v0/item/{id}.json`; use the official Firebase API rather than scraping HTML. Start with up to 50 comments, with conservative request pacing, and report this limit. Never imply those comments exhaust the thread.

Interpret company, role, location, remote restrictions, compensation, description, and application URL from each posting. Respect the user's date range using comment timestamps. Do not substitute a seniority level or infer an unlisted salary. Report skipped/deleted comments or an unavailable thread without stopping other sources.

## Twitter/X

Use the host-managed visible browser. Search hiring phrases combined with the user's role criteria and a `since:` date, use Latest when available, and verify results against the actual criteria. Include a remote constraint only when the user requested it. Inspect up to 20 posts by default and report truncation.

Capture post URL, author, date, role/company when stated, location/remote terms, compensation, and application link. Likes and reposts do not measure job suitability. If unavailable, rate-limited, or logged out, continue other requested sources and disclose the gap.

## Shared browser boundaries

Use the selected host browser throughout. Never handle credentials, authentication state, CAPTCHA, or MFA. Search does not authorize account creation or application actions. Skip failed pages with a concise explanation; do not invent missing facts or bypass rate limits.
