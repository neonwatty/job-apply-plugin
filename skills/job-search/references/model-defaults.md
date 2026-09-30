# Search model defaults

The canonical profile stores optional durable defaults at `profile.agentModelPreferences`:

```json
{
  "codex": { "search": "model-id", "application": "model-id" },
  "claudeCode": { "search": "model-id", "application": "model-id" }
}
```

Use only the `search` key for the current host (`codex` or `claudeCode`). The `application` keys belong to Job Apply. Read this preference on every search. If the host offers a supported model selector for the active task, use the saved search model before researching; if it cannot change the active model, disclose the mismatch briefly and continue with the active model. An absent or unsupported value leaves the current selection in effect. Do not guess a model identifier, silently switch models, or launch another agent or task. An explicit model choice for this request takes precedence and remains transient unless the owner asks to save it. Check the host's available models before presenting or saving an identifier.

To read the default, use `node "<plugin-root>/apps/companion/command.mjs" store profile-inspect` after Answer Memory's root and QA-route checks. Read only `profile.agentModelPreferences` and the revision. When the owner explicitly asks to save or clear a search default, inspect again immediately before the write and use a permission-restricted temporary JSON input with `profile-patch --input <path> --expected-revision <revision> --source user`. For a Codex search default, the input is `{"agentModelPreferences":{"codex":{"search":"model-id"}}}`; use `claudeCode` for that host or `null` for a requested clear. Remove the input on success or failure. Never replace the whole profile, the host object, or either `application` key. On revision conflict, reload and review the changed preference before retrying. Confirm the saved value from the returned inspection.
