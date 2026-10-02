# Dedicated Codex task routing dogfood — 2026-10-02

This pass tested browser access and the review-only boundaries of separate,
top-level local Codex tasks. It did not test application submission.

## Browser boundary

- A Codex subagent using GPT-6 Luna could not create a visible in-app browser
  tab (`IAB visibility is not supported in a subagent thread`) or a visible
  Chrome tab (`Capability is not available: visibility`).
- A separate top-level local Codex task using GPT-6 Luna opened and controlled
  a visible signed-in LinkedIn Jobs Chrome tab. This established the task
  boundary used by the updated skills on this host. Availability may differ
  on another host or a later app version.

## Job Search task

A new local task read saved search preferences through the canonical Store,
used its own visible browser for LinkedIn and X, and sampled the current
Hacker News hiring thread. It inspected nine LinkedIn job details, 50 of 185
top-level HN posts, and seven X posts. It saved a bounded Markdown report
without adding jobs to the queue or changing preferences. No saved Codex
search model existed; this pass used the new task's default model, which the
task could not identify from its runtime. The separate GPT-6 Luna browser
spike above verified that an explicit model override could launch.

## Job Apply task

A separate local task launched with the saved `codex.application` model,
`gpt-6-luna`, for the queued Supabase Ashby job. Its own in-app browser reached
the visible application form. The early check found no sign-in or verification
gate; the Store's account classifier remained unresolved, so the task did not
assume the portal was accountless. The job remained Ready. The task stopped at
the required post-readiness fill consent point. At this checkpoint there was
no applicant entry, resume upload, claim, or final submission.

## Remaining live check

After the owner approves the exact live-form fill scope in the application
task, verify that the task acquires the exact job through the broker, fills and
checks observed required controls, then hands off to manual review without
activating a final action. Record the durable job status and any browser or
field blocker without copying applicant values into this document.
