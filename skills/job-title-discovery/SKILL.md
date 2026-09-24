---
name: job-title-discovery
description: Research credible related job titles from a person's career context and job-board evidence, then return reviewable suggestions without changing saved preferences. Use when someone wants to explore possible target roles; use job-search for actual openings.
---

# Job Title Discovery

Use [answer-memory](../answer-memory/SKILL.md) to resolve the plugin root and inspect only relevant canonical profile and resume facts. Read current search preferences with `node "<plugin-root>/apps/companion/command.mjs" store profile-inspect`; treat the current resume title as history, not a required future target. Include the owner's role interests, seed titles, seniority limits, and exclusions when supplied. Ask only for a missing constraint that materially changes the research.

Read [discovery workflow](references/discovery-workflow.md) before browser research. Use the host's visible browser to inspect LinkedIn job-board results where available. Never invent postings or promote generic brainstorming as observed evidence. If the source is logged out, blocked, unavailable, or empty, report that exact state and a safe next step.

Return one JSON result packet as specified in [result format](references/result-format.md). Group evidence-backed suggestions into core, adjacent, and stretch roles, each with a reason and inspectable source. The examples Principal ML Engineer, Senior/Staff/Principal Forward Deployed Engineer, and Director of AI are possible outcomes only when the person's interests and observed evidence support them; they are not defaults.

Discovery is read-only. Do not write private Store files, modify resume facts, or call `preferences-set`. Companion must let the owner review an exact title set before its canonical, revision-checked save. If the owner asks to save approved titles in chat, hand that explicit set to [job-preferences](../job-preferences/SKILL.md); then [job-search](../job-search/SKILL.md) may use the saved `targetTitles`. A discovery packet alone never authorizes a preference write.
