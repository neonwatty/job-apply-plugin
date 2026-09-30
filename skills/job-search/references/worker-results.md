# Source worker result contract

The host agent gives each worker one source: LinkedIn, Hacker News, or X. Pass the active role, location, work arrangement, compensation, exclusion, date, and verified-fact requirements needed for research. Do not pass applicant profile, resume, saved answers, credentials, or Store paths. Workers research only; they never write a report, call Store mutations, select jobs for the owner, or start an application. Give each worker only its section of [source guidance](sources.md).

Each worker returns the same shape. `observedAt` is when the evidence was inspected, not a guessed posting date. Use `null` for unknown facts; retain literal compensation and location wording. Every listing needs an inspectable source URL. `applicationUrl` is optional and must be directly observed. Evidence notes should be short, factual, and tied to a URL. A blocked or empty source still returns a source result.

```json
{
  "source": "LinkedIn",
  "status": "complete",
  "observedAt": "2026-09-30T12:00:00Z",
  "inspectedCount": 10,
  "limit": 25,
  "limitations": [],
  "listings": [
    {
      "sourceUrl": "https://example.com/job/123",
      "applicationUrl": null,
      "role": "Example role",
      "company": "Example company",
      "postedAt": null,
      "location": null,
      "workplaceType": null,
      "compensation": null,
      "employmentType": null,
      "description": null,
      "applicationMethod": null,
      "context": [],
      "evidence": ["Role and company visible at sourceUrl"],
      "unknowns": ["posting date", "location", "compensation"]
    }
  ]
}
```

`status` is `complete` when the requested source was inspected to its stated limit, `partial` when some results were inspected but access, paging, rate limits, or errors prevented the intended pass, and `unavailable` when no usable source results could be inspected. A valid empty search is `complete` with `listings: []`; explain the filters and observed empty state in `limitations`. For partial and unavailable states, name the reason, affected scope, and safe retry option. Do not claim a source is complete when the limit truncates a larger set; disclose truncation in `limitations` and the host's final answer.

The host checks source URLs and evidence, applies explicit filters, and marks unknown required facts **Unknown—verify** unless verification was explicitly required. Keep a stable source order of LinkedIn, Hacker News, X for date ties. Deduplicate exact job URLs. Merge cross-posts only when an observed application URL or other direct evidence establishes the same job; retain all source URLs, dates, and conflicting facts visibly. Never infer identity from similar titles and company names alone. The host records a source-level failure even if other sources return results. Only the host writes the timestamped compatibility report and invokes the [queue intake](queue.md) after the owner selects exact results.

`context` holds only observed source-specific details such as a visible hiring-manager link, connection, applicant count, or post author and engagement. These details and `applicationMethod` are descriptive; they never become ranking weights or canonical queue fields unless [queue intake](queue.md) explicitly supports them.
