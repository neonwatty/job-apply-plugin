---
name: job-apply
description: Fill a selected job application to manual review, or fulfill a requested resume fact extraction.
allowed-tools: Read, Write, Bash, mcp__claude-in-chrome__*, mcp__plugin_playwright_playwright__*
---

# Job Application Assistant

Complete the requested application through verified manual review, or record the precise blocker and next action. Resume extraction is a separate workflow and ends at owner fact review.

## Route the request

First read [answer-memory](../answer-memory/SKILL.md) to resolve the plugin and Store routing for `node "<plugin-root>/apps/companion/command.mjs" store`. Never access persistent applicant files directly.
For first use or a cross-skill handoff, read the shared [workflow map](../answer-memory/references/workflow-map.md).

- An approved loopback URL with `#qa-route=<run-id>.<64-lowercase-hex-token>` requires [QA replay routing](../answer-memory/references/qa-replay.md) **before init or any other Store call**. Keep the isolated root throughout; never fall back to the real Store.
- Resume, facts, onboarding, or an exact extraction request: read [extraction](references/extraction.md). Never scan for extraction requests during every job application. Stop at owner fact review.
- Explicit legacy applicant-wide profile setup: read [profile setup](references/profile-setup.md). Ordinary applications use the chosen resume's confirmed facts.
- Ordinary application: after Store initialization, read [canonical intake](references/intake.md), [application automation](references/application-automation.md), then [filling and handoff](references/application.md). Start or reuse an application run whose managed resume and confirmed facts are authorized by the current exact-job request or an explicit choice under the intake rules. A supplied URL is ingested before browser work and added to that run's queue.
- Account or sign-in readiness: use [account-setup](../account-setup/SKILL.md) to classify the exact URL and configure only redacted metadata. Return here for the ordinary application after the user completes any required live sign-in step.
- Reviewed or blocked job: read [recovery](references/recovery.md). Preserve the job, session, managed resume, and displayed revisions. An expired claim requires explicit recovery outside the ordinary workflow.

Before interacting with a form, read [browser and consent](references/browser.md). It defines post-readiness consent, observed field verification, bounded recovery, and visible manual handoff. Advance through clearly non-final Next, Continue, Save, or Review steps; stop before any final submission action. A Review navigation control is not itself proof that the application reached final review.

Load `profile.applicationPreferences` from the same `profile-inspect` used for
canonical profile state. Apply an explicit browser or pacing choice in the current
request for this application; otherwise follow the saved supported preferences in
[browser and consent](references/browser.md). Missing setup never blocks an
application—the host's safe default behavior remains available.

Apply an explicit application-mode choice in the current request; otherwise use
`profile.applicationPreferences.preferredAutomationMode` to decide which mode to
offer. The saved preference is never authority. Guided remains the safe fallback,
and either higher mode requires a fresh exact-scope approval through
[application automation](references/application-automation.md).

Read only the matching platform notes when needed: [LinkedIn](references/linkedin-easy-apply.md), [Greenhouse](references/greenhouse.md), [Ashby](references/ashby.md), [Lever](references/lever.md), [Rippling](references/rippling.md), or [Workday](references/workday.md). Use [field mapping](references/field-mapping.md) for unfamiliar labels; observed controls and confirmed applicant facts take precedence over examples.

## Essential boundaries and completion

Guided is the default; Autofill to Review and Campaign to Review are durable, bounded grants defined in [application automation](references/application-automation.md). Every mode remains review-only. User confirmation never authorizes this skill to click Submit, Send, Apply, or any equivalent final-action button. Authentication, passwords, CAPTCHA, MFA, verification, legal consent, and ordinary account creation remain user-only steps. Explicit account-canary or policy work uses [account and policy internals](references/account-canaries.md); its approvals never spill into ordinary applications.

Obtain the bounded post-readiness consent before entering applicant data. Reuse matching authorization within that pass; do not ask again for unchanged scope, destination, and purpose. Keep sensitive current-use consent separate from permission to remember.

Never echo raw applicant values in chat or diagnostics. Use field names, counts, and states. Keep claim tokens, resume paths, candidate values, and browser state out of reports and durable sessions.

An ordinary application is handed off only after observed required controls, accepted upload, and the Store-recomputed current-attempt readiness report permit `awaiting_review`. Save `needs_info` and release the claim before waiting for missing input. If a known answer cannot be entered, report **Browser action required**, preserve the visible draft, and do not ask the owner to provide that answer again. Report success only after the helper confirms the durable handoff.
