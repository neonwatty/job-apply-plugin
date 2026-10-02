# Search sources

Read only the sections for requested sources. Use current, visible results as evidence. Search URLs and snippets are navigation hints, not proof that a filter applied or a job remains open. Keep queries to role words and public location or work-arrangement terms; never paste resume text, private profile facts, or saved answers into a site.

## Host browser route

- **Codex:** Use its selected, visible Browser plugin surface (the in-app browser or the user's selected Chrome tab) in the current top-level task or an owner-requested dedicated top-level task. Keep navigation on that surface and inspect its current page state before acting. A generic web search can locate public pages, but it does not substitute for checking LinkedIn or X filters and detail pages in the selected browser.
- **Claude Code:** Use Claude in Chrome and the owner's existing visible session for LinkedIn and X. Do not create an independent headless session to bypass login or visibility. Host web search and fetch tools may locate public HN threads and call the HN API.
- For either host, if the required browser tool or site session is unavailable, report that source as unavailable and continue the others. Leave sign-in, CAPTCHA, and MFA to the owner. A delegated source worker must have permitted access to its required visible browser; otherwise a top-level task researches that source. Companion never starts tasks or workers.

## LinkedIn

Open LinkedIn Jobs in the selected browser. Search one saved or explicitly requested title at a time, combining close spelling variants only when the result set remains clear. Run a small related-role or capability lane from demonstrated skills and experience unless the owner required exact titles. Enter the requested location, then apply work arrangement and date filters in the page UI. Inspect the displayed filter chips or controls after every change; a URL parameter alone is insufficient. Do not set experience level, salary, or remote-only filters unless requested. Cover each useful title family and disclose any title or lane you did not run.

Inspect up to 25 distinct listings across both lanes by default, opening a detail page when needed to verify responsibilities or required facts. Capture the exact listing URL, title, company, observed posting date, location, work arrangement, listed compensation, and application method. Mark missing fields unknown. Connections, hiring-manager links, and applicant counts are optional visible context, not ranking weights. Avoid revisiting the same detail page. Wait for page readiness, respect rate limits, and back off rather than bypassing a challenge.

## Hacker News

Use host web search to find the current month's “Ask HN: Who is hiring?” thread on `news.ycombinator.com`; if it is absent, use the previous month's thread and label its month. Verify the thread title, date, and item ID on the actual page. Fetch the thread and its top-level comment IDs through the official `https://hacker-news.firebaseio.com/v0/item/{id}.json` endpoint; do not scrape rendered HTML or mistake nested replies for employer posts. Start with up to 50 top-level comments, pace requests conservatively, and disclose both the cap and any skipped, deleted, or unavailable comments.

Interpret company, role, location, remote restrictions, compensation, description, and application URL from each posting. Inspect saved-title and relevant capability matches within the same comment limit; a different title alone is not grounds to discard a posting. Use comment timestamps to enforce the user's date range. Keep an exact HN comment link alongside an external application URL when provided. Do not infer an unlisted salary or seniority. An unavailable thread does not stop other requested sources.

## Twitter/X

Open X search in the selected browser. Combine a requested title or close role phrase with hiring terms and a `since:YYYY-MM-DD` operator based on the requested range; use the Latest tab when available. Run a small related-role or capability query lane when relevant, and report which title families and lanes were searched. Inspect visible posts and their dates to verify the query, date range, and whether the post is actually a job opportunity. Add remote terms only when the owner requested them.

Inspect up to 20 distinct posts across both lanes by default and disclose truncation. Capture the post URL, author, observed date, role and company only when stated, location or remote terms, listed compensation, and exact application link. A repost or discussion about hiring is not automatically an open job. Likes and reposts do not measure suitability. If X is unavailable, rate-limited, or logged out, disclose the gap and continue other sources.

## Shared boundaries

Search does not authorize account creation, applying, messaging, or changing the canonical queue. Skip failed pages with a concise explanation; do not invent missing facts or bypass rate limits. Once the owner selects exact results, [queue intake](queue.md) governs preview and commit through the TypeScript CLI.
