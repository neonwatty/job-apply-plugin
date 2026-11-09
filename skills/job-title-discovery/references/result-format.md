# Title discovery packet v1

Return a single JSON object, optionally in a `json` code fence. Do not add prose inside the fence. Companion validates this object before showing suggestions. All fields shown below are required; optional evidence `company` may be omitted. Unknown fields are rejected.

```json
{
  "version": 1,
  "source": {
    "status": "observed",
    "detail": "LinkedIn Jobs results were visible for the researched role terms."
  },
  "suggestions": [
    {
      "title": "Staff Machine Learning Engineer",
      "category": "adjacent",
      "rationale": "The observed role uses the owner's stated ML platform experience, with broader technical scope to assess.",
      "evidence": [
        {
          "source": "LinkedIn Jobs",
          "url": "https://www.linkedin.com/jobs/view/example-public-id/",
          "observedTitle": "Staff Machine Learning Engineer",
          "company": "Example Company"
        }
      ]
    }
  ]
}
```

`source.status` is exactly one of `observed`, `logged_out`, `blocked`, `unavailable`, or `empty`. `observed` requires at least one suggestion, and every suggestion requires a public HTTP(S) evidence URL, a nonempty observed title, a category (`core`, `adjacent`, `stretch`), and a concise rationale. For all other statuses, `suggestions` must be `[]`; `detail` explains what happened without claiming observation. Use `empty` only when results were actually inspected and offered no useful title evidence. Use `unavailable` when the source could not be reached, `logged_out` when a sign-in barrier was visible, and `blocked` when access was denied or challenged. Do not put personal data or raw page text in the packet.

The parser collapses only cosmetic title duplicates (case, whitespace, and typographic spacing), retaining distinct evidence links; conflicting categories for one title are rejected. It preserves different role families and seniority. The owner remains free to edit or reject every suggestion. A packet is a draft for review, never a save request.
