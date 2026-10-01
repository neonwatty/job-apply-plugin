---
name: application-setup
description: Set or review durable Job Apply browser, application-flow, and worker model preferences.
allowed-tools: Read, Write, Bash
---

# Application Setup

Set up or selectively update the owner's durable application-flow and worker model preferences. Read
[answer-memory](../answer-memory/SKILL.md) first for plugin resolution, Store
initialization, private temporary inputs, and exact-revision handling, then read
[setup questions](references/setup-questions.md).

Inspect the current canonical profile before asking questions with
`node "<plugin-root>/apps/companion/command.mjs" store profile-inspect`. If the owner asks to
view setup, report the saved choices without starting a questionnaire. If the owner
already specified one or more changes, apply those changes and ask only for missing
choices needed to complete the requested setup. Accept partial setup and never erase
an unrelated saved choice.

Save only the changed keys beneath `applicationPreferences` or `agentModelPreferences`
with `profile-patch`, the inspected revision, and source `user`. Read
[agent model preferences](../answer-memory/references/agent-model-preferences.md)
before changing model IDs. Confirm the stored choices from a fresh
inspection. These preferences guide future agent behavior; they never grant fill,
sensitive-answer, login, account, remember, or final-submission authority.

`preferredAutomationMode` chooses which mode the application agent should offer. It
is not a live grant. Guided needs no durable authority; Autofill to Review and
Campaign to Review still require the owner to approve the exact current job scope,
expiration, and sensitive-answer references under
[application automation](../job-apply/references/application-automation.md).
