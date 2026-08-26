---
name: job-workspace
description: Start the optional local Jobs, Facts, Resumes, Answers, and unified Trash workspace shared with Job Apply agents and the canonical store.
allowed-tools: Bash
---

# Job Workspace

Start the packaged, local-only companion when the user asks to manage canonical Jobs, Facts, Resumes, reusable Answers and observed questions, or recoverable Trash in a browser.

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
- The Answers surface uses only canonical `answers.json` records. It provides a redacted searchable library and observed-question inbox, explicit sensitive reveal, fresh retention consent, optimistic conflicts, review decisions, reference counts, guarded Trash/deletion, and explicit accepted-winner merge at exact scope/revisions. Merge options and results are redacted. The browser may temporarily display a non-sensitive detail value or an explicitly revealed sensitive value in the open dialog, but it clears that field when the dialog closes and never persists answer values or browser-owned answer state.
- The top-level Trash surface combines redacted jobs, resumes, and answers from the canonical store with exact per-type counts and type filters. Restore and permanent delete always send the record's exact revision. Permanent deletion is individual, uses an accessible identity-bound dialog, and requires the exact phrase `DELETE JOB`, `DELETE RESUME`, or `DELETE ANSWER`. Deleting a managed resume also permanently deletes its managed file; every other lifecycle effect remains limited to the selected canonical record. Nothing cascades or erases durable history, sessions, or audit evidence. Revision conflicts and protected-reference/default/duplicate blockers have distinct redacted explanations and are never retried.
- Aggregate answer responses omit every value. A detail response may include a non-sensitive value; a sensitive value requires the explicit reveal action. Declined observations remain durable and hidden from default library/inbox views.
- Resume lists omit bytes, paths, file identities, digests, and proposal values. Content delivery is authenticated, no-store, fixed-MIME, and limited to canonical active managed IDs. The browser cannot browse arbitrary paths.
- Resume and proposal conflicts are never retried. Preserve metadata drafts and file selections, refresh the canonical revision, and require explicit reapplication or reconfirmation. Accepted extraction decisions refresh Facts and remain user-provenanced.
- V1 does not parse, author, edit, generate, or tailor resume content; author extraction proposals; sync to cloud storage; or maintain browser-owned durable application data.
- The UI does not run application agents or access arbitrary files. It must not submit applications or activate any third-party final action. A ready record is only a handoff for the existing Job Apply workflow.
- All mutations go through the canonical Store contract with optimistic revisions. If a conflict appears, preserve the draft and let the user review or reapply it explicitly.
