# Job Apply Plugin for Claude Code

[![Discord](https://img.shields.io/badge/Discord-Join%20Server-7289da?style=flat&logo=discord&logoColor=white)](https://discord.gg/7xsxU4ZG6A)

AI-powered job application assistant that automatically fills out job applications on LinkedIn Easy Apply, Greenhouse, Ashby, Lever, Rippling, and Workday using browser automation.

## Skills

| Skill | Description |
|-------|-------------|
| `/job-apply` | Fill out job applications automatically using your resume |
| `/job-search` | Search LinkedIn for jobs with connections and hiring manager insights |

## Features

### Job Apply (`/job-apply`)
- **One-time profile setup**: Extract your information from a resume (PDF, DOCX, or TXT)
- **Multi-platform support**: LinkedIn Easy Apply, Greenhouse, Ashby, Lever, Rippling, Workday
- **Dual-tool architecture**: Chrome MCP for authenticated sites, Playwright MCP for form filling and file uploads
- **Smart field mapping**: Automatically matches your profile to form fields
- **Safety first**: Never submits without your explicit confirmation
- **Resume storage**: Profile saved locally for reuse across applications

### Job Search (`/job-search`)
- **Smart keyword suggestions**: Auto-generates search terms from your resume
- **Connection insights**: Finds jobs at companies where you have connections
- **Hiring manager discovery**: Identifies jobs with hiring managers listed
- **Auto-inferred filters**: Location and experience level from your profile
- **Results saved**: All searches saved to `~/.claude-job-searches/` as JSON

## Requirements

- [Claude Code](https://claude.ai/code) CLI
- [Claude in Chrome](https://chromewebstore.google.com/detail/claude-in-chrome) MCP server for authenticated browser sessions (LinkedIn)
- [Playwright MCP](https://github.com/anthropics/claude-code/tree/main/.claude/plugins/playwright) server for form filling, file uploads, and iframe interaction

## Installation

```bash
claude plugin marketplace add neonwatty/job-apply-plugin
claude plugin install job-apply@neonwatty-plugins
```

## Usage

### First Time Setup

1. Invoke the skill:
   ```
   /job-apply
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
   /job-apply
   ```

2. Provide a job URL:
   ```
   https://www.linkedin.com/jobs/view/123456789
   ```

3. Watch as Claude fills out the application

4. Review the summary and confirm submission

### Searching for Jobs

Use `/job-search` to find jobs where you have an advantage:

1. Invoke the skill:
   ```
   /job-search
   ```

2. Claude will suggest keywords based on your resume:
   ```
   Based on your resume, I suggest searching for:
   - Keywords: "Senior Software Engineer", "Staff Engineer"
   - Location: San Francisco, CA
   - Experience: Mid-Senior (7 years)

   Ready to search, or would you like to adjust?
   ```

3. Confirm or modify the suggestions

4. Review results prioritized by:
   - Jobs with hiring managers listed (highest priority)
   - Jobs with 1st-degree connections
   - Jobs with alumni connections

Results are automatically saved to `~/.claude-job-searches/`.

## Supported Platforms

| Platform | URL Pattern | Tool | Status |
|----------|-------------|------|--------|
| LinkedIn Easy Apply | `linkedin.com/jobs/view/*` | Chrome MCP | Supported |
| Greenhouse | `boards.greenhouse.io/*` | Playwright MCP | Supported |
| Ashby | `jobs.ashbyhq.com/*` | Playwright MCP | Supported |
| Lever | `jobs.lever.co/*` | Playwright MCP | Supported |
| Rippling | `*.rippling.com/*` | Playwright MCP | Supported |
| Workday | `*.myworkdayjobs.com/*` | Playwright MCP | Supported |

## Profile Storage

Your profile is stored at `~/.claude-job-profile.json` and includes:

- Personal information (name, email, phone, location)
- Work history
- Education
- Skills
- Social links (LinkedIn, GitHub, portfolio)

To reset your profile:
```
/job-apply reset profile
```

## Search Results Storage

Job search results are saved to `~/.claude-job-searches/` with timestamped filenames:

```
~/.claude-job-searches/
  search-2026-01-06T10-30-00.json
  search-2026-01-07T14-15-00.json
```

Each file contains:
- Search parameters (keywords, location, filters)
- List of jobs with full details
- Connection and hiring manager information
- Priority ranking

## Safety Features

- **Never enters passwords** - Stops if login is required
- **Never creates accounts** - You must create accounts yourself
- **Never submits without confirmation** - Always shows summary first
- **Never enters payment info** - Skips premium features
- **Confirms sensitive questions** - Salary, visa status, etc.

## License

MIT License - See [LICENSE](LICENSE) for details.

## Contributing

Contributions welcome! Please open an issue or PR on GitHub.

## Author

Jeremy Watt ([@neonwatty](https://github.com/neonwatty))
