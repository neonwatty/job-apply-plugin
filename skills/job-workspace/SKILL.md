---
name: job-workspace
description: Open the local Job Apply Companion to manage jobs, applicant facts, resumes, and answers.
allowed-tools: Bash
---

# Job Workspace

Start the packaged, local-only companion when the user asks to review their next step, manage canonical Jobs, Facts, Resumes, reusable Answers and observed questions, edit application setup, supervise Application Activity or Needs Attention, or recover Trash in a browser.
For first use or a handoff between Companion and an agent, read the shared [workflow map](../answer-memory/references/workflow-map.md).

## Launch

1. Resolve `<plugin-root>` safely. In Codex, use the installed skill path and walk up from `skills/job-workspace/SKILL.md`; use `PLUGIN_ROOT` only after confirming it contains `apps/companion/launch.mjs`, its standalone build, and the host's packaged native lock. In Claude Code, use `CLAUDE_PLUGIN_ROOT` after the same checks.
2. Run exactly:

   ```bash
   node "<plugin-root>/apps/companion/launch.mjs"
   ```

3. Leave the process attached while the user works. Report that Ctrl-C stops it cleanly.

The launcher chooses a free port, binds only to `127.0.0.1`, opens the browser, and uses the canonical native Store runtime. The browser never reads or writes Store files directly. It needs no account, cloud service, telemetry, separate database, Python runtime, or frontend installation.

## Boundaries and completion

The workspace uses the same canonical Store contract as the native command router; it owns no separate applicant database. Never expose its localhost service on another host or copy the printed fragment token into chat or logs. If opening fails, direct the owner to the complete URL printed locally by the launcher.

Confirm the launcher is serving before reporting the workspace ready. Keep the process attached while the user works; Ctrl-C stops it cleanly. Do not restart a healthy workspace merely to explain a feature.

The UI queues work for the next active Job Apply agent and does not start or launch an agent. It cannot extract facts, complete or fail a request, or author a proposal. It lets the owner review, edit, and confirm facts already extracted for an individual resume. It never performs final application submission.

For title discovery, open Facts → Search preferences → Discover related titles. Companion copies a `$job-apply:job-title-discovery` or `/job-apply:job-title-discovery` invocation with only owner-entered criteria. Run that skill in the matching host and paste its version 1 JSON packet into Companion. The skill researches visible sources and reports logged-out, blocked, unavailable, or empty sources honestly. Companion validates the packet and shows saved titles, suggestions, evidence, and the exact selected set. Cancel, an invalid packet, or source retry makes no preference write. Confirming saves only approved `targetTitles` through the canonical revision-checked profile API; if the revision changed, reload and review before retrying. [Job Preferences](../job-preferences/SKILL.md) owns direct chat preference changes, and [Job Search](../job-search/SKILL.md) reads saved titles for opportunity search.

For Jobs, Facts, Resumes, Answers, extraction requests, Activity, Needs Attention, Trash, or recovery details, read [workspace behavior](references/workspace.md) only when that surface is relevant. Preserve drafts on revision conflicts and never automatically repair or downgrade the Store.
