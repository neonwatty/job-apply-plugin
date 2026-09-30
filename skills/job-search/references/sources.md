# Search sources

Read only the section for the requested source. Use visible, current results as evidence; URL patterns are hints to verify, not proof that a filter was applied.

## LinkedIn

Use the host-managed visible browser and its existing session. Search jobs with saved-title seeds and a small related-role or capability-led query set, plus the requested location, work arrangement, and date range; verify selected filters on the page. Inspect descriptions for transferable work even when a title differs. Do not impose an experience level that the user did not request. Inspect up to 25 distinct listings across both query lanes by default and report truncation.

Capture title, company, URL, posting date, location, work arrangement, listed compensation, and application method. Connections, hiring-manager links, and applicant counts are optional context when visible; they do not create a ranking. Avoid visiting a detail page twice for the same facts. Observe page readiness instead of fixed loading sleeps. Respect rate limits with a conservative request cadence/backoff.

If login is needed, leave authentication to the owner and continue any other requested sources that are available. Report the unavailable source.

## Hacker News

Find the current monthly “Ask HN: Who is hiring?” thread using host web search. Fall back to the previous month if necessary and label the date accurately. Read the thread and top-level comments via `https://hacker-news.firebaseio.com/v0/item/{id}.json`; use the official Firebase API rather than scraping HTML. Start with up to 50 comments, with conservative request pacing, and report this limit. Inspect those comments for both saved titles and relevant capabilities or related roles; a different title alone is not a reason to discard a posting. Never imply those comments exhaust the thread.

Interpret company, role, location, remote restrictions, compensation, description, and application URL from each posting. Respect the user's date range using comment timestamps. Do not substitute a seniority level or infer an unlisted salary. Report skipped/deleted comments or an unavailable thread without stopping other sources.

## Twitter/X

Use the host-managed visible browser. Search hiring phrases combined with saved-title seeds and a small capability or related-role query set and a `since:` date, use Latest when available, and verify results against the actual criteria. Include a remote constraint only when the user requested it. Inspect post and linked job details before treating a different-title role as relevant. Inspect up to 20 distinct posts across both query lanes by default and report truncation.

Capture post URL, author, date, role/company when stated, location/remote terms, compensation, and application link. Likes and reposts do not measure job suitability. If unavailable, rate-limited, or logged out, continue other requested sources and disclose the gap.

## Shared browser boundaries

Use the selected host browser throughout. Never handle credentials, authentication state, CAPTCHA, or MFA. Search does not authorize account creation or application actions. Skip failed pages with a concise explanation; do not invent missing facts or bypass rate limits.
