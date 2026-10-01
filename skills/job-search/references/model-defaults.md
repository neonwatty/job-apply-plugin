# Search model defaults

When Agent Model Settings support is installed, the canonical profile stores optional durable defaults at `profile.agentModelPreferences`:

```json
{
  "codex": { "search": "model-id", "application": "model-id" },
  "claudeCode": { "search": "model-id", "application": "model-id" }
}
```

Use only the `search` key for the current host (`codex` or `claudeCode`). The `application` keys belong to Job Apply. These are worker model preferences, not a way to change the active host task model. Read this preference on every search. If permitted source workers are used, verify that the host supports the saved model and its worker facility accepts a model override before launching them. If either check fails, explain the unavailable choice and obtain an alternative before launching workers; the host may still research directly with its active model. An absent value uses the host's normal worker model. Do not guess an identifier, silently substitute a model, or launch a worker solely to change models. An explicit model choice for this request takes precedence and remains transient unless the owner asks to save it. Check the host's available models before presenting or saving an identifier.

To read the default, use `node "<plugin-root>/apps/companion/command.mjs" store profile-inspect` after Answer Memory's root and QA-route checks. Read only `profile.agentModelPreferences` and the revision. Do not write this field when Agent Model Settings support is unavailable; report that the saved setting cannot be changed through the installed version. When support is available and the owner explicitly asks to save or clear a search default, inspect again immediately before the write and use a permission-restricted temporary JSON input with `profile-patch --input <path> --expected-revision <revision> --source user`. For a Codex search default, the input is `{"agentModelPreferences":{"codex":{"search":"model-id"}}}`; use `claudeCode` for that host or `null` for a requested clear. Remove the input on success or failure. Never replace the whole profile, the host object, or either `application` key. On revision conflict, reload and review the changed preference before retrying. Confirm the saved value from the returned inspection.
