---
name: job-preferences
description: Set or update your job search preferences (titles, salary, remote, filters). Used by /job-apply:job-search and other skills.
allowed-tools: Read, Write, Bash
---

# Job Preferences

A Claude Code skill for managing persistent job search preferences. Set your target titles, salary floor, remote preference, and exclusion filters once — `/job-apply:job-search` and other skills reuse them automatically.

---

## Workflow

### Step 1: Load Profile

Follow `/job-apply:answer-memory`: run `python3 "${CLAUDE_PLUGIN_ROOT}/scripts/job-apply-store.py" init`, then load saved preferences with `preferences-get`. Never read or write persistent Job Apply files directly.

### Step 2: Check for Existing Preferences

Use the JSON object returned by `preferences-get`.

**If preferences exist**, display them:

> **Your current job search preferences:**
>
> - **Target titles**: Staff AI Engineer, Principal ML Engineer
> - **Min base salary**: $250K
> - **Remote preference**: Remote only
> - **Exclude patterns**: junior, associate, intern, entry level
> - **Default time range**: last week
>
> Would you like to update any of these?

Then wait for the user. If they say no, stop. If they want to update, ask only about the fields they want to change using `AskUserQuestion`.

**If no preferences exist**, run the full Q&A below.

### Step 3: Collect Preferences (full Q&A)

Use `AskUserQuestion` to collect all fields. Ask up to 4 questions at a time (the tool's limit).

**Question batch 1:**

1. **Target titles** (multi-select + custom)
   - Header: "Titles"
   - Question: "Which job titles are you targeting?"
   - Options: Staff AI Engineer, Principal ML Engineer, Director of AI, Head of ML
   - Multi-select: true
   - The user can add custom titles via "Other"

2. **Min base salary**
   - Header: "Salary"
   - Question: "What is your minimum base salary?"
   - Options: $200K, $250K, $300K
   - Multi-select: false

3. **Remote preference**
   - Header: "Remote"
   - Question: "What is your remote work preference?"
   - Options: Remote only, Remote preferred, Open to hybrid, Open to all
   - Multi-select: false

4. **Exclude patterns** (multi-select)
   - Header: "Exclude"
   - Question: "Which patterns should be excluded from results?"
   - Options: junior, associate, intern, entry level
   - Multi-select: true

**Question batch 2:**

5. **Default time range**
   - Header: "Time range"
   - Question: "What default time range should job searches use?"
   - Options: Last week, 2 weeks, Month
   - Multi-select: false

### Step 4: Save Preferences

Write the collected values to a private temporary JSON object, then call `preferences-set --input <preferences.json>` through the bundled helper and remove the temporary file. The helper merges supplied keys while preserving the rest of the preferences and profile. Never patch `profile.json` directly.

**Schema:**

```json
{
  "preferences": {
    "targetTitles": ["Staff AI Engineer", "Principal ML Engineer"],
    "minBaseSalary": "$250K",
    "remotePreference": "remote only",
    "excludePatterns": ["junior", "associate", "intern", "entry level"],
    "defaultTimeRange": "last week"
  }
}
```

### Step 5: Confirm

Display the saved preferences and confirm:

> **Preferences saved to your local Job Apply store at `~/.job-apply/profile.json`.**
>
> These will be used automatically by `/job-apply:job-search`. Run `/job-apply:job-preferences` again any time to update them.

---

## Updating Preferences

When the user runs `/job-apply:job-preferences` and preferences already exist, show current values and let them update selectively. Only overwrite the fields they change — keep the rest intact.

---

## Safety Rules

1. **Use only the helper** — initialize, read, and merge preferences through `/job-apply:answer-memory`; never directly edit files under `~/.job-apply/`
2. **Preserve existing profile** — use `preferences-set` without `--replace` for selective updates
3. **No defaults without user input** — always ask the user, never assume values
