# Pinterest Greenhouse review-only dogfood

On 2026-09-29, the installed Job Apply plugin filled a fresh Pinterest application
in the owner's visible Chrome session and reached durable `awaiting_review`. The
source was staging merge commit `ef4cf1ad0b2df8feaa42dd66da492504275a1614`;
the installed cachebuster version was `1.3.5+codex.20260929180408`. The public
posting was [Principal Engineer, Core - Pinner Journeys](https://www.pinterestcareers.com/jobs/8052679/principal-engineer-core-pinner-journeys/?gh_jid=8052679#apply-now).

The embedded form was inaccessible, so the agent opened the direct Greenhouse
form URL observed in the page, checked that it was the same Pinterest job, and
obtained fresh approval for that form instance. The managed resume upload was
accepted. The agent inspected 20 logical controls, including 11 required ones,
verified the chosen answers and approved demographic consent control, and left
the final Submit button untouched. The Store accepted a current-attempt review
handoff and reported `readiness.status=ready`; the claim was released. The
[value-free receipt](2026-09-29-pinterest-greenhouse-live-review.json) records
only those bounded outcomes. No applicant value, resume path, form token, or
screenshot is committed.

## Repeat from a blank form

1. Confirm with the owner that the prior Pinterest application was not
   submitted. Inspect the saved job's current revision and review activity.
   Companion's Job activity view can copy a repeat-review request for the saved
   job; copying it does not restart an attempt or grant consent.
2. Use the documented `restart-review` route for the exact saved job and selected
   managed resume. Preserve its prior review history. Do not reset the Store or
   copy applicant data into a test fixture.
3. Open the public posting in the owner's selected visible browser. Reach a fresh
   blank application; if the embedded control fails, use only a direct ATS URL
   observed from that page and verify the company and job identity.
4. Inventory the current controls and notices. Obtain one bounded approval for
   the new form instance, including each sensitive saved answer and any consent
   action. Previous run approval does not carry over.
5. Resolve and guard the run's managed resume immediately before its chooser.
   Verify accepted upload, every required control, optional and conditional
   controls, the consent action, and the untouched final control.
6. Build the value-free current-attempt readiness packet and use `attempt
   handoff --status awaiting_review`. Require `handed_off`, then verify the Store
   job is `awaiting_review` with no claim. Never activate Submit.

This is one agent-attested live observation of one employer's form. The Store
checks the packet's internal consistency but cannot independently prove the
browser inventory was complete. A fresh live run must repeat these checks; this
receipt is not a standing guarantee that the posting or form is still available.
Use the [consent variant matrix](consent-intent-variant-matrix.md) when the next
application exposes a different control or notice.
