# Setup questions

Use the owner's current message as answers wherever possible. Otherwise ask the
remaining questions together in one concise batch and explain the choices in plain
language.

## Questions and stored values

1. **Preferred browser (Codex only)** — `preferredBrowser`
   - `codex_browser`: the visible browser built into Codex
   - `chrome`: the owner's visible Chrome session
   - In Claude Code, Chrome is the only supported choice. Save `chrome` without
     presenting an unavailable Codex choice.
2. **Unavailable-browser behavior** — `browserFallback`
   - `ask`: pause and ask before switching browser surfaces
   - `other_supported`: use the other currently supported Codex surface when safe
3. **Page transitions** — `progressionMode`
   - `standard`: after action-time consent, advance through controls that are clearly
     non-final, such as Next, Continue, Save, or Review
   - `guided`: pause for the owner before each page transition
4. **Preferred application mode** — `preferredAutomationMode`
   - `guided`: confirm application actions as the form progresses
   - `autofill_to_review`: offer one exact-job grant to fill a prepared application
     through final review
   - `campaign_to_review`: offer one bounded grant to process selected prepared jobs
     sequentially through final review
5. **Optional task models and Codex reasoning effort** — `agentModelPreferences`
   - `codex.search` and `codex.application` propose models for owner-requested,
     top-level local Codex tasks for Job Search and one exact-job Job Apply run.
     `claudeCode.search` selects source research workers and
     `claudeCode.application` selects one exact-job filling worker.
   - Omit or clear a field to use the host's default model at the chosen boundary.
     Ask for these IDs only when the owner wants to configure model defaults; never require them
     to complete ordinary application setup.
   - `codex.searchReasoningEffort` and `codex.applicationReasoningEffort` may be
     `low`, `medium`, or `high`. Omit or clear either for the host default. These
     choices apply to new dedicated tasks, separately from model IDs. Validate
     the resolved model and effort pair against the current Codex host.
   - Job Title Discovery and resume fact extraction run in the active host task;
     no separate model setting applies to them yet.

For an agent-led Codex model or effort change, follow the [Codex model preflight](../../answer-memory/references/agent-model-preferences.md#codex-model-preflight)
before presenting or saving the choice. Check the current host's model list and the
intended task tool's model and effort override support, not just the value format. If unavailable, leave the stored
Codex preference unchanged and offer a supported pair or the host default. A
Codex check cannot validate a Claude Code model. A saved model does not create a
task or change the model or effort of the current task. Companion's settings
cannot inspect either host's live model access; explain that distinction when
helping the owner use Settings.

Describe all three choices and say that every mode stops at final review. A preferred
higher mode controls what the agent offers; it does not authorize filling. At
application time the owner must still approve the exact jobs, expiration, and any
exact sensitive-answer references. Never infer a higher mode from `standard` page
transitions, a queued job, or an earlier conversation.

Do not offer arbitrary browser names. The currently supported Codex choices for this
plugin are the Codex built-in browser and Chrome. A browser explicitly selected in
the owner's current request overrides the saved preference for that application and
does not silently rewrite setup.

## Persistence

After `profile-inspect`, create a permission-restricted temporary JSON object shaped
like this, including only changed keys. A model choice is separate from application
authority; see [agent model preferences](../../answer-memory/references/agent-model-preferences.md):

```json
{
  "applicationPreferences": {
    "preferredBrowser": "codex_browser",
    "browserFallback": "ask",
    "progressionMode": "standard",
    "preferredAutomationMode": "guided"
  },
  "agentModelPreferences": {
    "codex": { "application": "model-id", "applicationReasoningEffort": "medium" }
  }
}
```

Run:

```bash
node "<plugin-root>/apps/companion/command.mjs" store profile-patch \
  --input <private-setup-patch.json> --expected-revision <revision> --source user
```

Remove the input on success or failure. On a revision conflict, inspect the changed
profile and preserve the owner's unsaved choices; do not blindly retry. Never store
browser state, tab identifiers, credentials, authentication data, or blanket consent.
