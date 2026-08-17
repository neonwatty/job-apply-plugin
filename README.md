# Job Apply Plugin for Codex and Claude Code

[![Discord](https://img.shields.io/badge/Discord-Join%20Server-7289da?style=flat&logo=discord&logoColor=white)](https://discord.gg/7xsxU4ZG6A)

AI-powered job application assistant for Claude Code and Codex that fills job applications on LinkedIn Easy Apply, Greenhouse, Ashby, Lever, Rippling, and Workday using visible browser automation.

## Skills

| Skill | Description |
|-------|-------------|
| `job-apply:job-apply` | Fill out job applications automatically using your resume |
| `job-apply:answer-memory` | Safely manage your local profile, reusable answers, application history, and resumable sessions |
| `job-apply:job-search` | Search LinkedIn, Hacker News, and Twitter/X for jobs, then rank results against your preferences |
| `job-apply:job-preferences` | Set the titles, salary, remote-work, and filtering preferences used by job search |

Invoke skills with `$job-apply:...` in Codex or `/job-apply:...` in Claude Code.

## Features

### Job Apply (`job-apply:job-apply`)
- **One-time profile setup**: Extract your information from a resume (PDF, DOCX, or TXT)
- **Guided ATS coverage**: Workflows for LinkedIn Easy Apply, Greenhouse, Ashby, Lever, Rippling, and Workday, with current forms unverified
- **Visible browser automation**: Codex Browser/Chrome or Claude in Chrome fills forms in a session you can see and control
- **Smart field mapping**: Automatically matches your profile to form fields
- **Confidence-aware answer reuse**: Reuses confirmed non-sensitive answers and flags inferred, missing, or sensitive answers for review
- **Resumable progress**: Saves application step metadata and answer references without copying answer values
- **Manual submission**: Stops at final review so only you can click Submit or Send
- **Resume storage**: Profile saved locally for reuse across applications

### Answer Memory (`job-apply:answer-memory`)
- **One local contract**: All Job Apply skills use the same bundled storage helper
- **Reusable answers**: Records confirmed, inferred, missing, and sensitive states with provenance and scope
- **Separate remember consent**: A sensitive answer is never retained merely because it was used in a form
- **Minimal history**: Application events and sessions reference answer keys instead of duplicating values
- **Non-destructive migration**: Imports an existing legacy profile once and leaves the original file untouched

### Job Search (`job-apply:job-search`)
- **Preference-based search**: Searches for the titles, salary range, remote options, and time range you saved
- **Connection insights**: Finds jobs at companies where you have connections
- **Hiring manager discovery**: Identifies jobs with hiring managers listed
- **Multi-source discovery**: Searches LinkedIn, Hacker News Who's Hiring, and Twitter/X
- **Results saved**: Full search results saved to the shared `~/.claude-job-searches/` compatibility directory as Markdown

### Job Preferences (`job-apply:job-preferences`)
- **Reusable search settings**: Save target titles, salary floor, remote preference, exclusion patterns, and time range
- **Shared profile**: Preferences are stored in `~/.job-apply/profile.json` without replacing resume profile data
- **Selective updates**: Change individual preferences while preserving the rest

## Requirements

Choose either supported host:

- **Codex**: Codex CLI or the Codex desktop app, with the Browser plugin enabled for visible navigation, form filling, authenticated Chrome sessions when selected, and local file uploads
- **Claude Code**: [Claude Code](https://claude.ai/code) with [Claude in Chrome](https://chromewebstore.google.com/detail/claude-in-chrome)

Codex stays inside its selected Browser plugin surface. Claude Code does not require Playwright; an already-configured Playwright integration may be used only for one inaccessible iframe or custom control.

## Installation

### Codex

```bash
codex plugin marketplace add neonwatty/job-apply-plugin
codex plugin add job-apply@neonwatty-plugins
```

Start a new Codex task after installation, then invoke `$job-apply:job-apply`.

### Claude Code

```bash
claude plugin marketplace add neonwatty/job-apply-plugin
claude plugin install job-apply@neonwatty-plugins
```

Start a new Claude Code session after installation, then invoke `/job-apply:job-apply`.

## Usage

The examples below use Codex syntax. In Claude Code, replace the leading `$` with `/`.

### First Time Setup

1. Invoke the skill:
   ```
   $job-apply:job-apply
   ```

2. Provide your resume path when prompted:
   ```
   ~/Documents/resume.pdf
   ```

3. Review and confirm extracted profile information

### Applying to Jobs

Once your profile is set up:

1. Invoke the skill:
   ```
   $job-apply:job-apply
   ```

2. Provide a job URL:
   ```
   https://www.linkedin.com/jobs/view/123456789
   ```

3. Watch as the agent fills the application from your reviewed local profile

4. Inspect the final review page and the field summary, then click Submit or Send yourself if everything is correct

### Searching for Jobs

First run `$job-apply:job-preferences` to save your search preferences. Then use `$job-apply:job-search` to search LinkedIn, Hacker News, and Twitter/X and rank matching jobs:

1. Set or update your preferences:
   ```
   $job-apply:job-preferences
   ```

2. Invoke the search skill:
   ```
   $job-apply:job-search
   ```

3. Review the active search configuration loaded from your preferences:
   ```
   Search config:
   - Titles: Senior Software Engineer, Staff Engineer
   - Salary floor: $200K
   - Remote: Remote preferred
   - Time range: Last week
   - Sources: LinkedIn, HN, Twitter
   ```

4. Review ranked results, including:
   - Jobs with hiring managers listed (highest priority)
   - Jobs with 1st-degree connections
   - Matching Hacker News and Twitter/X opportunities

Results are automatically saved to `~/.claude-job-searches/`. Both Codex and Claude Code use this legacy-compatible path.

## Compatibility and Verification Status

The plugin includes guided workflows for six ATS families. Codex and Claude Code host instructions were reviewed on **2026-07-28**. Live end-to-end ATS acceptance is tracked separately; individual flows remain unverified and may drift as sites change.

| Platform | URL Pattern | Default browser path | Verification status |
|----------|-------------|----------------------|---------------------|
| LinkedIn Easy Apply | `linkedin.com/jobs/view/*` | Codex Browser or Claude in Chrome | Guided; current ATS flow unverified |
| Greenhouse | `boards.greenhouse.io/*` | Codex Browser or Claude in Chrome | Guided; current ATS flow unverified |
| Ashby | `jobs.ashbyhq.com/*` | Codex Browser or Claude in Chrome | Guided; closed replay lane supported |
| Lever | `jobs.lever.co/*` | Codex Browser or Claude in Chrome | Guided; closed replay lane supported |
| Rippling | `*.rippling.com/*` | Codex Browser or Claude in Chrome | Guided; current ATS flow unverified |
| Workday | `*.myworkdayjobs.com/*` | Codex Browser or Claude in Chrome | Guided; current ATS flow unverified |

## Profile Storage

Job Apply stores data as **plaintext local files** under `~/.job-apply/`:

```text
~/.job-apply/
  profile.json
  answers.json
  applications.jsonl
  sessions/
    <application-id>.json
```

| File | Purpose |
|------|---------|
| `profile.json` | Resume facts and job-search preferences |
| `answers.json` | Reusable answers with confirmation, source, scope, and sensitivity state |
| `applications.jsonl` | Minimal append-only application lifecycle events |
| `sessions/*.json` | Resumable workflow metadata and answer-key references |

These files can include sensitive personal information such as:

- Personal information (name, email, phone, location)
- Work history
- Education
- Skills
- Social links (LinkedIn, GitHub, portfolio)

The repository contains no telemetry or analytics integration, and the store is not uploaded to a plugin service. It remains on your computer until you direct Codex or Claude Code to use values in browser forms or searches; those third-party sites receive the information you choose to enter there.

Protect the directory like a resume. Do not attach its files to issues or share them in logs. The helper creates user-only permissions on supported systems. On macOS or Linux, you can verify or restore them with:

```bash
chmod 700 ~/.job-apply
chmod 600 ~/.job-apply/profile.json ~/.job-apply/answers.json ~/.job-apply/applications.jsonl
```

On first use, an existing `~/.claude-job-profile.json` is copied into the new versioned profile without modifying or deleting the legacy file. Once `~/.job-apply/profile.json` exists it is authoritative; later legacy-file changes are not re-imported. Verify the new profile before deciding whether to archive or remove the old file.

All plugin skills access this data through the bundled `scripts/job-apply-store.py` helper. Canonical JSON updates are atomic, corrupt or future-version files fail closed, and application history and sessions do not duplicate reusable answer values.

Only matching, non-sensitive `confirmed` answers may be reused without asking. Inferred and missing answers require review. Sensitive answers are reconfirmed before every use and are stored only when you separately ask Job Apply to remember that specific value.

To replace the stored profile from a new resume:
```
$job-apply:job-apply reset profile
```

To remove Job Apply data, close Codex or Claude Code and first move the directory to a private backup so recovery remains possible, for example `mv ~/.job-apply ~/.job-apply.backup`. Shared search-result Markdown files are separate under `~/.claude-job-searches/`; review them independently. The legacy `~/.claude-job-profile.json` is also separate and is never deleted automatically.

## Search Results Storage

Job search results from both Codex and Claude Code are saved to the legacy-compatible `~/.claude-job-searches/` path with timestamped filenames:

```
~/.claude-job-searches/
  search-2026-01-06T10-30-00.md
  search-2026-01-07T14-15-00.md
```

Each file contains:
- Search parameters (keywords, location, filters)
- List of jobs with full details
- Connection and hiring manager information
- Priority ranking

## Safety Features

- **Never handles credentials** - Pauses for you to complete login, password, CAPTCHA, or MFA steps
- **Never creates accounts** - Pauses so you can decide whether to create an account yourself
- **Never submits applications** - Stops at final review, summarizes entered fields, and leaves Submit or Send for you
- **Never enters payment info** - Skips premium features
- **Confirms sensitive questions** - Salary, visa status, etc.
- **Separates use from storage consent** - Filling a sensitive answer once never automatically remembers it

## Setup Check and Troubleshooting

Before applying:

1. In Codex, enable the Browser plugin and select its visible browser surface. In Claude Code, connect Claude in Chrome.
2. Sign in to the job site yourself in the visible tab you want the agent to use.
3. Keep your resume at a readable local path, then run `$job-apply:job-apply` in Codex or `/job-apply:job-apply` in Claude Code and provide a test or intended job URL.
4. Confirm the agent can read the page before allowing it to fill any fields.

If the skill cannot see the page, reconnect the active browser surface and refresh the tab. If login, CAPTCHA, MFA, or account creation appears, complete it yourself and then tell the agent to continue. ATS markup changes frequently; if the browser cannot reach an iframe, upload widget, or custom control, complete the remaining field manually. Claude Code may also use an already-configured Playwright integration for one blocked control. The plugin does not bypass blocked controls or guarantee every form on a platform will work.

## Get Help or Share Feedback

- [Ask for setup help](https://github.com/neonwatty/job-apply-plugin/issues/new?template=setup-help.yml)
- [Report a redacted ATS failure](https://github.com/neonwatty/job-apply-plugin/issues/new?template=ats-failure.yml)
- [Request an improvement](https://github.com/neonwatty/job-apply-plugin/issues/new?template=feature-request.yml)

Before posting, remove names, email addresses, phone numbers, resume content, credentials, passwords, full application URLs, and other applicant data. The issue forms include a required redaction acknowledgment.

## License

MIT License - See [LICENSE](LICENSE) for details.

## Replay QA (developers)

Replay fixtures are built from a tightly controlled, private recording and checked in only after they have been reduced to a generic semantic model. Follow these policies:

1. Record a source application only for a genuine application the user already intends to make, and only after the user logs in manually.
2. Start Chrome through the replay QA launcher with a dedicated named profile; never use an everyday Chrome profile or an ad hoc debugging command.
3. Record and annotate the walkthrough only under `.qa-private/`.
4. Compile the capture, inspect every entry in `review-manifest.json`, explicitly approve the reviewed candidate, and then promote it.
5. Confirm the complete raw session was deleted before staging anything.
6. Run the deterministic checks before preparing a supervised advisory replay through the normal Job Apply skill in a visible host session.
7. Never commit source URLs, employer or job identity, screenshots, DOM, applicant values, resumes, cookies, tokens, or raw reports.

Choose a lowercase, hyphenated profile name and reuse it for a given QA identity. The launcher keeps its credential-bearing Chrome profiles and runtime state under the current user's home directory, outside the repository. They are never included in the plugin package. Chrome may ask for normal macOS Keychain access when the profile first stores or reuses authentication; handle that prompt yourself, and never put a password or Keychain secret in a command or recording.

Start the named profile, then confirm that its authenticated supervisor and dynamic loopback CDP endpoint are ready:

```bash
python3 scripts/qa-chrome.py start --profile linkedin-capture
python3 scripts/qa-chrome.py check --profile linkedin-capture
```

Both commands return a small JSON status. When ready, use the `recorderCommand` emitted by the launcher; it contains the verified current CDP URL and a placeholder for a unique private session ID. Do not substitute a remembered port or launch Chrome directly with remote-debugging flags.

In the launched Chrome window, manually sign in and complete any password, CAPTCHA, MFA, or Keychain prompts. Manually choose the genuine job application the user already intends to make, close unrelated tabs, and leave exactly that ordinary application page open. Only then replace the emitted command's session placeholder and run that emitted command on the application page. For example, the output directory may be `.qa-private/qa-session-20260811-001`.

Record and annotate the walkthrough under `.qa-private/`. In a second terminal, use the checkpoint command after the emitted recorder command is running:

```bash
node qa/recorder.mjs checkpoint --session .qa-private/qa-session-20260811-001 --kind application-opened
```

Add checkpoints as the application advances, ending with `review-reached` and `final-action-boundary`. The recorder must never be used on a login, password, CAPTCHA, or MFA page.

While the recorder is still running, draft `.qa-private/qa-session-20260811-001/semantic.json` from the checkpoint control inventories. It is a private annotation file and must use one of the compiler's closed platform profiles. The original LinkedIn Easy Apply short profile has this exact order:

```json
{
  "captureId": "COPY_FROM_CAPTURE_RECEIPT",
  "platformFamily": "linkedin-easy-apply",
  "captureMonth": "COPY_FROM_CAPTURE_RECEIPT",
  "sourceDeniedTerms": ["SOURCE_EMPLOYER_OR_OTHER_TERM_TO_BLOCK"],
  "steps": [
    {
      "checkpoint": "application-opened",
      "controls": [
        {"kind": "contact.first_name", "sourceLabel": "Observed first-name label", "required": true},
        {"kind": "contact.last_name", "sourceLabel": "Observed last-name label", "required": true},
        {"kind": "contact.email", "sourceLabel": "Observed email label", "required": true},
        {"kind": "contact.phone", "sourceLabel": "Observed phone label", "required": true}
      ]
    },
    {
      "checkpoint": "step-advanced",
      "controls": [
        {"kind": "resume.file", "sourceLabel": "Observed resume label", "required": true}
      ]
    },
    {
      "checkpoint": "review-reached",
      "controls": [],
      "finalActionObserved": true
    }
  ]
}
```

LinkedIn applications that source name details from the member profile and add the observed screening steps must instead use this exact five-step profile:

```json
{
  "captureId": "COPY_FROM_CAPTURE_RECEIPT",
  "platformFamily": "linkedin-easy-apply",
  "captureMonth": "COPY_FROM_CAPTURE_RECEIPT",
  "sourceDeniedTerms": ["SOURCE_EMPLOYER_OR_OTHER_TERM_TO_BLOCK"],
  "steps": [
    {"checkpoint": "application-opened", "controls": [
      {"kind": "contact.email", "sourceLabel": "Observed email label", "required": true},
      {"kind": "contact.phone", "sourceLabel": "Observed phone label", "required": true}
    ]},
    {"checkpoint": "step-advanced", "controls": [
      {"kind": "resume.file", "sourceLabel": "Observed resume label", "required": true}
    ]},
    {"checkpoint": "step-advanced", "controls": [
      {"kind": "preference.top_choice", "sourceLabel": "Observed top-choice label", "required": false}
    ]},
    {"checkpoint": "step-advanced", "controls": [
      {"kind": "authorization.sponsorship", "sourceLabel": "Observed sponsorship question", "required": true}
    ]},
    {"checkpoint": "review-reached", "controls": [], "finalActionObserved": true}
  ]
}
```

A single-page Greenhouse application must use this exact two-step profile. The catalog generates the generic labels and choices; keep employer wording, the source URL, and applicant values out of the annotation controls:

```json
{
  "captureId": "COPY_FROM_CAPTURE_RECEIPT",
  "platformFamily": "greenhouse",
  "captureMonth": "COPY_FROM_CAPTURE_RECEIPT",
  "sourceDeniedTerms": ["SOURCE_EMPLOYER_OR_OTHER_TERM_TO_BLOCK"],
  "steps": [
    {
      "checkpoint": "application-opened",
      "controls": [
        {"kind": "contact.first_name", "sourceLabel": "Observed first-name label", "required": true},
        {"kind": "contact.last_name", "sourceLabel": "Observed last-name label", "required": true},
        {"kind": "contact.preferred_name", "sourceLabel": "Observed preferred-name label", "required": false},
        {"kind": "contact.email", "sourceLabel": "Observed email label", "required": true},
        {"kind": "contact.phone_country", "sourceLabel": "Observed phone-country label", "required": true},
        {"kind": "contact.phone", "sourceLabel": "Observed phone label", "required": true},
        {"kind": "contact.location_city", "sourceLabel": "Observed city label", "required": true},
        {"kind": "resume.file", "sourceLabel": "Observed resume label", "required": true},
        {"kind": "cover_letter.file", "sourceLabel": "Observed cover-letter label", "required": false},
        {"kind": "profile.linkedin", "sourceLabel": "Observed LinkedIn-profile label", "required": true},
        {"kind": "profile.website", "sourceLabel": "Observed website label", "required": false},
        {"kind": "authorization.sponsorship_select", "sourceLabel": "Observed sponsorship question", "required": true},
        {"kind": "employment.prior_affiliate", "sourceLabel": "Observed prior-employment question", "required": true},
        {"kind": "source.discovery", "sourceLabel": "Observed discovery-source question", "required": true},
        {"kind": "referral.contact", "sourceLabel": "Observed referral label", "required": false}
      ]
    },
    {
      "checkpoint": "review-reached",
      "controls": [],
      "finalActionObserved": true
    }
  ]
}
```

A supported single-page Ashby application uses the same two-step lifecycle with exactly three required controls. The compiler accepts no other Ashby control, order, or required-state combination:

```json
{
  "captureId": "COPY_FROM_CAPTURE_RECEIPT",
  "platformFamily": "ashby",
  "captureMonth": "COPY_FROM_CAPTURE_RECEIPT",
  "sourceDeniedTerms": ["SOURCE_EMPLOYER_OR_OTHER_TERM_TO_BLOCK"],
  "steps": [
    {
      "checkpoint": "application-opened",
      "controls": [
        {"kind": "contact.full_name", "sourceLabel": "PRIVATE_REVIEW_ONLY_LABEL", "required": true},
        {"kind": "contact.email", "sourceLabel": "PRIVATE_REVIEW_ONLY_LABEL", "required": true},
        {"kind": "resume.file", "sourceLabel": "PRIVATE_REVIEW_ONLY_LABEL", "required": true}
      ]
    },
    {
      "checkpoint": "review-reached",
      "controls": [],
      "finalActionObserved": true
    }
  ]
}
```

A supported single-page Lever replay also uses the application-form-to-review lifecycle. Its compiler profile is closed to the exact ordered, value-free controls recorded for `lever-complete-profile`: resume and contact fields; optional company and profile links; work authorization; discovery and compensation; prior-company, conflict, and location questions; optional citizenship; and optional EEO controls. Roles, requiredness, and every generic choice list are catalog-owned. Reordering a control, changing requiredness, adding a control, or changing a choice is rejected. The final Submit control remains enabled only behind the local QA tripwire and must stay untouched during review-only replay.

After the final checkpoint and draft annotation, press `Ctrl-C` once in the recorder terminal and wait for it to exit cleanly. Do not force-kill it: clean shutdown removes the private control file and writes `capture-receipt.json`, including the generated `captureId`, capture month, recorder version, and hashes of the private source files.

Only after the recorder has exited cleanly, stop the launcher-owned Chrome child:

```bash
python3 scripts/qa-chrome.py stop --profile linkedin-capture
```

Normal `stop` preserves the named profile, including its login state, for the next `start`. `reset` is a non-mutating guidance command. Run it only after `stop` when you are considering discarding that retained authentication and other profile state:

```bash
python3 scripts/qa-chrome.py reset --profile linkedin-capture
```

When the profile is safely stopped and its managed state is unambiguous, the command makes no filesystem changes and returns `~/.job-apply-qa/chrome-profiles/linkedin-capture` as the exact dedicated directory. It does not open Trash, inspect profile contents, move, rename, or delete anything. If the profile is active or state is ambiguous, it returns an error without presenting removal as safe; stop the launcher-owned Chrome window or resolve the ambiguous state first.

Removing the directory is a separate, user-owned manual action. In Finder, use **Go to Folder** with the exact tilde-form path emitted by `reset`, verify that it is the intended dedicated QA profile, and move that directory to Trash yourself. If you instead choose a terminal removal workflow, target only that exact emitted directory and run it yourself. The launcher never performs or authorizes either removal action and requires no Trash permission.

Replace the two placeholders by copying `captureId` and `captureMonth` exactly from the recorder-generated receipt. `sourceLabel` and `sourceDeniedTerms` may contain private source wording because `semantic.json` is deleted with the raw session, but do not copy applicant input values into it. The compiler accepts no extra properties, mixed profiles, or alternate step/control order.

Compile the private capture, inspect every entry in `review-manifest.json`, explicitly approve the reviewed candidate, and promote it:

```bash
python3 -m qa.promote compile --capture .qa-private/qa-session-20260811-001 --fixture-id linkedin-easy-apply-short-2026-08-v1 --candidate .qa-private/qa-session-20260811-001/candidate
python3 -m qa.promote approve --candidate .qa-private/qa-session-20260811-001/candidate --reviewer qa-owner
python3 -m qa.promote promote --candidate .qa-private/qa-session-20260811-001/candidate --destination qa/fixtures
```

Before staging anything, confirm that promotion deleted the complete `.qa-private/qa-session-20260811-001` source session.

Run the deterministic checks, then prepare a supervised advisory replay through the normal Job Apply skill in a visible host session:

```bash
npm ci
npx playwright install --with-deps chromium
python3 -m unittest discover -s tests -v
npm run test:qa-screening
npm run test:qa-browser
bash scripts/smoke-plugin.sh
bash scripts/check-links.sh
git diff --check
python3 scripts/qa-replay.py prepare --fixture linkedin-easy-apply-screening-2026-08-v1 --scenario linkedin-screening
python3 scripts/qa-replay.py started --run-id GENERATED_RUN_ID
python3 scripts/qa-replay.py reviewed --run-id GENERATED_RUN_ID
python3 scripts/qa-replay.py evaluate --run-id GENERATED_RUN_ID
```

`prepare` prints the same five fields for every supported fixture, with platform-correct Ashby, Greenhouse, or LinkedIn guidance, a unique route fragment, and a unique run ID. It only prepares local instructions; it never launches an agent. The host resolves the route to the isolated store with `python3 scripts/qa-replay.py resolve --route-token 'GENERATED_RUN_ID.GENERATED_ROUTE_TOKEN'`, records `started` before filling, and records `reviewed` only after the visible fixture reaches its review event with zero final-action activations. Both lifecycle commands are idempotent and write only value-free history/session metadata through the existing store helper. Then run `evaluate`. After evaluation—or to abandon an interrupted run—sanitize the run with `python3 scripts/qa-replay.py cleanup --run-id GENERATED_RUN_ID`. Cleanup leaves a minimal tombstone; completed runs retain only the redacted report, while abandoned runs retain no report. The dated IDs above are examples; use the generated ID for every lifecycle, evaluation, and cleanup command.

The committed `linkedin-screening` review lane remains wholly synthetic and requires zero final-action activations. A second repeatable loopback verifier exercises the high-risk Auto-submit state machine at the policy-coupled activation boundary, including actual review-only refusal, kill/expiry and concurrency races, forged/stale/prompt/redirect denial, all runtime stops, redaction, one-winner success with independent confirmation, and terminal one-retry uncertainty:

```bash
python3 scripts/qa-replay.py verify-auto-submit --fixture qa/fixtures/linkedin-easy-apply-screening-2026-08-v1/fixture.json --json
```

That verifier uses only `127.0.0.1`, a private per-run capability, opaque identities, and redacted reports. It does not contact LinkedIn, authenticate, use applicant data, or authorize a live action. A real canary remains a separate audited and exactly approved step.

## Contributing

Contributions welcome! Please open an issue or PR on GitHub.

Before opening a PR, run the same deterministic checks used by CI:

```bash
npm ci
npx playwright install --with-deps chromium
python3 -m unittest discover -s tests -v
npm run test:qa-screening
npm run test:qa-browser
bash scripts/smoke-plugin.sh
bash scripts/check-links.sh
git diff --check
```

The smoke test installs temporary working-tree fixtures under isolated Codex and Claude Code configuration directories and removes them on exit. It does not alter your normal host configuration.

## Author

Jeremy Watt ([@neonwatty](https://github.com/neonwatty))
