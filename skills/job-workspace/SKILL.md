---
name: job-workspace
description: Start the optional local Jobs, Facts, and Resumes workspace shared with Job Apply agents and the canonical store.
allowed-tools: Bash
---

# Job Workspace

Start the packaged, local-only companion when the user asks to review or edit canonical profile facts and preferences; manage canonical resume metadata, private files, defaults, trash, or extraction conflicts; or view, organize, edit, preflight, or prepare canonical jobs in a browser.

## Launch

1. Resolve `<plugin-root>` safely. In Codex, use the installed skill path and walk up from `skills/job-workspace/SKILL.md`; use `PLUGIN_ROOT` only after confirming it contains both `scripts/job-apply-workspace.py` and `workspace/index.html`. In Claude Code, use `CLAUDE_PLUGIN_ROOT` after the same checks.
2. Run exactly:

   ```bash
   python3 "<plugin-root>/scripts/job-apply-workspace.py"
   ```

3. Leave the process attached while the user works. Report that Ctrl-C stops it cleanly.

The launcher chooses a free port, binds only to `127.0.0.1`, opens the browser, and imports the same canonical Store implementation bundled in `scripts/job-apply-store.py`. The browser never reads or writes store files directly. It needs no account, cloud service, telemetry, separate database, Node runtime, or frontend installation.

## Boundaries

- Never copy the printed fragment token into chat, logs, or another URL. If the browser did not open, tell the user to open the complete URL printed locally by the launcher.
- Never bind the workspace to another host or proxy it onto a network.
- The Jobs surface can create, edit, organize, preflight, mark ready, and move Jobs records to recoverable trash. The Facts surface selectively edits the canonical profile and preferences with provenance and explicit conflict choices.
- The Resumes surface imports bounded PDF, DOCX, or UTF-8 TXT bytes into the private canonical managed library; edits labels/tags; replaces or explicitly adopts a file; manages defaults and guarded Trash; previews authenticated PDF/TXT; downloads DOCX; and reviews existing agent-created extraction proposals. Browser source paths and filenames are not retained.
- Resume lists omit bytes, paths, file identities, digests, and proposal values. Content delivery is authenticated, no-store, fixed-MIME, and limited to canonical active managed IDs. The browser cannot browse arbitrary paths.
- Resume and proposal conflicts are never retried. Preserve metadata drafts and file selections, refresh the canonical revision, and require explicit reapplication or reconfirmation. Accepted extraction decisions refresh Facts and remain user-provenanced.
- V1 does not parse, author, edit, generate, or tailor resume content; author extraction proposals; sync to cloud storage; or maintain browser-owned durable application data.
- The UI does not run application agents or access arbitrary files. It must not submit applications or activate any third-party final action. A ready record is only a handoff for the existing Job Apply workflow.
- All mutations go through the canonical Store contract with optimistic revisions. If a conflict appears, preserve the draft and let the user review or reapply it explicitly.
