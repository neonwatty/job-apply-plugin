---
name: answer-memory
description: Read or update Job Apply applicant data through its canonical local Store.
allowed-tools: Read, Write, Bash
---

# Answer Memory

Use the bundled helper for persistent applicant data. Never directly read or edit Store files, recreate migrations or answer keys, or print private values merely to diagnose storage.

## Initialize only the needed workflow

Resolve `<plugin-root>` once from this installed skill's path. In Codex, use the catalog path, or `PLUGIN_ROOT` after verifying `scripts/job-apply-store.py` exists. In Claude Code, verify `CLAUDE_PLUGIN_ROOT` the same way. Never assume the working directory is the plugin root or search unrelated user directories.

Before **any** Store call, check for an approved loopback URL with `#qa-route=<run-id>.<64-lowercase-hex-token>`. For that route only, read [QA replay](references/qa-replay.md), resolve it before `init`, and pass the resolved `--root` throughout. Failure must never fall back to the real or legacy Store.

For ordinary storage work:

```bash
python3 "<plugin-root>/scripts/job-apply-store.py" init
```

The helper initializes `~/.job-apply/` and non-destructively migrates the legacy profile. Successful data commands return JSON. On nonzero exit, preserve files and explain the failure without exposing values.

Use permission-restricted temporary JSON files for `--input`, remove them on success or failure, and do not print their contents. `--input -` is also supported when a safe private stdin channel is available. Never supply credentials, authentication tokens, CAPTCHA/MFA data, or browser state.

## Read only the reference for the operation

- Profile facts, preferences, or fact groups: [profile](references/profile.md). Inspect the current revision before selective writes; preserve unrelated facts.
- Managed resume import, replacement, or extraction proposals: [resumes](references/resumes.md).
- Reusable answers, missing questions, consent, or answer-library edits: [answers](references/answers.md).
- Canonical job maintenance, history, or standalone sessions: [jobs and history](references/jobs-history.md).
- Starting or resuming an application: use [job-apply](../job-apply/SKILL.md). Ordinary agents use `job-apply-task.py` and `job-apply-attempt.py`, never raw acquire, recovery, heartbeat, progress, or handoff commands. The broker keeps claim authority private.
- Explicit storage compatibility/debugging: [storage contract](references/storage-contract.md).
- Explicit inert Auto-submit policy work: [policy](references/policy.md). This never authorizes live submission.

## Essential boundaries

Use exact current revisions for mutations. A conflict means inspect the changed state, preserve drafts, and resolve the difference; never blindly retry or overwrite unseen changes. Never downgrade corrupt or future-version documents.

Permission to fill is not permission to remember. Non-null sensitive answers require explicit field-specific retention consent and `--remember-sensitive`; remembered sensitive answers still require current-use approval. History and sessions contain references and closed status metadata, never answer/profile/resume values or credentials.

Only the user may submit an application. Record `reviewed` at final review, and `completed`/`applied` only after the user confirms their submission. Storage or policy operations do not grant browser authority.
