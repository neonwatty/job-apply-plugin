### 3. Canonical Queue Ingestion (Optional, User Confirms)

The shared job store is the authoritative queue. The timestamped search Markdown report is a compatibility report only; do not treat `application_queue.md` as the
handoff or append to it.

For the exact results selected by the user, prepare a temporary JSON input with a top-level `jobs`
array. Map only supported canonical fields when they are known: `url`, `source`,
`sourceId`, `role`, `company`, `location`, `workplaceType`, `employmentType`,
`compensation`, `description`, `ats`, and `lastCheckedAt`. A URL is required for
each item. Keep connections, hiring-manager details, applicant counts,
engagement, and other search-only details in the timestamped Markdown report;
never place them in the structured input.

Before asking for confirmation, preview the exact agent-authored input:

```bash
python3 "<plugin-root>/scripts/job-apply-store.py" job-upsert-preview \
  --origin agent --input <temporary-jobs.json>
```

Show the user the per-item `create`, `update`, `noop`, `conflict`, and `invalid`
decisions and summary, then ask:

> **{N} selected jobs.** The shared queue preview is ready. Would you like me to commit these changes?

Commit only after explicit confirmation, using the exact same input, origin, and
opaque token returned by preview:

```bash
python3 "<plugin-root>/scripts/job-apply-store.py" job-upsert-commit \
  --origin agent --input <temporary-jobs.json> --token <preview-token>
```

If commit rejects drift, run a fresh preview, show the changed decisions, and ask
again. Never commit a stale or altered preview. Report conflicts and invalid
items without attempting to invent a merge rule. Delete the temporary input when
the interaction is finished.

### Import existing timestamped reports

When the user asks to migrate previously saved search reports, use the guided
legacy commands instead of reconstructing JSON by hand. Run
`legacy-jobs-preview` with no selection to discover supported `search-*.md`
entries directly under `~/.claude-job-searches/`. Show valid and invalid items,
ask which opaque item IDs to import, then run `legacy-jobs-preview` with the
chosen IDs as repeatable `--select` options. Show its canonical decisions and
ask for explicit confirmation of that exact selected preview. Commit with the
same ordered `--select` options and `--confirm <preview-token>`.

If commit reports drift, rediscover and preview again. Never import
`application_queue.md`, accept a caller-selected source root, recurse, follow a
symlink, edit a report, or infer another Markdown format. After commit, use the
canonical job commands for all queue work; timestamped reports remain preserved
compatibility artifacts rather than a synchronization source.

---
