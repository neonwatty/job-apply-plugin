### Canonical queue intake and replenishment

The shared job store is the authoritative queue. The timestamped search Markdown report is a compatibility report only; do not treat `application_queue.md` as the
handoff or append to it.

For the exact results selected by the user, prepare a temporary JSON input with a top-level `jobs`
array. Map only supported canonical fields when they are known: `url`, `source`,
`sourceId`, `role`, `company`, `location`, `workplaceType`, `employmentType`,
`compensation`, `description`, `ats`, and `lastCheckedAt`. A URL is required for
each item. Keep connections, hiring-manager details, applicant counts,
engagement, and other search-only details in the timestamped Markdown report;
never place them in the structured input.

This flow is repeatable: use the owner-selected URL/browser page, count and
filters for each intake request. Do not broaden a supplied selection or start a
recurring search. Preserve existing statuses and user-owned fields; never reset
records to saved or Ready as part of replenishment. Manual Jobs entry remains
an alternative when the owner prefers it.

Before committing, preview the exact agent-authored input:

```bash
python3 "<plugin-root>/scripts/job-apply-store.py" job-upsert-preview \
  --origin agent --input <temporary-jobs.json>
```

Show the per-item `create`, `update`, `noop`, `conflict`, and `invalid` decisions.
An explicit request to save/import the exact selected jobs already authorizes
that scope; do not ask for the same permission again. If the selection or changed
fields exceed that authorization, obtain the missing choice before committing.
Use the exact same input, origin, and opaque token returned by preview:

```bash
python3 "<plugin-root>/scripts/job-apply-store.py" job-upsert-commit \
  --origin agent --input <temporary-jobs.json> --token <preview-token>
```

If commit rejects drift, run a fresh preview and show the changed decisions.
Obtain a new choice when the changes exceed the authorized scope. Never commit a stale or altered preview. Report conflicts and invalid
items without attempting to invent a merge rule. Delete the temporary input when
the interaction is finished.

### Automatic readiness after intake

After each successful intake, automatically run `job-preflight --id <job-id>`
for each unique `create`, `update`, or `noop` decision ID. Do not check conflicted
or invalid items as though they were saved. Apply this after legacy report intake
as well. If the owner chose manual entry, check their newly saved jobs when they
return to the agent; do not require a separate readiness command from them.

Report ready, blocked, and warning results. Resolve the job's assigned resume,
otherwise the default, otherwise its sole active resume. A broken assigned or
default resume remains a blocker; never silently switch to another document.
With multiple active resumes and no assignment/default, ask the owner to choose.
A sole active resume must still pass file/integrity checks. Preflight does not
persist a default or assignment. Do not change a job's status or start an
application merely because preflight passes. Report storage errors separately
from missing facts and never repair or overwrite the Store to complete intake.

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
