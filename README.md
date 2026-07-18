# Job Apply Plugin for Claude Code

[![Discord](https://img.shields.io/badge/Discord-Join%20Server-7289da?style=flat&logo=discord&logoColor=white)](https://discord.gg/7xsxU4ZG6A)

AI-powered job application assistant that automatically fills out job applications on LinkedIn Easy Apply, Greenhouse, Ashby, Lever, Rippling, and Workday using browser automation.

## Skills

| Skill | Description |
|-------|-------------|
| `/job-apply:job-apply` | Fill out job applications automatically using your resume |
| `/job-apply:job-search` | Search LinkedIn, Hacker News, and Twitter/X for jobs, then rank results against your preferences |
| `/job-apply:job-preferences` | Set the titles, salary, remote-work, and filtering preferences used by job search |

## Features

### Job Apply (`/job-apply:job-apply`)
- **One-time profile setup**: Extract your information from a resume (PDF, DOCX, or TXT)
- **Guided ATS coverage**: Workflows for LinkedIn Easy Apply, Greenhouse, Ashby, Lever, Rippling, and Workday, with current forms unverified
- **Visible browser automation**: Claude in Chrome fills forms in the browser session you can see and control
- **Smart field mapping**: Automatically matches your profile to form fields
- **Manual submission**: Stops at final review so only you can click Submit or Send
- **Resume storage**: Profile saved locally for reuse across applications

### Job Search (`/job-apply:job-search`)
- **Preference-based search**: Searches for the titles, salary range, remote options, and time range you saved
- **Connection insights**: Finds jobs at companies where you have connections
- **Hiring manager discovery**: Identifies jobs with hiring managers listed
- **Multi-source discovery**: Searches LinkedIn, Hacker News Who's Hiring, and Twitter/X
- **Results saved**: Full search results saved to `~/.claude-job-searches/` as Markdown

### Job Preferences (`/job-apply:job-preferences`)
- **Reusable search settings**: Save target titles, salary floor, remote preference, exclusion patterns, and time range
- **Shared profile**: Preferences are stored in `~/.claude-job-profile.json` without replacing resume profile data
- **Selective updates**: Change individual preferences while preserving the rest

## Requirements

- [Claude Code](https://claude.ai/code) CLI
- [Claude in Chrome](https://chromewebstore.google.com/detail/claude-in-chrome) for visible browser navigation, authenticated sessions, form filling, and local file uploads

Playwright is not required. If you already have a Playwright integration configured, the skill may use it as a fallback when Chrome cannot reach a site-specific iframe or control. Otherwise, it leaves that field for you to complete manually.

## Installation

```bash
claude plugin marketplace add neonwatty/job-apply-plugin
claude plugin install job-apply@neonwatty-plugins
```

## Usage

### First Time Setup

1. Invoke the skill:
   ```
   /job-apply:job-apply
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
   /job-apply:job-apply
   ```

2. Provide a job URL:
   ```
   https://www.linkedin.com/jobs/view/123456789
   ```

3. Watch as Claude fills out the application

4. Inspect the final review page and the field summary, then click Submit or Send yourself if everything is correct

### Searching for Jobs

First run `/job-apply:job-preferences` to save your search preferences. Then use `/job-apply:job-search` to search LinkedIn, Hacker News, and Twitter/X and rank matching jobs:

1. Set or update your preferences:
   ```
   /job-apply:job-preferences
   ```

2. Invoke the search skill:
   ```
   /job-apply:job-search
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

Results are automatically saved to `~/.claude-job-searches/`.

## Compatibility and Verification Status

The plugin includes guided workflows for six ATS families. Repository instructions and Claude in Chrome guidance were reviewed on **2026-07-18**, but this pass did not submit live applications or verify every current ATS form. Individual flows remain unverified and may drift as sites change.

| Platform | URL Pattern | Default browser path | Verification status |
|----------|-------------|----------------------|---------------------|
| LinkedIn Easy Apply | `linkedin.com/jobs/view/*` | Claude in Chrome | Guided; current ATS flow unverified |
| Greenhouse | `boards.greenhouse.io/*` | Claude in Chrome | Guided; current ATS flow unverified |
| Ashby | `jobs.ashbyhq.com/*` | Claude in Chrome | Guided; current ATS flow unverified |
| Lever | `jobs.lever.co/*` | Claude in Chrome | Guided; current ATS flow unverified |
| Rippling | `*.rippling.com/*` | Claude in Chrome | Guided; current ATS flow unverified |
| Workday | `*.myworkdayjobs.com/*` | Claude in Chrome | Guided; current ATS flow unverified |

## Profile Storage

Your profile is stored as **plaintext** at `~/.claude-job-profile.json` and includes sensitive personal information such as:

- Personal information (name, email, phone, location)
- Work history
- Education
- Skills
- Social links (LinkedIn, GitHub, portfolio)

The repository contains no telemetry or analytics integration, and the profile file is not uploaded to a plugin service. It remains on your computer until you direct Claude to use its values in browser forms or searches; those third-party sites receive the information you choose to enter there.

Protect the file like a resume. Do not attach it to issues or share it in logs. On macOS or Linux, you can restrict access to your user account:

```bash
chmod 600 ~/.claude-job-profile.json
```

To replace the stored profile from a new resume:
```
/job-apply:job-apply reset profile
```

To delete it completely, close Claude Code and remove only that file with `rm -i ~/.claude-job-profile.json`. Search-result Markdown files are separate under `~/.claude-job-searches/`; review and remove them independently if needed.

## Search Results Storage

Job search results are saved to `~/.claude-job-searches/` with timestamped filenames:

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

## Setup Check and Troubleshooting

Before applying:

1. Open Chrome and confirm Claude in Chrome is installed, enabled, and connected to Claude Code.
2. Sign in to the job site yourself in the Chrome tab you want Claude to use.
3. Keep your resume at a readable local path, then run `/job-apply:job-apply` and provide a test or intended job URL.
4. Confirm Claude can read the page before allowing it to fill any fields.

If the skill cannot see the page, reconnect Claude in Chrome and refresh the tab. If login, CAPTCHA, MFA, or account creation appears, complete it yourself and then tell Claude to continue. ATS markup changes frequently; if Chrome cannot reach an iframe, upload widget, or custom control, use an already-configured Playwright integration as an optional fallback or complete the remaining field manually. The plugin does not bypass blocked controls or guarantee every form on a platform will work.

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
git diff --check
```

The smoke test installs a temporary working-tree marketplace fixture under an isolated `CLAUDE_CONFIG_DIR` and removes it on exit. It does not alter your normal Claude configuration.

## Author

Jeremy Watt ([@neonwatty](https://github.com/neonwatty))
