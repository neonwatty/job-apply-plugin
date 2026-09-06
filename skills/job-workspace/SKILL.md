---
name: job-workspace
description: Open the local Job Apply Companion to manage jobs, applicant facts, resumes, and answers.
allowed-tools: Bash
---

# Job Workspace

Start the packaged, local-only companion when the user asks to review their next step, manage canonical Jobs, Facts, Resumes, reusable Answers and observed questions, supervise Application Activity or Needs Attention, or recover Trash in a browser.

## Launch

1. Resolve `<plugin-root>` safely. In Codex, use the installed skill path and walk up from `skills/job-workspace/SKILL.md`; use `PLUGIN_ROOT` only after confirming it contains both `scripts/job-apply-workspace.py` and `workspace/index.html`. In Claude Code, use `CLAUDE_PLUGIN_ROOT` after the same checks.
2. Run exactly:

   ```bash
   python3 "<plugin-root>/scripts/job-apply-workspace.py"
   ```

3. Leave the process attached while the user works. Report that Ctrl-C stops it cleanly.

The launcher chooses a free port, binds only to `127.0.0.1`, opens the browser, and imports the same canonical Store implementation bundled in `scripts/job-apply-store.py`. The browser never reads or writes store files directly. It needs no account, cloud service, telemetry, separate database, Node runtime, or frontend installation.

## Boundaries and completion

The workspace uses the canonical Store contract in `scripts/job-apply-store.py`; it owns no separate applicant database. Never expose its localhost service on another host or copy the printed fragment token into chat or logs. If opening fails, direct the owner to the complete URL printed locally by the launcher.

Confirm the launcher is serving before reporting the workspace ready. Keep the process attached while the user works; Ctrl-C stops it cleanly. Do not restart a healthy workspace merely to explain a feature.

The UI queues work for the next active Job Apply agent and does not start or launch an agent. It cannot extract facts, complete or fail a request, or author a proposal. It never performs final application submission.

For Jobs, Facts, Resumes, Answers, extraction requests, Activity, Needs Attention, Trash, or recovery details, read [workspace behavior](references/workspace.md) only when that surface is relevant. Preserve drafts on revision conflicts and never automatically repair or downgrade the Store.
