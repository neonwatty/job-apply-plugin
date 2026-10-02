# Agent model preferences

The canonical profile may contain `agentModelPreferences`. It holds optional model
IDs for search and application work on each supported host:

```json
{
  "agentModelPreferences": {
    "codex": { "search": "model-id", "application": "model-id" },
    "claudeCode": { "search": "model-id", "application": "model-id" }
  }
}
```

| Task key | Codex desktop | Claude Code |
| --- | --- | --- |
| `search` | One owner-requested, top-level search task; a permitted source worker may use it when that worker has the required source access. | Source research workers when delegation is available. |
| `application` | One owner-requested, top-level task for one exact job. | One exact-job form-filling worker when delegation is available. |

When work stays in the current host task, its active model is used. A saved model
does not switch the current task's model, create a task, or grant browser access.
Codex browser-bound work should run directly in a top-level desktop task. A
subagent's model choice does not make a visible browser available to it.

Job Title Discovery and resume fact extraction currently run in the active host
task. They have no separate model key. Add a new task key only when that task has
a real host-launched boundary that can select a model.
Do not reuse either existing key for these workflows.

Read this field through `store profile-inspect` after the ordinary Answer Memory
initialization and root-routing rules. Each field is optional. A missing or empty
field means use the host's default task or worker model. An explicit model choice in the
owner's current request overrides the saved choice for that task without rewriting
the Store. The Codex and Claude Code IDs are independent; never pass one host's ID
to the other host.

The host agent, not the TypeScript CLI or Companion, launches tasks or workers.
Before launch, verify that the selected host supports the requested model and
that the actual launch facility accepts a model override. If either check fails,
explain the unavailable choice and wait for an owner-selected alternative.
Never silently substitute another model or treat a model preference as permission
to create a task, search a site, fill an application, use sensitive data, consent,
or submit. A new Codex task requires an explicit owner request; the saved field
alone never creates a user-visible task. An owner-saved exact model is the
default for a later owner-requested task launch. Show which model was used in
the handoff.

### Codex model preflight

For a Codex model choice made through an agent, inspect the **current Codex
host's** model list or picker and the intended task or worker tool's override
capability before offering or saving an exact `codex.search` or
`codex.application` ID. Require an exact ID match; do not infer support from a
model family, an API model list, a hard-coded catalog, or another host's choices.
If the current host does not expose a usable model list, or the chosen ID
or override is unavailable, leave the stored Codex preference unchanged.
Explain what could not be checked and ask the owner for an available choice or
the host default.

Repeat that check immediately before each Codex task or worker launch, even for
a saved ID. Stop **before** creating a task, acquiring an application claim, or
opening its browser if the selected ID or override is unavailable. Direct work
in the active task may continue only under an explicit choice to use that task's
model. A host catalog is not proof of account entitlement: if the actual launch
rejects the ID, report the failure and preserve the selected job, run, and
claim-free state. Never retry silently with another model. A successful launch
confirms access for that turn, not future availability.

This Codex check does not validate `claudeCode` IDs. Use Claude Code's own host
capabilities when that host is active. Companion accepts manually entered model
IDs with format validation only; its saved field is not an availability receipt.

For an owner-requested settings change, inspect the current profile revision and
write only the changed nested keys with `store profile-patch --source user`. Use
`null` to remove one model ID and return that field to the host default. Preserve
other model choices and all unrelated profile fields. A stale revision requires a
fresh inspection and review of the changed choices before retrying. Companion's
Settings view uses the same selective profile patch and conflict handling.
