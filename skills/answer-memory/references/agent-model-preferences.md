# Agent model preferences

The canonical profile may contain `agentModelPreferences`. It holds optional model
IDs for search and application workers on each supported host:

```json
{
  "agentModelPreferences": {
    "codex": { "search": "model-id", "application": "model-id" },
    "claudeCode": { "search": "model-id", "application": "model-id" }
  }
}
```

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

For an owner-requested settings change, inspect the current profile revision and
write only the changed nested keys with `store profile-patch --source user`. Use
`null` to remove one model ID and return that field to the host default. Preserve
other model choices and all unrelated profile fields. A stale revision requires a
fresh inspection and review of the changed choices before retrying. Companion's
Settings view uses the same selective profile patch and conflict handling.
