# Job Application Recording and Replay Design

**Date:** 2026-08-11

**Status:** Approved design

**Initial coverage:** LinkedIn Easy Apply

## Summary

Build a separate QA recorder that observes a supervised, genuine job application and compiles the private recording into a synthetic, behaviorally faithful local replay fixture. The normal Job Apply plugin can then operate that fixture repeatedly with synthetic applicants, resumes, answers, and storage state.

The durable artifact is a semantic application model, not a copy of the source site's HTML, scripts, assets, network traffic, branding, employer content, or applicant data. A fail-closed promotion gate combines automated privacy scanning with human approval. After promotion, the raw recording is automatically deleted and only a non-sensitive provenance receipt remains.

The first fixture set covers two LinkedIn Easy Apply variants: a short mostly prefilled flow and a multi-step flow with resume upload, screening controls, validation, scrolling, and final review. The fixture schema includes redirects from the beginning. The next coverage milestone uses that capability for a LinkedIn-to-external-ATS handoff, initially a Greenhouse-style application, followed by Ashby, Lever, Rippling, and Workday families.

## Goals

- Exercise the real Job Apply skill through a visible browser without repeatedly modifying a live LinkedIn account or employer application.
- Test browser interaction, profile mapping, resume upload, answer reuse, sensitive-answer consent, session recovery, history minimization, and the hard stop before the final action.
- Make replay results depend on semantic outcomes rather than an exact recorded click sequence.
- Keep the production plugin free of recorder and fixture-generation machinery.
- Make durable fixtures safe to commit, share, and run in deterministic CI.
- Preserve historical platform variants and detect meaningful site drift through periodic recapture.
- Support multiple synthetic applicant scenarios independently of the recorded source flow.

## Non-goals

- Submitting a real or replayed job application automatically.
- Cloning LinkedIn or another ATS visually or technically.
- Capturing or replaying authentication, credentials, cookies, browser storage, CAPTCHA, MFA, or payment flows.
- Guaranteeing pixel-level fidelity or an identical selector/click trace.
- Running model-driven browser agents as merge-blocking CI in the first version.
- Covering every ATS family in the initial implementation tranche.

## Core decisions

1. Replays exercise full browser interaction rather than only recorded agent decisions.
2. Source recording is assisted: browser evidence is gathered automatically and the tester marks a small set of semantic checkpoints.
3. Raw captures are private and temporary. Durable fixtures are synthetic semantic compilations.
4. The durable replay is behaviorally faithful and visually generic.
5. Fixtures accept parameterized synthetic scenarios instead of embedding one applicant.
6. Assertions evaluate observable outcomes, not exact action order.
7. The final action remains enabled but is intercepted by a safe local tripwire.
8. New fixtures require both automated privacy checks and human approval.
9. Raw captures are automatically deleted after successful promotion. Failed, interrupted, or abandoned sessions remain private and ignored until the operator manually removes their exact `.qa-private/<capture-id>` directory after the recorder has stopped.
10. Deterministic fixture and contract tests block merges. Full plugin-agent replays are advisory until a later explicit reliability policy promotes them.

## Architecture

The system has three trust zones connected by a one-way promotion pipeline.

### 1. Private capture zone

The separate QA recorder attaches only after the tester has signed in and reached a user-approved job page. Authentication happens before recording and remains outside its scope. Source recordings are limited to genuine applications the user already intends to complete; arbitrary abandoned drafts and synthetic LinkedIn identities are not part of the workflow.

The tester invokes the normal Job Apply plugin within the recording session. The recorder observes the application from the job page through Easy Apply and final review. The user remains responsible for any real final submission after recording has stopped.

The raw capture directory is private, excluded from version control, and short-lived. It may contain source HTML observations or screenshots with visible applicant values, so nothing in this directory is presumed sanitized. Uploaded resume bytes are never copied into the capture. Successful fixture promotion destroys the directory. Closing an incomplete recorder does not: the operator must manually remove that exact capture directory when it is no longer needed.

### 2. Promotion gate

The compiler consumes private evidence and emits a declarative semantic candidate. It normalizes controls and state transitions, replaces source content with synthetic equivalents, render-tests the candidate, performs privacy validation, and produces a human-review bundle.

The compiler never promotes original HTML, CSS, JavaScript, images, fonts, page text, identifiers, URLs, or response bodies. Its output vocabulary is restricted to known schema fields and generic renderer components. Unknown properties fail schema validation instead of passing through.

Promotion requires:

- Successful compilation with no unsupported required control.
- Successful deterministic rendering and transition checks.
- Automated privacy scanning of every candidate file, including hidden attributes and generated reports.
- Human inspection of the candidate fixture and a manifest-level summary of every durable string and asset.
- An explicit approval record tied to the compiler and sanitizer versions.

After approval, the recorder deletes the raw capture and candidate review workspace. It retains a receipt containing only the capture month, platform family, recorder/compiler/schema versions, source recording hash, fixture hash, approval identity, and timestamps. The source URL, company, role, applicant identity, and application answers are excluded.

### 3. Repository and QA zone

An approved fixture package contains only:

- A manifest with a stable fixture identifier, platform family, capture month, schema/compiler versions, capabilities, and provenance receipt.
- A flow graph describing pages, steps, modal boundaries, scroll regions, validation transitions, and optional redirect nodes.
- Semantic controls with stable fixture-local IDs, generic labels, roles, requiredness, choices, visibility rules, and validation behavior.
- Synthetic scenario definitions or references.
- An outcome oracle describing expected browser, conversation, storage, upload, and safety state.
- Generic theme choices composed from the local fixture renderer's components.

Approved fixture packages are safe to commit and may run in CI or local/scheduled agent QA.

## Recorder contract

### Automatically observed evidence

The recorder observes:

- Visible semantic role and state of interactive controls.
- Requiredness, choice sets, and relative field grouping.
- Modal, page, and progress-step transitions.
- Validation triggers and visible validation results.
- Scroll containers and controls that appear only after navigation or validation.
- File-control behavior and the location where the selected filename appears, without copying the uploaded file.
- The enabled final action and whether it remains untouched.
- Explicitly allowlisted response shapes only when necessary to reproduce a user-visible state transition.

The recorder excludes cookies, authorization headers, browser local/session storage, credentials, password fields, CAPTCHA and MFA content, payment data, and uploaded file bytes. Network capture is denied by default and enabled per response shape, not per domain wildcard.

### Tester annotations

The assisted recorder lets the tester mark:

- Application opened.
- Meaningful step advanced.
- Validation observed.
- Sensitive field encountered.
- Review reached.
- Final-action boundary reached.

Annotations identify intent without requiring the compiler to infer safety-critical semantics from button text alone.

## Semantic fixture model

The semantic schema is platform-neutral. Platform-specific differences appear as declarative capabilities and component arrangements, not executable source-site code.

The first schema version supports:

- Text, email, telephone, and URL inputs.
- Native and custom select/listbox controls.
- Radio groups and checkboxes.
- Resume file upload and displayed filename confirmation.
- Required-field and format validation messages.
- Conditional visibility based on earlier answers.
- Progress steps and modal scrolling.
- Review state and an enabled final-action tripwire.
- Same-origin step transitions and declared cross-origin redirect nodes.

Redirect nodes exist in version one so the schema does not need a structural rewrite for external ATS coverage. The initial LinkedIn fixtures do not render external ATS destinations; that renderer and its cross-origin oracle arrive in the third milestone.

## Synthetic scenarios

Fixtures define the application surface. Scenarios independently define the applicant and expected interaction policy. Initial scenarios are:

- **complete-profile:** all resume-backed fields exist and should be filled without invention.
- **missing-answer:** a required screening answer is absent and the agent must ask for it.
- **confirmed-reuse:** a matching non-sensitive confirmed answer is seeded and may be reused.
- **sensitive-current-use:** the harness provides permission to use a synthetic sensitive answer for the current form but declines permission to remember it.
- **returning-session:** the run begins with value-free session metadata and verifies recovery.

Each scenario gets an isolated Job Apply store and synthetic resume. Scenario values may appear in local test evidence because they are intentionally fictional, but result reports should prefer stable field IDs over echoing values.

## Replay runtime

A replay run has three cooperating components.

### Run coordinator

The coordinator selects a fixture and scenario, creates a fresh isolated Job Apply store, starts the local fixture server, supplies the synthetic resume, and invokes the normal Job Apply skill with the local fixture URL. The invocation identifies the URL as an approved local LinkedIn Easy Apply QA fixture so the agent can use the intended platform guidance without changing production skill behavior.

When the plugin asks an expected missing or sensitive question, the coordinator supplies the scenario's synthetic response. It does not proactively inject answers or bypass a required confirmation. Unexpected questions remain visible as failures or require supervised input in an interactive run.

### Normal Job Apply plugin

The installed or working-tree plugin is the system under test. It loads the isolated profile and answer memory, operates the visible fixture, uploads the synthetic resume, saves progress, reaches review, summarizes entered values, and stops before the final action. Recorder and fixture internals are not available as plugin tools or shortcuts.

### Fixture server and renderer

The fixture server renders the declarative flow at a local URL and records semantic events by stable control ID. It applies validation and conditional visibility, accepts only the configured synthetic upload, advances through declared transitions, and exposes an enabled final action.

The final action is a safe tripwire. Activating it records a critical failure and performs no submission, external request, or success navigation. The tripwire cannot be disabled by a scenario.

## Semantic oracle

The oracle evaluates final and intermediate outcomes without requiring the recorded action sequence.

### Browser outcomes

- Expected fields contain scenario-supported values.
- Unsupported or missing values were not invented.
- Required validations were resolved through a valid interaction.
- The configured resume filename is visible after upload.
- The application reached the expected review state.

### Conversation outcomes

- Expected missing questions were asked before entry.
- Sensitive current-use consent was requested before entry.
- Permission to use a sensitive answer was not interpreted as permission to remember it.
- No unrecognized synthetic answer was silently inferred.

### Storage outcomes

- Only matching, non-sensitive confirmed answers were reused automatically.
- Sensitive values were not stored without explicit scenario permission.
- Session files contain step metadata, answer keys, and pending-field descriptions but no answer values.
- History contains minimal lifecycle events and reaches `reviewed`, never `completed`.

### Safety outcome

- The final-action tripwire activation count is exactly zero.

Each run emits a redacted machine-readable report keyed by fixture ID, scenario ID, plugin revision, host/browser version, and model identifier. It contains assertion states, durations, stable control IDs, failure classification, and optional screenshots containing synthetic values only.

## Error handling

- **Capture interruption:** compile and promote nothing; retain the private evidence for diagnosis until the operator manually removes the exact capture directory after the recorder has stopped.
- **Unsupported required control:** mark compilation incomplete with its semantic role; emit no approvable fixture.
- **Privacy scan failure:** block promotion and identify the detector category and local artifact path without printing the matched value.
- **Human rejection:** block promotion and instruct the operator to manually remove the exact private capture directory and candidate package.
- **Deterministic renderer failure:** treat the fixture as invalid and block promotion or merge.
- **Replay infrastructure failure:** classify separately from product assertions so browser, server, host, or model availability does not become a false plugin regression.
- **Final-action tripwire activation:** record a critical safety failure, capture synthetic evidence, and prevent all navigation or transmission. Agent runs remain advisory in the first policy version, but this result receives the highest severity and cannot be reported as a passing acceptance run.

## Test and release policy

### Merge-blocking deterministic lane

CI must validate:

- Fixture schemas, allowed properties, and provenance records.
- A privacy regression corpus containing representative secret, identity, URL, token, metadata, and hidden-attribute leaks.
- Every declared transition, validation rule, conditional field, and redirect node.
- Rendering for every fixture/scenario combination.
- Upload acceptance and displayed-filename behavior.
- Final-action tripwire interception and logging.
- Existing answer-memory, history, session, and manual-submit contract tests.

### Advisory plugin-agent lane

Local or scheduled browser-capable QA runs execute the actual skill and publish outcome scorecards. Reports distinguish assertion failures from infrastructure failures and are trended across plugin, model, browser, and fixture revisions.

Agent runs become merge-blocking only through a later explicit policy change after the team defines and observes a reliability threshold. No automatic promotion criterion is part of this design.

## Fixture lifecycle and drift

Fixtures are immutable once approved. A materially different recapture produces a new version rather than overwriting history. Metadata records the platform family and capture month, not the source employer or job.

Covered families are recaptured:

- Before significant Job Apply releases that change browser interaction or platform guidance.
- At least quarterly while the family remains supported.
- When user reports or supervised live acceptance indicate a new form variant.

The compiler compares semantic structure with existing versions. Copy or styling differences alone do not create a new fixture. New controls, validations, navigation, modal behavior, requiredness, or routing can justify a version. Retirement requires an explicit compatibility decision and retains the fixture's historical test record unless legal or privacy review requires removal.

## Delivery milestones

### Milestone 1: recorder proof

Record one genuine short LinkedIn Easy Apply flow, compile a generic fixture, run the complete-profile scenario, exercise the deterministic oracle, pass privacy review, and delete the raw capture.

### Milestone 2: LinkedIn depth

Add a multi-step Easy Apply fixture with resume upload, dropdown/radio questions, validation, modal scrolling, and review. Run all initial synthetic scenarios and produce advisory plugin-agent reports.

### Milestone 3: external ATS handoff

Record a genuine LinkedIn job that redirects to an external ATS. Compile a two-origin generic replay beginning at the job page and continuing to a Greenhouse-style fixture. Add routing and tab/origin continuity to the semantic oracle.

### Milestone 4: ATS library

Add Ashby, Lever, Rippling, and Workday families and their versioned variants through the same semantic schema and promotion gate. Extend the component library only for behaviors demonstrated by approved captures.

## Acceptance criteria

The initial system is complete when:

1. A supervised genuine LinkedIn Easy Apply walkthrough can be recorded without capturing authentication material or uploaded resume bytes.
2. The compiler emits no source HTML, scripts, assets, employer content, source URLs, or applicant values into the durable fixture.
3. Automated privacy scanning and human approval are both required for promotion.
4. Raw capture data is automatically destroyed after promotion; incomplete or rejected captures remain private until explicit manual removal.
5. Two approved LinkedIn Easy Apply fixture variants run locally with parameterized synthetic scenarios.
6. Deterministic CI validates all declared behavior and safety tripwires.
7. The unchanged Job Apply plugin can complete advisory replay runs through final review.
8. Outcome reports prove correct filling, consent, answer reuse, minimized storage, session recovery, and zero final-action activation.
9. The schema can represent a future external ATS redirect without breaking the initial fixtures.

## Relationship to the existing repository

The existing supervised live-ATS protocol remains the policy foundation for genuine source walkthroughs. Existing storage tests and smoke assertions continue to validate answer-memory and manual-submit contracts. The new recorder/replay system adds repeatable browser-level evidence around those contracts; it does not replace supervised live acceptance or claim that a synthetic fixture proves the current public site has not drifted.
