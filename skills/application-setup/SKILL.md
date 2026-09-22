---
name: application-setup
description: Set or review durable Job Apply browser and application-flow preferences.
allowed-tools: Read, Write, Bash
---

# Application Setup

Set up or selectively update the owner's durable application-flow preferences. Read
[answer-memory](../answer-memory/SKILL.md) first for plugin resolution, Store
initialization, private temporary inputs, and exact-revision handling, then read
[setup questions](references/setup-questions.md).

Inspect the current canonical profile before asking questions with
`node "<plugin-root>/apps/companion/command.mjs" store profile-inspect`. If the owner asks to
view setup, report the saved choices without starting a questionnaire. If the owner
already specified one or more changes, apply those changes and ask only for missing
choices needed to complete the requested setup. Accept partial setup and never erase
an unrelated saved choice.

Save only the changed keys beneath `applicationPreferences` with `profile-patch`, the
inspected revision, and source `user`. Confirm the stored choices from a fresh
inspection. These preferences guide future agent behavior; they never grant fill,
sensitive-answer, login, account, remember, or final-submission authority.
