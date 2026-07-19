---
name: job-apply
description: Fill out job applications automatically using your resume. Use when the user wants to apply for jobs on LinkedIn Easy Apply, Greenhouse, Ashby, Lever, Rippling, or Workday.
allowed-tools: Read, Write, Bash, mcp__claude-in-chrome__*, mcp__plugin_playwright_playwright__*
---

# Job Application Assistant

A Claude Code skill for filling job applications on LinkedIn Easy Apply, Greenhouse, Ashby, Lever, Rippling, and Workday using browser automation.

## Initial Prompt

When this skill is invoked, first follow `/job-apply:answer-memory`: run the bundled helper's `init` command, then load the profile with `profile-get`. Never read or write persistent Job Apply files directly.

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

Your extracted profile is stored under `~/.job-apply/` for reuse across sessions. All persistent reads and writes go through `${CLAUDE_PLUGIN_ROOT}/scripts/job-apply-store.py` as defined by `/job-apply:answer-memory`. A first run non-destructively migrates an existing `~/.claude-job-profile.json`.

---

## Browser Routing

Use **Claude in Chrome** as the default and only required browser integration. Work in the visible Chrome session so the user can see navigation, authenticated state, entered values, uploads, and the final review page.

### Chrome-First Rules

- Use Claude in Chrome for LinkedIn and every external application portal.
- Use the user's existing authenticated Chrome session, but never ask for, read, store, or enter credentials.
- Pause for the user to handle login, password, CAPTCHA, MFA, consent prompts, or account creation.
- Use Chrome's visible form controls and local file-upload support. Confirm the selected filename after an upload.
- If an Apply link opens an external portal or a new tab, continue there in Claude in Chrome.

### Optional Playwright Fallback

Playwright is not required. Use it only when **all** of the following are true:

1. The user already has a Playwright integration configured.
2. Chrome cannot reach a specific iframe, upload widget, or custom control after a reasonable visible attempt.
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

1. **Initialize and load storage** through `/job-apply:answer-memory`; use `profile-get`, then check `session-list` for resumable work matching this application
2. **Open the URL in Claude in Chrome** and identify the job site and application flow
3. **Pause for user-only steps** if login, password, CAPTCHA, MFA, consent, or account creation appears
4. **Open the application form**; if an Apply link opens an external portal, continue in that visible Chrome tab
5. **Read the form** and fill profile-backed fields; for recurring questions call `answer-find` with the exact visible question and relevant scope
6. **Reuse only matching, non-sensitive `confirmed` answers**. Show and confirm `inferred` answers, ask for `missing` answers, and reconfirm every `sensitive` answer before entry
7. **Separate fill consent from remember consent** for salary, work authorization, visa status, demographic information, disability disclosure, and similar answers. Use `--remember-sensitive` only after explicit field-specific permission to remember
8. **Upload the resume** through the visible file control and verify the selected filename
9. **Save resumable progress** through `session-save`; store answer keys and pending-field states, never answer values
10. **Handle inaccessible controls** using the optional fallback rules above, or leave the field for the user
11. **Advance through non-final steps** only when the control is clearly Next, Continue, Save, or Review
12. **Stop at final review** before any Submit, Send, or equivalent final-action button
13. **Record a minimal `reviewed` history event** with answer-key references, summarize every entered value, identify anything incomplete or uncertain, and tell the user to inspect the page and submit manually

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
   - Resume upload (use `upload_image` tool with resume path)
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

**Approach (Chrome first):**
1. Navigate to the application URL in Claude in Chrome
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

**Approach (Chrome first):**
1. Navigate to the URL in Claude in Chrome
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

**Approach (Chrome first):**
1. Navigate to the URL in Claude in Chrome
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

**Approach (Chrome first):**
1. Navigate to the URL in Claude in Chrome
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

**Approach (Chrome first):**
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

### Claude in Chrome (Default)

1. Read the visible page and identify interactive fields.
2. Fill standard fields and use visible controls for dropdowns, radio buttons, and checkboxes.
3. Upload the resume through the page's file control and verify the displayed filename.
4. After each non-final Next, Continue, or Save action, read the new page before proceeding.
5. When Review, Submit, Send, or an equivalent final action appears, stop and summarize the application for the user.

### Playwright (Optional Fallback Only)

If Playwright is already configured and Chrome cannot reach a specific iframe or custom control, it may be used only for that blocked field. Do not require it, do not transfer authenticated state or credentials, and do not use it to activate Submit, Send, or any equivalent final action. If the fallback is unavailable or unsuccessful, leave the field for the user.

---

## Safety Rules

1. **Never handle credentials** - Pause for the user to complete login, password, CAPTCHA, and MFA steps
2. **Never create accounts** - Pause so the user can decide and create an account themselves
3. **Never submit applications** - Stop at final review; confirmation does not authorize clicking Submit, Send, or an equivalent final action
4. **Never enter payment information** - Some applications have optional premium features
5. **Handle sensitive questions carefully** - Salary expectations, visa status, disability disclosure should be confirmed with user before filling
6. **Use Claude in Chrome by default** - Playwright is only an already-configured fallback for a specific inaccessible control
7. **Never store or pass login credentials between tools** - Authentication remains a user-only step in the visible Chrome session
8. **Use answer memory only through the helper** - Never directly modify `~/.job-apply/`; history and sessions reference answer keys, not values
9. **Remembering is separate consent** - Permission to use a sensitive answer now never authorizes storing it for later

---

## Example Invocation

```
User: /job-apply:job-apply https://www.linkedin.com/jobs/view/123456789
```
