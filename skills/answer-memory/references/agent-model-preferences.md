# Agent model preferences

The canonical profile may contain `agentModelPreferences`. It holds optional model
IDs for two host-launched worker tasks on each supported host:

```json
{
  "agentModelPreferences": {
    "codex": { "search": "model-id", "application": "model-id" },
    "claudeCode": { "search": "model-id", "application": "model-id" }
  }
}
```

| Task key | Worker that uses it | Direct host work |
| --- | --- | --- |
| `search` | Job Search's source research workers for LinkedIn, Hacker News, or X when delegation is available | The active host task model is used when the host researches directly. |
| `application` | Job Apply's one exact-job form-filling worker when delegation is available | The active host task model is used when the host fills directly. |

Job Title Discovery and resume fact extraction currently run in the active host
task. They have no separate worker route or model key. Add a new task key only
when that task has a real host-launched worker boundary that can select a model.
Do not reuse either existing key for these workflows.

Read this field through `store profile-inspect` after the ordinary Answer Memory
initialization and root-routing rules. Each field is optional. A missing or empty
field means use the host's default worker model. An explicit model choice in the
owner's current request overrides the saved choice for that task without rewriting
the Store. The Codex and Claude Code IDs are independent; never pass one host's ID
to the other host.

The host agent, not the TypeScript CLI or Companion, launches workers. Before a
worker starts, verify that its selected host supports the requested model and
that the available sub-agent facility accepts a model override. If either check
fails, explain the unavailable choice and wait for an owner-selected alternative.
Never silently substitute another model or treat a model preference as permission
to search a site, fill an application, use sensitive data, consent, or submit.

### Codex model preflight

For a Codex model choice made through an agent, inspect the **current Codex
host's** worker-tool model list or host model picker and its model-override
capability before offering or saving an exact `codex.search` or
`codex.application` ID. Require an exact ID match; do not infer support from a
model family, an API model list, a hard-coded catalog, or another host's choices.
If the current host does not expose a usable worker model list, or the chosen ID
or override is unavailable, leave the stored Codex preference unchanged.
Explain what could not be checked and ask the owner for an available choice or
the host default.

Repeat that check immediately before each Codex worker launch, even for a saved
ID. Stop **before** an application claim or browser work if the application
worker ID or override is unavailable, or before launching a search-source worker
if its ID or override is unavailable. Direct research in the active task may
continue with that task's model. A host catalog is not proof of
account entitlement: if the actual worker launch rejects the ID, report the
failure and preserve the selected job, run, and claim-free state. Never retry
silently with another model. A successful worker turn confirms access for that
turn, not future availability.

This Codex check does not validate `claudeCode` IDs. Use Claude Code's own host
capabilities when that host is active. Companion accepts manually entered model
IDs with format validation only; its saved field is not an availability receipt.

For an owner-requested settings change, inspect the current profile revision and
write only the changed nested keys with `store profile-patch --source user`. Use
`null` to remove one model ID and return that field to the host default. Preserve
other model choices and all unrelated profile fields. A stale revision requires a
fresh inspection and review of the changed choices before retrying. Companion's
Settings view uses the same selective profile patch and conflict handling.
