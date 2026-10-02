# Search model defaults

When Agent Model Settings support is installed, the canonical profile stores optional durable defaults at `profile.agentModelPreferences`. Read the shared [task-key contract](../../answer-memory/references/agent-model-preferences.md) before changing a model choice:

```json
{
  "codex": { "search": "model-id", "application": "model-id" },
  "claudeCode": { "search": "model-id", "application": "model-id" }
}
```

Use only the `search` key for the current host (`codex` or `claudeCode`). The `application` keys belong to Job Apply. Read this preference on every search. It cannot change the active task model or grant browser access. An explicit model choice for this request takes precedence and remains transient unless the owner asks to save it.

For browser-bound Codex desktop search, use the current top-level task's model unless the owner explicitly asks for a separate task. A saved `codex.search` value supplies the model for an owner-requested task; it does not itself create one. A current-request model overrides it. Before creation, repeat the shared [Codex model preflight](../../answer-memory/references/agent-model-preferences.md#codex-model-preflight) for the top-level task tool. Resolve the local project through the host's project list, then create one local task with that exact model; do not request a worktree for search. The launch prompt contains the requested sources and public filters, a direction to run this skill, and a direction to read private criteria from the canonical Store inside the new task. Exclude applicant values, resume paths, credentials, claim tokens, and browser state. The new task owns its visible browser, reads the Store itself, and does not create another task. Follow its progress through the host's task wait facility. If creation or browser access fails, report the failure without silently replacing the model or spawning a browser-bound subagent. Research in the current task is available only if the owner chooses its active model.

Claude Code may use source research workers when its browser access and model override are available. Verify host support before launch. Codex source workers are permitted only when their own source access is verified; a model override alone is insufficient. An absent preference uses the host default at the chosen task or worker boundary. Do not guess an ID or silently substitute another model.

To read the default, use `node "<plugin-root>/apps/companion/command.mjs" store profile-inspect` after Answer Memory's root and QA-route checks. Read only `profile.agentModelPreferences` and the revision. Do not write this field when Agent Model Settings support is unavailable; report that the saved setting cannot be changed through the installed version. When support is available and the owner explicitly asks to save or clear a search default, inspect again immediately before the write and use a permission-restricted temporary JSON input with `profile-patch --input <path> --expected-revision <revision> --source user`. For a Codex search default, the input is `{"agentModelPreferences":{"codex":{"search":"model-id"}}}`; use `claudeCode` for that host or `null` for a requested clear. Remove the input on success or failure. Never replace the whole profile, the host object, or either `application` key. On revision conflict, reload and review the changed preference before retrying. Confirm the saved value from the returned inspection.
