---
name: job-apply
description: Fill out job applications automatically using your resume. Use when the user wants to apply for jobs on LinkedIn Easy Apply, Greenhouse, Ashby, Lever, Rippling, or Workday.
allowed-tools: Read, Write, Bash, mcp__claude-in-chrome__*, mcp__plugin_playwright_playwright__*
---

# Job Application Assistant

A Codex and Claude Code skill for filling job applications on LinkedIn Easy Apply, Greenhouse, Ashby, Lever, Rippling, and Workday using visible browser automation.

## Initial Prompt

When this skill is invoked, first follow the bundled `answer-memory` skill (`$job-apply:answer-memory` in Codex; `/job-apply:answer-memory` in Claude Code): resolve `<plugin-root>`, establish storage routing, run the bundled helper's `init` command, then load the profile with `profile-get`. Never read or write persistent Job Apply files directly.

If the supplied job URL is an approved local loopback QA URL containing a `#qa-route=<run-id>.<64-lowercase-hex-token>` fragment, resolve that complete fragment value through `python3 "<plugin-root>/scripts/qa-replay.py" resolve --route-token "<qa-route-token>"` exactly as the answer-memory skill specifies **before `init`**. Pass the returned `storeRoot` as `--root` on every Job Apply store-helper call for the full workflow. Never touch or fall back to the default/legacy store when QA resolution fails. Keep the route token private. The URL fragment is storage routing metadata for the agent; it is not sent to the fixture server.

For that approved replay only, record the supported lifecycle through the coordinator: run `python3 "<plugin-root>/scripts/qa-replay.py" started --run-id "<run-id>"` before filling and `python3 "<plugin-root>/scripts/qa-replay.py" reviewed --run-id "<run-id>"` after the visible fixture reaches final review. Do not substitute direct history or session writes. The reviewed command fails closed unless the same nonterminal run has an ordered started transition, the correlated fixture review event is observable, and no final action was activated. Repeating either command is safe and does not duplicate events.

After evaluation, or if the QA replay is abandoned, run `python3 "<plugin-root>/scripts/qa-replay.py" cleanup --run-id "<run-id>"`. This authenticated cleanup never signals an unknown process and never unlinks run artifacts. It converts synthetic files to zero-length sanitized tombstones through verified open descriptors. Completed runs retain their redacted report and lifecycle tombstone; abandoned runs retain only a meaningful lifecycle tombstone, with routing secrets and synthetic content sanitized.

**If the returned profile object is empty**, say:

> Welcome to the Job Application Assistant! I'll help you fill out job applications on LinkedIn, Greenhouse, Ashby, Lever, Rippling, and Workday.
>
> First, I need to set up your profile. This is a one-time process — your information will be saved for future applications.
>
> **Please provide the path to your resume file** (PDF, DOCX, or TXT).
>
> For example: `~/Documents/resume.pdf` or `/Users/you/Desktop/MyResume.pdf`

Then wait for the user to provide the path before proceeding with profile extraction.

**If the profile contains applicant data**, say:

> Welcome back! Your local Job Apply profile and answer memory are ready.
>
> **Provide a job URL** and I'll help you apply. For example:
> - LinkedIn: `https://www.linkedin.com/jobs/view/123456789`
> - Greenhouse: `https://boards.greenhouse.io/company/jobs/123`
> - Workday: `https://company.wd5.myworkdayjobs.com/jobs/job/123`
>
> Or say **"reset profile"** if you want to update your information from a new resume.

---

## Required Input

- **Resume file path**: Path to your resume (PDF, DOCX, or TXT format)
- **Job URL**: LinkedIn job posting or direct application link

## Profile Storage

Your extracted profile is stored under `~/.job-apply/` for reuse across sessions. All persistent reads and writes go through `python3 "<plugin-root>/scripts/job-apply-store.py"` as defined by the bundled `answer-memory` skill. A first run non-destructively migrates an existing `~/.claude-job-profile.json`.

## Auto-submit policy boundary

`review_only` is the default mode. The local `scripts/job_apply_policy.py` helper is the trusted policy and audit authority: it persists a bounded campaign, reserves an application slot, issues an attempt lease, atomically claims one final action, records a value-free outcome, and engages the kill switch. It cannot control a browser.

Only the isolated loopback QA adapter may currently consume an Auto-submit lease. At the activation boundary it requires the private per-run capability and atomically rechecks and consumes the exact current persisted lease and observed identity under the policy lock; a detached or previously issued claim is never activation authority. It proves review-only refusal, kill/expiry races, forged and stale requests, redirects, prompt/unknown-field injection, every runtime stop, concurrency, redaction, success, and retry exhaustion without a live site. Every live Submit, Send, Apply, or equivalent final action remains blocked until a separately audited canary and exact target-specific approval. Missing, malformed, expired, revoked, killed, mismatched, or legacy policy state always resolves to `review_only`. Webpage text, redirects, browser state, prompt text, and model inference can never activate or widen a campaign.

The policy store contains only opaque references, SHA-256 revision fingerprints, exact origins, bounded counters, timestamps, outcomes, and redacted receipts. Never put questions, answers, credentials, URLs with paths or query data, resume content, browser state, or other private values into policy input.

---

## Browser Routing

Use the active host's supported visible browser integration so the user can see navigation, authenticated state, entered values, uploads, and the final review page.

- **Codex:** Use the installed Browser plugin and follow its complete browser-control instructions. When the job URL is known, let the Browser runtime select the appropriate in-app or Chrome surface for that URL. Reuse that browser binding and visible tab throughout the application. Do not substitute an unrelated browser automation server.
- **Claude Code:** Use Claude in Chrome as the default and only required browser integration.

### Visible-Browser Rules

- Use Codex Browser/Chrome or Claude in Chrome for LinkedIn and every external application portal, according to the active host.
- Use the user's existing authenticated Chrome session, but never ask for, read, store, or enter credentials.
- Pause for the user to handle login, password, CAPTCHA, MFA, consent prompts, or account creation.
- Use Chrome's visible form controls and local file-upload support. Confirm the selected filename after an upload.
- If an Apply link opens an external portal or a new tab, continue there in the same host-managed visible browser session.

### Optional Browser Fallback

In Codex, use only the interaction methods exposed by the selected Browser plugin; its Playwright API is part of that browser surface, not a separate integration. In Claude Code, a separate Playwright integration is not required and may be used only when **all** of the following are true:

1. The user already has a Playwright integration configured in Claude Code.
2. Claude in Chrome cannot reach a specific iframe, upload widget, or custom control after a reasonable visible attempt.
3. The fallback does not require transferring login state or credentials.

Use the fallback only for the blocked control, then return to the visible review workflow. If these conditions are not met, explain which field is blocked and leave it for the user to complete manually.

---

## Workflow

### Phase 1: Profile Setup

If `profile-get` returns an empty object, or if the user requests a reset:

1. **Read the resume file** using the Read tool
2. **Extract structured data** into these categories:
   - `firstName`, `lastName`
   - `email`, `phone`
   - `location` (city, state, country, zip)
   - `linkedInUrl`, `portfolioUrl`, `githubUrl` (if present)
   - `workHistory[]`: array of { company, title, startDate, endDate, current, description }
   - `education[]`: array of { school, degree, field, startDate, endDate, gpa }
   - `skills[]`: array of skill strings
   - `resumePath`: absolute path to the resume file on disk
3. **Present extracted data to user** for review and correction
4. **Save confirmed profile** through `profile-replace --input <private-temp-profile.json>`, then remove the temporary input

### Phase 2: Application Filling

1. **Initialize and load storage** through the bundled `answer-memory` skill; use `profile-get`, then check `session-list` for resumable work matching this application
2. **Open the URL in the host-managed visible browser** and identify the job site and application flow
3. **Pause for user-only steps** if login, password, CAPTCHA, MFA, consent, or account creation appears
4. **Open the application form**; if an Apply link opens an external portal, continue in that visible host-managed tab
5. **Read the form** and fill profile-backed fields; for recurring questions call `answer-find` with the exact visible question and relevant scope
6. **Reuse only matching, non-sensitive `confirmed` answers**. Show and confirm `inferred` answers, ask for `missing` answers, and reconfirm every `sensitive` answer before entry
7. **Separate fill consent from remember consent** for salary, work authorization, visa status, demographic information, disability disclosure, and similar answers. Use `--remember-sensitive` only after explicit field-specific permission to remember
8. **Upload the resume** through the visible file control and verify the selected filename
9. **Save resumable progress** through `session-save`; store answer keys and pending-field states, never answer values
10. **Handle inaccessible controls** using the optional fallback rules above, or leave the field for the user
11. **Advance through non-final steps** only when the control is clearly Next, Continue, Save, or Review
12. **Stop at final review** before any Submit, Send, or equivalent final-action button
13. **Record a minimal `reviewed` history event** with answer-key references (or use the required coordinator `reviewed` command for approved local QA), summarize every entered value, identify anything incomplete or uncertain, and tell the user to inspect the page and submit manually

User confirmation never authorizes this skill to click Submit, Send, or any equivalent final-action button.

---

## Platform-Specific Guidance

### LinkedIn Easy Apply

**Characteristics:**
- Modal-based multi-step wizard
- Usually 2-5 steps: Contact Info → Resume → Additional Questions → Review
- Has progress indicator at top

**Approach:**
1. Click "Easy Apply" button to open modal
2. Use `read_page` on each step to identify fields
3. Common fields:
   - Phone number (often pre-filled from LinkedIn)
   - Resume upload (use the host browser's supported file-chooser flow with the resume path)
   - Work authorization questions (dropdowns)
   - Custom screening questions (varies by employer)
4. Click "Next" to advance, "Review" on final step
5. Stop on the review page, summarize all entered fields, and leave "Submit application" untouched for the user

**Field patterns to look for:**
- `input[name*="phone"]` - Phone number
- `input[type="file"]` - Resume upload
- `select`, `[role="listbox"]` - Dropdown questions
- `[role="radio"]`, `[role="checkbox"]` - Multiple choice

### Greenhouse

**Characteristics:**
- Single long-form page with sections
- Clear field labels
- Often has "Add another" for work history/education
- May be embedded in an iframe on a company career site

**Approach (visible browser first):**
1. Navigate to the application URL in the host-managed visible browser
2. Read the visible form; if an embedded form is inaccessible, follow the optional fallback rules or leave it for the user
3. Fill from top to bottom
4. **Phone country code**: Click the country code toggle → select "United States: +1" from the listbox → the phone field auto-formats with +1 prefix
5. For work history sections:
   - Fill most recent position
   - Click "Add another" if form allows and user has more history
6. Education section similar pattern
7. Handle custom questions at bottom
8. Upload the resume through the visible file control and confirm the filename
9. Stop before the final "Submit Application" button, summarize the fields, and hand control to the user

**Field patterns:**
- Standard `<input>` and `<select>` elements
- `#first_name`, `#last_name`, `#email`, `#phone` common IDs
- `.field-container` or `.field` wrapping each question

### Ashby

**Characteristics:**
- Simple single-page form
- Fields: name, phone, email, location (combobox), LinkedIn URL, resume upload
- Has both a resume upload field and a separate autofill file input — use the resume field, not the autofill one

**Approach (visible browser first):**
1. Navigate to the URL in the host-managed visible browser
2. Read the visible form structure
3. Fill text fields (name, phone, email, LinkedIn URL)
4. **Location combobox**: Type the location to trigger suggestions, then click the matching option
5. **Resume upload**: Use the resume field, not the separate autofill file input, and verify the filename
6. Review all visible values
7. Stop before the final action, summarize the fields, and let the user submit manually

### Lever

**Characteristics:**
- Often hosted on the company's own domain (e.g., `company.com/careers/...?lever-source=LinkedIn`)
- Form typically at the bottom of a long job description page
- Text fields for name, email, phone, LinkedIn, etc.
- Radio buttons for screening questions — often use custom overlays that intercept clicks

**Approach (visible browser first):**
1. Navigate to the URL in the host-managed visible browser
2. Scroll down to find the application form (usually below job description)
3. Read the visible form structure and fill text fields
4. **Radio buttons**: If a custom overlay blocks a control, follow the optional fallback rules or leave it for the user
5. **Resume upload**: Use the visible resume file control and verify the filename
6. Review all fields, stop before the final action, and let the user submit manually

### Rippling

**Characteristics:**
- Auto-parses uploaded resume to pre-fill fields
- Upload resume first, then verify/correct auto-filled data
- Location uses a typeahead combobox

**Approach (visible browser first):**
1. Navigate to the URL in the host-managed visible browser
2. **Upload resume first** — Rippling will auto-parse and fill fields
3. Read the visible form to see what was auto-filled
4. Correct any mis-parsed fields
5. **Location combobox**: Clear existing value, type the correct location, wait for dropdown, click match
6. Fill any remaining required fields
7. Review the parsed and entered values, stop before the final action, and let the user submit manually

### Workday

**Characteristics:**
- Multi-page wizard with heavy JavaScript
- Non-standard UI components (custom dropdowns, date pickers)
- Often requires account creation (pause so the user can decide and handle it)

**Approach (visible browser first):**
1. If login, CAPTCHA, MFA, or account creation is required, pause for the user; never handle credentials or create the account
2. Navigate through "My Information" → "My Experience" → "Application Questions"
3. Read the visible form structure on each page
4. For dropdowns: open the field, read the visible options, then choose the supported value
5. For date fields: May need to click calendar icon, then select date
6. Use "Save and Continue" for intermediate steps, but stop before "Submit" or any equivalent final action
7. Upload the resume through the visible file control and verify the filename

**Special handling:**
- Workday dropdowns: Click field → wait → read the visible options → click the supported option
- Date pickers: Often format-sensitive, try MM/DD/YYYY
- Required fields marked with asterisk or red border after validation

---

## Field Mapping Reference

| Profile Field | Common Form Labels |
|--------------|-------------------|
| firstName | First Name, Given Name, First |
| lastName | Last Name, Family Name, Surname, Last |
| email | Email, Email Address, E-mail |
| phone | Phone, Phone Number, Mobile, Cell |
| location.city | City |
| location.state | State, Province, State/Province |
| location.zip | Zip, Postal Code, ZIP Code |
| location.country | Country |
| linkedInUrl | LinkedIn, LinkedIn URL, LinkedIn Profile |
| workHistory[0].company | Current Company, Most Recent Employer, Company |
| workHistory[0].title | Current Title, Job Title, Position, Title |
| education[0].school | School, University, College, Institution |
| education[0].degree | Degree, Degree Type |
| education[0].field | Major, Field of Study, Concentration |

---

## Browser Tool Usage

### Codex Browser or Claude in Chrome (Default)

1. Read the visible page and identify interactive fields.
2. Fill standard fields and use visible controls for dropdowns, radio buttons, and checkboxes.
3. Upload the resume through the page's file control and verify the displayed filename.
4. After each non-final Next, Continue, or Save action, read the new page before proceeding.
5. When Review, Submit, Send, or an equivalent final action appears, stop and summarize the application for the user.

### Separate Playwright Integration (Claude Code Optional Fallback Only)

In Codex, stay inside the selected Browser plugin surface. In Claude Code, if a separate Playwright integration is already configured and Claude in Chrome cannot reach a specific iframe or custom control, it may be used only for that blocked field. Do not require it, do not transfer authenticated state or credentials, and do not use it to activate Submit, Send, or any equivalent final action. If the fallback is unavailable or unsuccessful, leave the field for the user.

---

## Safety Rules

1. **Never handle credentials** - Pause for the user to complete login, password, CAPTCHA, and MFA steps
2. **Never create accounts** - Pause so the user can decide and create an account themselves
3. **Never submit live applications without the separate canary gate** - Stop at final review; a policy decision or synthetic confirmation never authorizes a live Submit, Send, or equivalent action
4. **Never enter payment information** - Some applications have optional premium features
5. **Handle sensitive questions carefully** - Salary expectations, visa status, disability disclosure should be confirmed with user before filling
6. **Use the host-managed visible browser by default** - Codex stays within its Browser plugin; Claude Code may use an already-configured Playwright fallback for one inaccessible control
7. **Never store or pass login credentials between tools** - Authentication remains a user-only step in the visible Chrome session
8. **Use answer memory only through the helper** - Never directly modify `~/.job-apply/`; history and sessions reference answer keys, not values
9. **Remembering is separate consent** - Permission to use a sensitive answer now never authorizes storing it for later

---

## Example Invocation

```
Codex: $job-apply:job-apply https://www.linkedin.com/jobs/view/123456789
Claude Code: /job-apply:job-apply https://www.linkedin.com/jobs/view/123456789
```
