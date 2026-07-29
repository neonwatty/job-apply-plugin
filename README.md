# Job Apply Plugin for Codex and Claude Code

[![Discord](https://img.shields.io/badge/Discord-Join%20Server-7289da?style=flat&logo=discord&logoColor=white)](https://discord.gg/7xsxU4ZG6A)

Local-first job application assistant for Codex and Claude Code that fills supported ATS forms in a visible browser and stops before Submit or Send.

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
| Ashby | `jobs.ashbyhq.com/*` | Codex Browser or Claude in Chrome | Guided; current ATS flow unverified |
| Lever | `jobs.lever.co/*` | Codex Browser or Claude in Chrome | Guided; current ATS flow unverified |
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

## Contributing

Contributions welcome! Please open an issue or PR on GitHub.

Before opening a PR, run the same deterministic checks used by CI:

```bash
bash scripts/smoke-plugin.sh
bash scripts/check-links.sh
claude plugin validate .
python3 /path/to/plugin-creator/scripts/validate_plugin.py .
git diff --check
```

The smoke test installs temporary working-tree fixtures under isolated Codex and Claude Code configuration directories and removes them on exit. It does not alter your normal host configuration.

## Author

Jeremy Watt ([@neonwatty](https://github.com/neonwatty))
