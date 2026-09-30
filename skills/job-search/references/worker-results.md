# Source worker result contract

The host agent gives each worker one source: LinkedIn, Hacker News, or X. Pass the active location, work arrangement, compensation, exclusion, date, and verified-fact requirements, plus saved-title seeds and a few broad related-role or capability search terms. Those terms may be derived from current canonical facts, but never pass the raw applicant profile, resume or resume facts, names, employer history, contact details, exact tenure, saved answers, credentials, or Store paths. Workers research public listings only; the host privately decides whether observed responsibilities match the owner's demonstrated background. Workers never write a report, call Store mutations, select jobs for the owner, or start an application. Give each worker only its section of [source guidance](sources.md).

Each worker returns the same shape. `observedAt` is when the evidence was inspected, not a guessed posting date. Use `null` for unknown facts; retain literal compensation and location wording. Every listing needs an inspectable source URL. `applicationUrl` is optional and must be directly observed. Evidence notes should be short, factual, and tied to a URL. A blocked or empty source still returns a source result.

```json
{
  "source": "LinkedIn",
  "status": "complete",
  "observedAt": "2026-09-30T12:00:00Z",
  "inspectedCount": 10,
  "limit": 25,
  "searchedLanes": ["saved-title", "capability"],
  "limitations": [],
  "listings": [
    {
      "sourceUrl": "https://example.com/job/123",
      "discoveryLanes": ["capability"],
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

`searchedLanes` records which query lanes were actually inspected; each listing's `discoveryLanes` records where it appeared. Use `saved-title` for a saved-title query and `capability` for a related-role or skill-led query. The source limit and `inspectedCount` cover distinct inspected source items across both lanes (listings, HN comments, or X posts), not a fresh limit for each. If an intended lane could not be searched, explain why in `limitations`, mark the source partial when another lane was inspected, and do not claim it ran. `status` is `complete` when the requested source and intended lanes were inspected to the stated limit, `partial` when some results were inspected but access, paging, rate limits, or errors prevented the intended pass, and `unavailable` when no usable source results could be inspected. A valid empty search is `complete` with `listings: []`; explain the filters and observed empty state in `limitations`. For partial and unavailable states, name the reason, affected scope, and safe retry option. Do not claim a source is complete when the limit truncates a larger set; disclose truncation in `limitations` and the host's final answer.

The host checks source URLs and evidence, applies explicit filters, and marks unknown required facts **Unknown—verify** unless verification was explicitly required. For a different-title result, the host compares observed responsibilities with relevant current canonical skills and experience, explains the connection and visible gaps privately to the owner, and never assumes the job's seniority or requirements are met. Keep a stable source order of LinkedIn, Hacker News, X for date ties. Deduplicate exact job URLs. Merge cross-posts only when an observed application URL or other direct evidence establishes the same job; retain all source URLs, dates, and conflicting facts visibly. Never infer identity from similar titles and company names alone. The host records a source-level failure even if other sources return results. Only the host writes the timestamped compatibility report and invokes the [queue intake](queue.md) after the owner selects exact results.

`context` holds only observed source-specific details such as a visible hiring-manager link, connection, applicant count, or post author and engagement. These details and `applicationMethod` are descriptive; they never become ranking weights or canonical queue fields unless [queue intake](queue.md) explicitly supports them.
