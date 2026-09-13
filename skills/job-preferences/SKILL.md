---
name: job-preferences
description: Set or update the user's saved job-search criteria.
allowed-tools: Read, Write, Bash
---

# Job Preferences

Read [answer-memory](../answer-memory/SKILL.md) for root resolution, initialization, private inputs, and revision handling. Use `python3 "<plugin-root>/scripts/job-apply-store.py" profile-inspect` to obtain `profile.preferences` and its revision.

Apply changes already specified in the current request without asking whether the user wants to make them. Ask only about missing or ambiguous values needed for that change. If the user asks to view preferences, show the saved preferences without starting a questionnaire. If no preferences exist, accept a partial set; do not require salary or every other field before saving useful criteria.

Supported fields are `targetTitles` (string array), `minBaseSalary` (string), `remotePreference` (string), `excludePatterns` (string array), and `defaultTimeRange` (string). Use user-supplied criteria, not example job titles, salary floors, or seniority defaults. Transient search overrides do not change saved preferences unless the user requests it.

Write only changed keys to a permission-restricted temporary JSON object, then run:

```bash
python3 "<plugin-root>/scripts/job-apply-store.py" preferences-set \
  --input <private-preferences.json> --expected-revision <inspected-revision> --source user
```

Remove the input on success or failure. This merges keys while preserving unrelated preferences and profile facts; do not pass `--replace` for a selective change. On a revision conflict, inspect the changed state, preserve the intended edit, and resolve the conflict with the owner before reapplying it.

Confirm the saved criteria from the returned inspection. They are the same canonical preferences shown in Companion's Facts surface and used by job-search. Saving preferences grants no application or external transmission authority.
