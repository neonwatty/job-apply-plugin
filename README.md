# Job Apply Plugin for Codex and Claude Code

Run the isolated cross-client task-spine oracle with `npm run qa:unified-task-spine`. It uses a temporary synthetic Store, the shipped CLIs, an authenticated loopback Companion server, and Playwright; its single JSON report is value-free and cleanup-closed, and it never enables a final application action.

[![Discord](https://img.shields.io/badge/Discord-Join%20Server-7289da?style=flat&logo=discord&logoColor=white)](https://discord.gg/7xsxU4ZG6A)

AI-powered job application assistant for Claude Code and Codex that fills job applications on LinkedIn Easy Apply, Greenhouse, Ashby, Lever, Rippling, and Workday using visible browser automation.

## Skills

| Skill | Description |
|-------|-------------|
| `job-apply:job-apply` | Prepare application fields from your resume and stop before final submission |
| `job-apply:answer-memory` | Safely manage your local profile, reusable answers, application history, and resumable sessions |
| `job-apply:job-search` | Search LinkedIn, Hacker News, and Twitter/X for jobs, then rank results against your preferences |
| `job-apply:job-preferences` | Set the titles, salary, remote-work, and filtering preferences used by job search |
| `job-apply:job-workspace` | Open the optional local Jobs, Facts, Resumes, Answers, and unified Trash workspace shared with Job Apply agents |

Invoke skills with `$job-apply:...` in Codex or `/job-apply:...` in Claude Code.

## Features

### Job Apply (`job-apply:job-apply`)
- **One-time profile setup**: Extract your information from a resume (PDF, DOCX, or TXT)
- **Guided ATS coverage**: Workflows for LinkedIn Easy Apply, Greenhouse, Ashby, Lever, Rippling, and Workday, with current forms unverified
- **Visible browser automation**: Codex Browser/Chrome or Claude in Chrome fills forms in a session you can see and control
- **Smart field mapping**: Automatically matches your profile to form fields
- **Confidence-aware answer reuse**: Reuses confirmed non-sensitive answers and flags inferred, missing, or sensitive answers for review
- **Resumable progress**: Saves application step metadata and answer references without copying answer values
- **Ready-job handoff**: Selects a canonical ready job, exclusively claims it with a recoverable lease, uses its assigned/default resume, and atomically hands it to needs-info or final review
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

When testing an unreleased branch, first check out the exact commit in an isolated
worktree and pass that worktree's absolute path to `codex plugin marketplace add`.
After installing, confirm that `codex plugin list --json` selects the manifest's
version directory and start a new Codex task. This keeps branch tests tied to one
explicit candidate instead of a previously cached package with the same version.

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

4. Inspect the final review page and field summary. The assistant stops before final submission; only you may decide whether to complete it manually on the third-party site.

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

### Local Companion Workspace

The optional workspace gives you keyboard-accessible **Overview**, **Jobs**, **Needs Attention**, **Facts**, **Resumes**, **Answers**, **Application Activity**, and unified **Trash** views backed by the same canonical records used by the CLI skills. From the plugin directory, start it with one command:

```bash
python3 scripts/job-apply-workspace.py
```

The launcher binds only to `127.0.0.1`, chooses a free port, opens the complete authenticated URL in your default browser, and stops cleanly with Ctrl-C. It requires Python 3 but no Node runtime, account, cloud service, telemetry, or separate database.

Start on **Overview**. It derives setup readiness and one next action from counts and booleans under the canonical Store lock; it does not expose profile values, paths, record IDs, claims, or secrets, and it never stores an onboarding-complete flag in the browser. A new owner is guided to import a resume, review Facts, capture and prepare a job, resolve Needs Attention, or hand off a Ready job as the current Store state requires.

For a Ready job, copy the invocation for the host you already use. These are static, separately labelled, copy-only commands; the workspace does not detect a host, run a command, embed a terminal, or interpolate credentials:

```text
Codex:       $job-apply:job-apply
Claude Code: /job-apply:job-apply
```

The agent acquires the Ready job from the canonical Store. Watch durable progress in **Application Activity** and use **Needs Attention** for missing information, human review, expired claims, or interrupted attempts. The agent stops before final submission; only you may submit on the third-party site.

Closing the tab or restarting the launcher does not erase progress because the browser owns no durable workflow state. On restart, use the complete newly printed URL. Revision conflicts keep drafts visible and require explicit review; interrupted work is routed to Needs Attention; trashed records remain individually recoverable. If read-only startup validation recognizes an unavailable, corrupt, or future-version Store, the server fails closed: it serves only the static workspace and sanitized recovery status, blocks canonical reads and mutations, and exposes no canonical values, filesystem paths, or raw exceptions to the browser. It does not automatically repair, downgrade, or overwrite the Store. If initialization itself fails after validation, startup aborts instead of presenting a degraded no-mutation claim. Stop the workspace, preserve the Store directory, and restore a known-good backup or use the matching Job Apply version.

Use **Jobs** to manage the opportunity queue, **Facts** to selectively edit profile data, and **Resumes** to manage private canonical files and extraction review. Facts includes compact built-in views plus durable custom groups shared with the CLI. Groups reference canonical fact paths and can be created, renamed, reordered, edited, and removed without moving or deleting the underlying applicant facts. Use **Answers** to search the reusable library, review observed questions, create and selectively edit answers, accept or decline observations, and manage guarded Trash. Observed questions are pending records in `answers.json`, not a second inbox database. Declined records remain durable for deduplication and are hidden from the default library. Generic put creates accepted library records only; pending creation belongs to observation, and declined creation belongs to dedicated review.

Use the top-level **Trash** view to see deterministic redacted projections and exact counts for trashed jobs, resumes, and answers. Restore and permanent delete use the same canonical Store helpers as the CLI and require the record's exact revision. Permanent deletion is always one record at a time in an accessible identity-bound dialog and requires the exact type-specific phrase `DELETE JOB`, `DELETE RESUME`, or `DELETE ANSWER`. Deleting a managed resume permanently deletes its managed file with the canonical resume record; other record types remove only the selected canonical record. No deletion cascades or erases application history, sessions, or audit evidence. Live claims, nonterminal job sessions, resume references, answer references, duplicate active identities, and stale revisions produce distinct redacted explanations without automatic retry or disclosure of linked identifiers. CLI users can select only trashed jobs or resumes with `job-list --trashed-only` and `resume-list --trashed-only`; answers retain `answer-list --include-trashed --trashed-only`.

Duplicate answers can be merged only by explicitly selecting an accepted winner. Both records must have the same exact scope and current revisions. The winner keeps its value, sensitivity consent, source/provenance, and confirmation metadata; the source value is removed, its normalized question and aliases transfer, and its value-free observation metadata is combined. Active session references are rewritten through the crash-recoverable coordinator while append-only history remains unchanged and resolves through a permanent flattened, value-free redirect. Derived-key and redirect fallback never crosses the record's current exact scope; an observation fails safely when an old stable key is occupied at another scope. Redirect targets remain active and cannot be trashed.

Answer aggregate lists never contain values. Sensitive values are also absent from get, find, and mutation responses and are displayed only after an explicit Reveal action. A changed sensitive value is retained only with fresh field-specific consent. Existing-answer writes use exact revisions; concurrent observations only add counts/timestamps and never replace canonical fields; permanent deletion is blocked by either a session or append-only history reference.

Every mutation of an existing resume or proposal checks the target record's exact revision. Import is a new-record operation protected by ID/content uniqueness rather than an expected revision. Making a resume default checks the selected resume revision, then atomically advances any prior default as part of the compound change; it does not separately require the prior default's revision. If CLI or agent work changes a target record, the browser does not retry or overwrite it: only metadata fields actually edited in the browser remain as drafts, while untouched fields refresh from the canonical record; selected files also stay in place until you explicitly refresh and reapply them. Proposal review can decide a subset of pending paths; accepted values refresh Facts with user provenance. If accepting a child path would replace an existing scalar or array ancestor, the review discloses that ancestor and its current value and requires a separate confirmation of the exact replacement scope. Aggregate lists never contain resume bytes, file identities, or extracted values, and content requests require the in-memory workspace token and are returned with no-store and fixed content types.

The workspace never runs an application, reads arbitrary filesystem paths, parses, writes, generates, or tailors resume content, authors extraction proposals, or activates Submit, Send, Apply, or another third-party final action. It has no cloud sync or browser-owned durable catalog. A ready job remains an explicit handoff to `$job-apply:job-apply`; you personally control submission.

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
  fact-groups.json
  answers.json
  jobs.json
  resumes.json
  resume-files/
  resume-extractions.json       # created on first extraction proposal
  resume-extraction-journal.json # created on first extraction proposal
  applications.jsonl
  coordinator.json
  coordinator-journal.json
  sessions/
    <application-id>.json
```

| File | Purpose |
|------|---------|
| `profile.json` | Resume facts and job-search preferences |
| `fact-groups.json` | Revisioned saved views that organize canonical profile paths without owning or deleting facts |
| `answers.json` | Revisioned reusable answers with confirmation, source, scope, sensitivity, and trash state |
| `jobs.json` | Canonical job records, application status, revisions, and recoverable trash state |
| `resumes.json` | Versioned resume metadata, labels, defaults, digests, and file observations |
| `resume-files/` | Private managed copies of imported PDF, DOCX, and UTF-8 TXT resumes |
| `resume-extractions.json` | Private revisioned extraction candidates, baselines, conflicts, decisions, and supersession state (lazy) |
| `resume-extraction-journal.json` | Private write-ahead recovery for atomic profile/proposal commits (lazy) |
| `applications.jsonl` | Minimal append-only application lifecycle events |
| `coordinator.json` | One global, recoverable 300-second application-agent claim |
| `coordinator-journal.json` | Value-free idempotent roll-forward record for lifecycle handoffs |
| `sessions/*.json` | Resumable workflow metadata and answer-key references |

The coordinator files are created only when the ready-job claim workflow is first used. Ordinary URL applications are first ingested as canonical jobs and use the same canonical job ID for selection, claims, sessions, activity, and review handoff. Authenticated loopback QA replay is the only synthetic exception.

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
chmod 700 ~/.job-apply/resume-files
chmod 600 ~/.job-apply/profile.json ~/.job-apply/answers.json ~/.job-apply/jobs.json ~/.job-apply/resumes.json ~/.job-apply/applications.jsonl ~/.job-apply/coordinator.json ~/.job-apply/coordinator-journal.json
# If extraction proposals have been created:
chmod 600 ~/.job-apply/resume-extractions.json ~/.job-apply/resume-extraction-journal.json
```

On first use, an existing `~/.claude-job-profile.json` is copied into the new versioned profile without modifying or deleting the legacy file. Once `~/.job-apply/profile.json` exists it is authoritative; later legacy-file changes are not re-imported. Verify the new profile before deciding whether to archive or remove the old file.

All plugin skills access this data through the bundled `scripts/job-apply-store.py` helper. Canonical JSON updates are atomic, corrupt or future-version files fail closed, and application history and sessions do not duplicate reusable answer values.

The packaged `scripts/job-apply-task.py` helper is the ordinary agent-facing job protocol. `snapshot` returns one redacted Store-owned overview/jobs/attention view; `activity --id <job-id>` returns value-free activity for one exact canonical job. `intake --input <private-json>` atomically resolves or creates exactly one active job without returning its URL or the Store's upsert token. After the owner explicitly chooses a displayed job, `select --id <job-id> --expected-revision <revision> --owner-confirmed` rechecks preflight and marks it Ready, or returns a stable no-op when that exact revision is already Ready. `semantic-lookup` recomputes deterministic candidates and bounded reuse policy from current canonical answers without returning answer values. `approval-preview` and `approval-approve` preserve current-use, remember, policy-mode, and use-authority decisions per opaque field reference. `cleanup-preview` never mutates; `cleanup-approve` requires the exact current preview plus explicit owner confirmation. All failures are stable machine-readable JSON; identity conflicts, trashed matches, stale revisions, unavailable jobs, failed policy, and failed preflight stop before browser work.

The packaged `scripts/job-apply-attempt.py` helper uses a detached broker scoped to one Store and exact selected attempt. A short `start` client launches the broker, acquires the exact job and revision, returns the redacted application inputs, and exits; no launcher, stdin stream, terminal, or conversational process stays attached. The broker retains claim authority only in memory, heartbeats automatically, and accepts later stateless `heartbeat`, value-free `progress`, and `handoff` clients through its OS-user-restricted Store socket. It cannot switch jobs, Stores, revisions, owners, or claims. Its argv, environment, JSON responses, diagnostics, and durable files never carry the raw claim authority. An `awaiting_review` handoff succeeds only when the Store recomputes a complete `agent_attested_current_attempt` readiness report whose attempt revision matches the acquired revision, its complete observed required-control manifest exactly matches the selected bundled fixture, every assertion passes, no unresolved work remains, and final action remains untouched. If the visible form has additional required controls or no exact bundled fixture, readiness fails closed and the attempt must enter Needs Attention. This is an agent attestation over a closed observation, not independent proof of browser provenance; the owner must still inspect and submit the visible form. Repository replay evidence is deliberately insufficient. A bounded `needs_info` handoff may instead retain only allowlisted typed blocker codes and a closed browser-handoff state; neither session form retains question text, answers, credentials, URLs, paths, tab IDs, or browser state.

Version 1.3.0 is the first package identity containing this human-attention contract. Session additions are optional and revisioned within the existing schema: older v1 sessions remain readable, while the next coordinator write replaces legacy question/role/company/URL copies with value-free blocker, readiness, approval, and browser-handoff projections. Validation remains non-mutating on corrupt or future documents, and coordinator journal recovery remains the only crash roll-forward path.

When an exact managed attempt is blocked by a referenced non-sensitive question, send a value-free `needs_info` handoff so the broker releases the claim and exits, then inspect `activity --id <job-id>`. Edit and accept the answer in Companion's canonical Answers library and explicitly resolve that pending reference against the exact job, session, and answer revisions shown there. The Store rechecks all three revisions under its lock, removes only that pending reference, and never copies the answer value into the session, journal result, history, activity, or diagnostics. The job stays in Needs Attention while another blocker remains; with no blockers it becomes Ready only after preflight. Use the returned exact Ready revision with a fresh `start` client, which creates a fresh broker acquisition for the same canonical job; the assigned/default managed resume binding and resumable session continue through the next `job-started` and `reviewed` handoff. Missing, inferred, declined, sensitive, or stale answers fail closed without retry. Refresh and review canonical state; browser drafts are not overwritten. This flow opens no portal and performs no final action.

New resume records import a private managed copy rather than retaining the source
path. Imports accept PDF, DOCX, and UTF-8 TXT files up to 10 MiB, reject duplicate
content (including copies in trash), and keep stable resume IDs across byte
replacement. Existing path-based records remain readable and are never rewritten
implicitly; use the CLI's explicit `resume-adopt` operation to copy one into managed
storage under its existing ID. File and metadata transitions roll back together on
failure. The local workspace receives a redacted resume projection without source
paths, managed filenames, original filenames, or digests.

Ready-job acquisition rechecks the assigned or default resume. Managed-file digest
or observation drift blocks acquisition before any claim, job transition, journal,
or history change. For backward compatibility, changed legacy external records keep
their preflight warning behavior until they are explicitly adopted.

Trusted local application workflows use `resume-resolve` (optionally with `--id`)
to obtain the verified private path of an active managed resume. This path-bearing
result is for local agent file upload only; workspace APIs and aggregate views remain
redacted. A legacy external record must be explicitly adopted before it can resolve.

Resume extraction remains agent-produced structured data; the store does not parse,
edit, generate, or tailor resumes. A proposal is bound to the managed resume's
current revision and digest plus the profile revision the agent inspected. Creation
automatically fills only absent or null facts that are not protected by human
provenance. Existing values—including blanks, arrays, and empty objects—and
human-cleared facts remain explicit conflicts. Human review is revisioned per path,
accepted extracted values become user-provenanced facts, and unrelated paths may
remain pending. A private write-ahead journal makes profile-plus-proposal commits
recoverable after interruption. Replaced, trashed, deleted, missing, or byte-changed
resumes make bound proposals stale.

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

### Guided legacy job migration

The helper can selectively import the documented numbered job entries from
regular `search-*.md` files directly under `~/.claude-job-searches/`. It does
not read `application_queue.md`, arbitrary paths, nested directories, or
symlinks. Undocumented Markdown variants are not imported, and the helper never
modifies report files.

Discover candidates without changing or creating the canonical store:

```bash
python3 scripts/job-apply-store.py legacy-jobs-preview
```

Invalid entries remain visible with a reason. Preview chosen valid `itemId`
values by repeating `--select`, then commit only after reviewing that exact
selected preview:

```bash
python3 scripts/job-apply-store.py legacy-jobs-preview \
  --select <item-id> --select <item-id>
```

Use `legacy-jobs-commit` with the identical ordered selection and the selected
preview's confirmation token; `legacy-jobs-commit --help` shows the token option.

Commit fails closed if the selection, any discovered report, parsed payload, or
canonical job store changed. Imported records carry value-free migration
provenance. Migration can create jobs, fill empty fields, and refresh
migration-authored fields; it never overwrites nonempty human- or agent-authored
values. The canonical job store is authoritative after import; Markdown export,
mutation, and two-way sync are not supported.

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
