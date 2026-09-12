---
name: job-apply
description: Fill a selected job application to manual review, or fulfill a requested resume fact extraction.
allowed-tools: Read, Write, Bash, mcp__claude-in-chrome__*, mcp__plugin_playwright_playwright__*
---

# Job Application Assistant

Complete the requested application through verified manual review, or record the precise blocker and next action. Resume extraction is a separate workflow and ends at proposal review.

## Route the request

First read [answer-memory](../answer-memory/SKILL.md) to resolve the plugin and Store routing for `python3 "<plugin-root>/scripts/job-apply-store.py"`. Never access persistent applicant files directly.

- An approved loopback URL with `#qa-route=<run-id>.<64-lowercase-hex-token>` requires [QA replay routing](../answer-memory/references/qa-replay.md) **before init or any other Store call**. Keep the isolated root throughout; never fall back to the real Store.
- An exact extraction request: read [extraction](references/extraction.md) and complete that request. Never scan for extraction requests during every job application. Stop at proposal review.
- Resume import, onboarding, empty profile, or explicit initial setup: read [profile setup](references/profile-setup.md). Ask only for missing input; use an already supplied resume path. For re-extraction of an existing managed resume, create or use its exact request and follow [extraction](references/extraction.md).
- Ordinary application: after Store initialization, load `profile-get`; if empty, complete profile setup first. Read [canonical intake](references/intake.md), then [filling and handoff](references/application.md). Use only an exact user-selected job, canonical managed resume, and the private `job-apply-attempt.py` broker. A supplied URL is ingested before browser work.
- Reviewed or blocked job: read [recovery](references/recovery.md). Preserve the job, session, managed resume, and displayed revisions. An expired claim requires explicit recovery outside the ordinary workflow.

Before interacting with a form, read [application automation modes](references/application-modes.md), then [browser and consent](references/browser.md). They define durable scope, post-readiness consent, observed field verification, bounded recovery, and visible manual handoff. Advance through clearly non-final Next, Continue, Save, or Review steps; stop before any final submission action. A Review navigation control is not itself proof that the application reached final review.

Read only the matching platform notes when needed: [LinkedIn](references/linkedin-easy-apply.md), [Greenhouse](references/greenhouse.md), [Ashby](references/ashby.md), [Lever](references/lever.md), [Rippling](references/rippling.md), or [Workday](references/workday.md). Use [field mapping](references/field-mapping.md) for unfamiliar labels; observed controls and confirmed applicant facts take precedence over examples.

## Essential boundaries and completion

Guided is the safe default; Fill to Review and Campaign require durable exact Store authority. User confirmation never authorizes this skill to click Submit, Send, or any equivalent final-action button. Authentication, passwords, CAPTCHA, MFA, and ordinary account creation remain user-only steps. Explicit account-canary or policy work uses [account and policy internals](references/account-canaries.md); its approvals never spill into ordinary applications.

In Guided, obtain bounded post-readiness consent before entering applicant data. In Fill to Review or Campaign, evaluate the durable current authority before each action group. Reuse matching authority throughout ordinary same-destination pages; do not ask again for already covered categories. Keep sensitive current-use consent separate from permission to remember.

Never echo raw applicant values in diagnostics or operational reports. Use field names, counts, and states there. For user-directed resume/profile review, present a readable summary in the conversation; the companion is optional. Keep claim tokens, resume paths, candidate values, and browser state out of reports and durable sessions.

An ordinary application is handed off only after observed required controls, accepted upload, and the Store-recomputed current-attempt readiness report permit `awaiting_review`. Save `needs_info` and release the claim before waiting for missing input. If a known answer cannot be entered, report **Browser action required**, preserve the visible draft, and do not ask the owner to provide that answer again. Report success only after the helper confirms the durable handoff.
