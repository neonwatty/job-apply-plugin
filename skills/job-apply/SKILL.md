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

**If the profile contains applicant data**, first determine the application mode:

- The authenticated loopback QA replay above is the only exception to canonical URL intake. Keep using its resolved run ID and coordinator lifecycle; do not create a canonical job for that synthetic fixture.
- If the user supplied a job URL, the required ordinary behavior is canonical intake: put only the supported canonical job fields in a private temporary JSON object, run `python3 "<plugin-root>/scripts/job-apply-task.py" [--root <resolved-root>] intake --input <private-temp.json>`, and immediately remove the input. Do this before any browser work. A conflict, invalid identity, unavailable store, or any other non-success result stops the workflow without opening a browser. Retain only the returned canonical job ID, status, and revision; the task result never returns the URL or an upsert token.
- For ordinary discussion or when no URL was supplied, run `job-apply-task.py ... snapshot`. List and compare only its canonical jobs and Needs Attention projection. Do not run the legacy `job-list --status ready` command as the ordinary agent discussion surface. Never infer a choice from priority, ordering, a URL mention, or model preference: ask the owner to choose one exact canonical job unless their current request already explicitly names that exact job as the application target.
- After an explicit owner choice, run `job-apply-task.py ... select --id <job-id> --expected-revision <displayed-revision> --owner-confirmed`. This exact-revision operation re-runs readiness preflight, marks an eligible saved or needs-info job Ready, and returns a stable no-op when the exact job is already Ready. On success, discard the pre-select displayed revision and retain the exact revision returned in `select.job.revision`; pass that returned revision, unchanged, to the private attempt helper described below. Any stale revision, failed preflight, conflict, unavailable record, or other non-success result stops without browser work; do not run `job-acquire`, do not start an attempt, and refresh the task snapshot to discuss the changed state rather than retrying against unseen data.
- Before starting the selected Ready job, run `claim-status`. If it returns any live or expired claim, identify only the claimed job and stop: the ordinary agent route cannot recover, steal, clear, or replace it. An interrupted attempt remains for explicit expiry/recovery outside this skill. If there is no claim, start only the explicitly selected canonical job as described below.
- If the exact owner-selected job is `awaiting_review`, do not select it as Ready and do not restart merely because the owner said “continue.” Inspect its value-free activity and ask the owner to confirm explicitly that this application was not submitted. Only that current, job-specific confirmation authorizes one `job-apply-attempt.py ... restart-review --id <job-id> --owner <owner-label> --expected-revision <displayed-revision> --owner-confirmed-not-submitted` launcher. Use the exact displayed revision and stop on any conflict, incomplete review evidence, pending work, existing claim, or failed managed-resume preflight. The detached broker then owns the same job exactly as for `start`; prior review-session bytes remain intact until a successful claim-gated `progress` write. This restart does not authorize opening a browser, entering data, or activating a final action; apply the ordinary visible-browser and action-time-consent rules again.
- If the exact job is `needs_info` with a pending answer reference, first inspect `job-apply-task.py ... activity --id <job-id>`. Route the owner to the canonical Answers editor; do not infer, reveal, or copy an answer value. After the owner has explicitly saved an accepted, confirmed, non-sensitive answer, run `job-apply-task.py ... resolve-pending-answer --id <job-id> --reference <pending-reference> --expected-job-revision <activity-job-revision> --expected-session-revision <activity-session-revision> --expected-answer-revision <pending-answer-revision> --owner-confirmed`. Never use this operation for missing, inferred, declined, sensitive, unreferenced, or changed answers. Never retry a stale failure: refresh activity, preserve any browser draft, and ask the owner to review the changed canonical state. The result remains `needs_info` while any blocker remains; when it returns the exact job as Ready, pass that returned revision unchanged to a new private attempt helper process. The same job/session and assigned-or-default managed resume identity continue across blocking, resolution, the new private attempt, and awaiting-review handoff; do not substitute a resume or source path. This recheck does not open a portal or authorize any final action.

For a selected Ready job, use only the exact revision returned by the successful `select` result, create a short non-sensitive owner label for this agent run, and run one short launcher client: `python3 "<plugin-root>/scripts/job-apply-attempt.py" [--root <resolved-root>] start --id <job-id> --owner <owner-label> --expected-revision <select.job.revision>`. Never use the pre-select displayed revision. For the separately authorized reviewed-job path, use only the `restart-review` launcher and exact revision described above. Either client returns one redacted failure or `acquired` with the exact job URL/revision and managed resume identity/path needed for the application, then exits. Acquisition or restart starts one OS-detached broker scoped to the resolved Store. No launcher, stdin, PTY, tool session, or conversational process must remain alive. The broker privately acquires once, retains the bearer only in memory, automatically heartbeats at least every 60 seconds, and accepts later stateless clients only through its OS-user-restricted Store socket. It never accepts a different job, revision, owner, Store, or claim. Never invoke the Store's raw acquire, review-restart, recovery, heartbeat, progress, or handoff commands in an ordinary workflow: in particular, never run `job-acquire --id <job-id> --owner <owner-label> --expected-revision <select.job.revision>` or raw `job-review-restart`. Never put claim authority in argv, environment, input, output, files, runtime metadata, diagnostics, reports, or receipts.

To request an immediate heartbeat from any later conversational turn, run a fresh client: `python3 "<plugin-root>/scripts/job-apply-attempt.py" [--root <resolved-root>] heartbeat` and require one successful `heartbeat` response. The client exits immediately; the detached broker continues independently. A rejected command or unavailable broker stops browser work. Broker loss leaves the exact existing claim untouched for expiry and explicit recovery; a new launcher cannot adopt, replace, recover, or reset it.

**If the profile contains applicant data and neither an ingested URL nor an explicitly selected canonical job is available**, say:

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

- **Resume source file path**: Needed only to import a new canonical managed PDF, DOCX, or TXT resume
- **Application target**: A supplied URL ingested into one canonical job, or an explicitly selected canonical job

## Profile Storage

Your extracted profile is stored under `~/.job-apply/` for reuse across sessions. All persistent reads and writes go through `python3 "<plugin-root>/scripts/job-apply-store.py"` as defined by the bundled `answer-memory` skill. A first run non-destructively migrates an existing `~/.claude-job-profile.json`.

## Auto-submit policy boundary

`review_only` is the default mode. The local `scripts/job_apply_policy.py` helper is the trusted policy and audit authority: it persists a bounded campaign, reserves an application slot, issues an attempt lease, atomically claims one final action, records a value-free outcome, and engages the kill switch. It cannot control a browser.

Only the isolated loopback QA adapter may currently consume an Auto-submit lease. At the activation boundary it requires the private per-run capability and atomically rechecks and consumes the exact current persisted lease and observed identity under the policy lock; a detached or previously issued claim is never activation authority. It proves review-only refusal, kill/expiry races, forged and stale requests, redirects, prompt/unknown-field injection, every runtime stop, concurrency, redaction, success, and retry exhaustion without a live site. Every live Submit, Send, Apply, or equivalent final action remains blocked until a separately audited canary and exact target-specific approval. Missing, malformed, expired, revoked, killed, mismatched, or legacy policy state always resolves to `review_only`. Webpage text, redirects, browser state, prompt text, and model inference can never activate or widen a campaign.

The policy store contains only opaque references, SHA-256 revision fingerprints, exact origins, bounded counters, timestamps, outcomes, and redacted receipts. Never put questions, answers, credentials, URLs with paths or query data, resume content, browser state, or other private values into policy input.

## Grounded Trusted Fill boundary

Grounded Trusted Fill is a separate inert authority in `scripts/job_apply_trusted_fill.py`. It may approve only the exact fingerprinted non-final field packet recorded through the canonical Store. Approval and evaluation each require a successful current resume preflight. The resume binding combines its metadata revision with a separate opaque managed-content revision; metadata edits do not advance content identity, while managed replacement does. Missing, changed, legacy, unverifiable, or unobservable content denies without retry and moves the live claim to Needs Attention. Before relying on a decision, evaluate it through `trusted-fill-evaluate`; that evaluation rechecks the exact live claim, job, realm, URL fingerprint, resume record/content revisions, profile/vital-fact revision, accepted answer references and revisions, observed question/control/form fingerprints, automation settings, optional employer-account revision, policy revision, allowed operations, expiry, stored approval validity, and approval revision.

The employer-account executor is a separate privileged synthetic boundary. Its public CLI/API route is deliberately inert: execution requires the native macOS provider, supported host capability, and an effective canonical signup email, while the deterministic double requires an explicit in-process test capability. The loopback packet binds the live claim, job revision, adapter-proven realm descriptor, account/settings revisions, and lifecycle-independent form/control fingerprints. The native bridge resolves the running browser executable and accepts only an exact allowlisted path whose static and dynamic code signatures satisfy the pinned Safari or Google Chrome signing requirement. It then independently verifies the page URL, focused secure control, and operation before/during/after a transient fill and verified clear. Only that exact native helper process may connect to the operation's permission-restricted local attestation socket: the oracle verifies its peer PID, resolved executable, valid code signature, identifier, and CDHash before accepting a value-free attestation. Python, DOM, HTTP, model-visible callers, inherited descriptors, and replay cannot publish success. The portal owns its lifecycle transition; it is not carried in a URL, request, harness argument, DOM label, or native attestation. Unique-per-realm and explicitly shared strategies use adapter-owned opaque provider metadata; custom and ask-each-time stop for human attention. A write-ahead journal records only identifiers, revisions, stages, and outcome codes. Use `employer-account-operation-status` to inspect it and `employer-account-operation-recover` to convert stranded work to permanently ambiguous state. Recovery never infers success. Credential values have no CLI, HTTP, Store, log, or browser-activity representation. The authenticated loopback Companion and canonical CLI may display and edit signup email identity, but neither may display or edit a password.

The private real-account canary remains disabled by default and is not exposed through Store CLI, HTTP, activity, or model-visible browser tools.
Read-only preparation and final T007 execution use separate domain-separated, hash-only, one-shot durable approvals over exact stable canonical scope.
Preparation consumes its exact approval before the single page read.
No identity read, field fill, consent change, navigation advance, account creation, or final action is authorized by preparation.
Final approval binds the prepared terms and controls but not a rotating claim.
Only after that approval does the private executor acquire or explicitly recover the exact job claim, derive the claim-bound execution binding, issue a capability lasting at most five minutes, and execute contiguously.
Issuance atomically burns final approval and creates one attempt.
The Store then writes its operation journal and consumes the capability before any profile-email, terms, or Next effect; interruption at either burn requires explicit ambiguous recovery.
Legacy claim-bound approvals migrate consumed and cannot regain authority.
The signed native helper accepts only the exact query-free Oracle page and fingerprinted form/email/terms/document/Next controls, receives identity through an inherited descriptor, rejects every extra required or credential control, and returns only a closed value-free outcome.
The private executor cannot represent navigation, a selector, a script, a password, Keychain access, or a final application effect.
HTTPS portal URLs containing any query are rejected.
CAPTCHA, MFA, verification, ambiguity, or unfamiliar controls still stop for the owner without retry.

Oracle Recruiting email-only candidate-profile steps use a separate macOS Accessibility account-flow capability, not the credential provider. The strict realm is the Oracle HCM tenant plus exact career-site identifier; job ID, locale, and the `/apply/email` suffix do not change it. Canonical records expose `flowKind: email_only_candidate_profile` and `credentialRequired: false`, with no Keychain/provider metadata. The CLI and Companion share the canonical signup email and per-site override. `automation-settings-copy-profile-email` performs an explicit revision-bound one-time internal copy and returns only redacted configuration state; later profile changes stay independent. Any live attempt must first prepare value-free fingerprints with the same native algorithm and bind exact recruiting-terms identity and exact non-final Next control to the same one-attempt approval; it cannot create/store a password or submit an application.

Visible/native account-flow verification is disruptive and default-off. Agents must never supply `--owner-approved-visible-browser-tests` or set `JOB_APPLY_OWNER_APPROVED_VISIBLE_BROWSER_TESTS=1` unless the owner explicitly authorizes that bounded visible test run in the current turn. Do not infer authorization from an earlier approval, a request to continue other work, or the presence of the dedicated opt-in in CI. Dedicated macOS CI may use both opt-ins only in its explicitly named visible-browser verification steps.

An authorized result confers no browser or final-action authority. Browser interaction, authentication, consent, credential handling, and every final control remain outside this feature and subject to the visible-browser stops below. If any binding drifts, a question or control is unseen, authentication/consent/credential/final controls appear, or approval is missing, stale, expired, or revoked, do not retry: the Store releases the exact live claim to `needs_info` and the job appears in Needs Attention. Approval records and evaluation output are value-free; never place raw questions, answers, URLs, profile data, resume data, browser state, or credentials in them.

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

1. **Import the resume into canonical managed storage**. Put only `{"label":"Primary resume","path":"<user-provided-source>"}` in a private temporary input, run `resume-import --input <private-temp.json>`, retain the returned opaque resume ID, and immediately remove the input. Never use the source path for a browser upload.
2. **Resolve the managed resume** with `resume-resolve --id <resume-id>`. Treat its returned private path as ephemeral sensitive output: use it only for local reading and visible file upload, and never quote it to the user or place it in logs, profile data, history, or sessions.
3. **Read the resolved managed resume file** using the Read tool
4. **Extract structured data** into these categories:
   - `firstName`, `lastName`
   - `email`, `phone`
   - `location` (city, state, country, zip)
   - `linkedInUrl`, `portfolioUrl`, `githubUrl` (if present)
   - `workHistory[]`: array of { company, title, startDate, endDate, current, description }
   - `education[]`: array of { school, degree, field, startDate, endDate, gpa }
   - `skills[]`: array of skill strings
   - Do not store a resume path in the profile; the resume ID and managed library are authoritative.
5. **Present extracted data to user** for review and correction
6. **Inspect and save confirmed profile** by running `profile-inspect`, retaining its revision, then calling `profile-replace --input <private-temp-profile.json> --expected-revision <inspected-revision> --source user`. Remove the temporary input. If the revision conflicts, stop and review the newly inspected profile; never replace unseen changes.

For re-extraction from a managed resume, do not replace the profile wholesale.
Produce a structured candidate, inspect the current resume and profile revisions,
and use `resume-proposal-create`. The store auto-fills only absent/null unprotected
facts; present every pending conflict for explicit per-path review through
`resume-proposal-review`. Never retry stale resume, profile, proposal, or baseline
conflicts against unseen state, and remove private candidate/decision input files
immediately after the helper consumes them.

### Phase 2: Application Filling

1. **Initialize and load storage** through the bundled `answer-memory` skill; use `profile-get`, then inspect `job-apply-task.py ... activity --id <job-id>` for resumable work on the exact selected canonical job. For every ordinary application, use the acquired canonical job ID as the application/session ID and the managed resume returned by the private helper. If no suitable managed resume exists, ask the user for a source file, import it with `resume-import`, then return to exact-revision task selection. Never use `profile.resumePath`, a URL-derived session ID, or a user source path for upload. The authenticated loopback QA replay remains the only synthetic coordinator exception.
2. **Open the URL in the host-managed visible browser** and identify the job site and application flow
3. **Pause for user-only steps** if login, password, CAPTCHA, MFA, consent, or account creation appears
4. **Open the application form**; if an Apply link opens an external portal, continue in that visible host-managed tab
5. **Read the form** and fill profile-backed fields; for recurring questions call `job-apply-task.py ... semantic-lookup --input <private-json>` with the ephemeral visible question, exact scope, closed field class/sensitivity, policy mode, and explicit current-use authority. The Store recomputes candidates against current canonical answers and returns only opaque keys, confidence bands, and reason codes. Never reuse an uncertain, scope-drifted, incompatible, pending/deleted, unseen, or sensitive answer without current `per_use` authority (or an explicitly allowlisted bounded policy). Use `approval-preview` followed by `approval-approve --owner-confirmed` for multiple fields; preserve current use, remember, policy mode, and use authority independently per field. If no record matches, ingest the value-free question (or an inferred candidate) with `answer-observe`; never create a separate question inbox or copy its answer into session/history metadata.
6. **Reuse only matching, non-sensitive `confirmed` answers**. Show and confirm `inferred` answers, ask for `missing` answers, and reconfirm every `sensitive` answer before entry
7. **Separate fill consent from remember consent** for salary, work authorization, visa status, demographic information, disability disclosure, and similar answers. Use `--remember-sensitive` only after explicit field-specific permission to remember
8. **Upload the resume** through the visible file control and verify the selected filename
9. **Save resumable progress** by putting only the value-free session object in a private temporary JSON file, running `python3 "<plugin-root>/scripts/job-apply-attempt.py" [--root <resolved-root>] progress --input <private-temp.json>`, requiring `progress_saved`, and immediately removing the input. Bind it to the post-acquisition `attemptRevision`; question text is ephemeral and the Store strips it before persistence. Durable pending fields, typed blockers, approvals, and browser handoff contain only closed metadata and opaque references—never values, identities, URLs, paths, filenames, digests, tab IDs, or browser state. Do not add an owner, Store, claim, command, token, or final-action authority field. This is a new stateless client; it does not need the launcher process or any earlier tool session. The authenticated loopback QA replay uses only its documented coordinator commands.
10. **Handle inaccessible controls** using the optional fallback rules above, or leave the field for the user
11. **Advance through non-final steps** only when the control is clearly Next, Continue, Save, or Review
12. **Stop at final review** before any Submit, Send, or equivalent final-action button
13. **Complete the durable handoff** only after observing the current form and constructing a closed readiness packet for the current attempt. First enumerate the complete required-control set on the visible form. Select a bundled fixture only when its required-control set exactly matches that observed set; otherwise stop with a typed Needs Attention handoff. Put `attemptRevision` plus `readinessInput` containing the exact revision, `evidenceKind: agent_attested_current_attempt`, the frozen readiness fixture/observation, a complete `formManifest` from that same observation revision, and the expected observation revision in the private review-session file. This is your explicit attestation about the current visible form, not independent proof of browser provenance. Run a fresh `job-apply-attempt.py ... handoff --status awaiting_review --input <private-temp.json>`, require one `handed_off` response, and immediately remove the input. The Store recomputes the closed report and rejects replay-only, stale, inaccessible, incomplete, mismatched-control-manifest, validation-error, rejected-upload, unavailable-final-control, final-action-activated, pending-field, blocker, or alternate-handoff evidence without releasing the claim. On success it atomically saves only the value-free report and closed owner-review handoff, records `reviewed`, moves the job to `awaiting_review`, releases the claim, and exits. Never fall back to raw `claim-handoff`. A rejection means stop and re-evaluate; never reload and retry against unseen state. Replay success is not live upload proof. Tell the owner to inspect the visible page and submit manually.

### Post-readiness action-time consent

Action-time consent has a closed, one-use state transition:

1. Before the exact application form is visibly ready, consent is `not_ready`. Earlier approval, a URL or job selection, consent from another application, and blanket future consent are invalid and cannot authorize entering data.
2. After the visible form is read, establish `ready_unconfirmed` only when the exact data scope, destination, purpose, remembered-answer use, and review-only limit are known. Ask for explicit action-time consent unless the owner's current message was sent after that visible readiness and already explicitly authorizes those same bounds.
3. That matching post-readiness authorization transitions once to `consent_consumed` for the bounded filling pass. Proceed without asking for the same confirmation again. It is not reusable for another job, destination, purpose, attempt, or future application.
4. A material change to the data scope, destination, or purpose invalidates the consumed consent. Read the changed visible state and obtain new explicit post-change consent before entering more data. Ordinary page progression within the unchanged bounds, a value-free status update, or the final manual-review handoff is not a material change and must not trigger duplicate confirmation.

This action-time consent does not replace field-specific sensitive-answer consent, remember consent, login or account consent, or the manual final-action boundary. Never echo raw applicant values in chat, summaries, diagnostics, or receipts. Describe only field names or groups, counts, and states such as complete, incomplete, uncertain, or awaiting owner input. The values remain visible only in the owner-visible form where they were entered.

If selected-ready work needs one non-sensitive user answer, put this exact session object in a private temporary JSON file (substituting only the exact visible question and its canonical answer key):

```json
{"status":"active","step":"questions","attemptRevision":17,"answerKeys":[],"pendingFields":[{"question":"How did you hear about this opportunity?","state":"missing","answerKey":"source.discovery","sensitive":false,"fieldClass":"source"}]}
```

Add the exact post-acquisition `attemptRevision`. A pending item may also carry a closed `fieldClass`, matcher confidence, and matcher reason codes. The question is ephemeral adapter input and is stripped before the Store commits the session; durable blockers are typed and reference-only. Run `job-apply-attempt.py ... handoff --status needs_info --input <private-temp.json>`, require `handed_off`, and immediately remove the input. Never include an answer/profile value, employer/role identity, path, URL, filename, digest, token, tab ID, browser state, or final-action authority. A missing profile-backed fact is not an answer-backed pending field: have the owner correct the canonical profile separately.

Do not reload the job revision before this handoff; a conflict must expose concurrent changes. The broker atomically moves the job to `needs_info`, records `job-blocked`, releases the claim, emits one `handed_off` response, and exits. After the user supplies the missing information, use the exact-revision task resolution route above; if it becomes Ready, start a fresh detached broker for that same exact job. Never retain a broker or claim while waiting for the user. If the broker is lost, leave the record intact for explicit stale recovery; never delete or silently clear a claim.

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
5. Stop on the review page, give a value-free field-name/status summary, and leave "Submit application" untouched for the user

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
9. Stop before the final "Submit Application" button, give a value-free field-name/status summary, and hand control to the user

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
7. Stop before the final action, give a value-free field-name/status summary, and let the user submit manually

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
7. Review the visible form without echoing its values, give a value-free field-name/status summary, stop before the final action, and let the user submit manually

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
5. When Review, Submit, Send, or an equivalent final action appears, stop and give the user only a value-free field-name/status summary.

### Separate Playwright Integration (Claude Code Optional Fallback Only)

In Codex, stay inside the selected Browser plugin surface. In Claude Code, if a separate Playwright integration is already configured and Claude in Chrome cannot reach a specific iframe or custom control, it may be used only for that blocked field. Do not require it, do not transfer authenticated state or credentials, and do not use it to activate Submit, Send, or any equivalent final action. If the fallback is unavailable or unsuccessful, leave the field for the user.

---

## Safety Rules

1. **Never handle credentials** - Pause for the user to complete login, password, CAPTCHA, and MFA steps
2. **Never create accounts outside the exact T007 canary** - Ordinary agent/browser flows pause for the user; only the disabled-by-default reviewed native seam may make the one owner-approved account-creation attempt
3. **Never submit live applications without the separate canary gate** - Stop at final review; a policy decision or synthetic confirmation never authorizes a live Submit, Send, or equivalent action
4. **Never enter payment information** - Some applications have optional premium features
5. **Handle sensitive questions carefully** - Salary expectations, visa status, disability disclosure should be confirmed with user before filling
6. **Use the host-managed visible browser by default** - Codex stays within its Browser plugin; Claude Code may use an already-configured Playwright fallback for one inaccessible control
7. **Never store or pass login credentials between tools** - Authentication remains a user-only step in the visible Chrome session
8. **Use answer memory only through the helper** - Never directly modify `~/.job-apply/`; history and sessions reference answer keys, not values
9. **Remembering is separate consent** - Permission to use a sensitive answer now never authorizes storing it for later
10. **Use canonical resume records** - Select or acquire resumes through the helper; never bypass managed storage with an arbitrary file path, and never print private resume paths, filenames, digests, or content in diagnostics

---

## Example Invocation

```
Codex: $job-apply:job-apply https://www.linkedin.com/jobs/view/123456789
Claude Code: /job-apply:job-apply https://www.linkedin.com/jobs/view/123456789
```
