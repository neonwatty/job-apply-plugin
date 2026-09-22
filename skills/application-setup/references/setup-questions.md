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
like this, including only changed keys:

```json
{
  "applicationPreferences": {
    "preferredBrowser": "codex_browser",
    "browserFallback": "ask",
    "progressionMode": "standard",
    "preferredAutomationMode": "guided"
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
