# Python dogfooding improvements

Status: implementation started after the owner walkthrough on 2026-09-09.
Supersedes the UI-first onboarding sequence in the original readiness plan.
Owner acceptance remains open. All PRs target `codex/python-release`.

## Priorities and acceptance

| Order | Work package | Acceptance |
| --- | --- | --- |
| 1 | Running-workspace availability | Removing a disposable plugin installation after launch preserves all allowlisted assets, HEAD, authentication and ordinary Store operations; missing startup assets fail before Store initialization. |
| 2 | Independently installed optional companion | Plugin install/use succeeds without companion files or a running UI. Companion has a stable installation, launch/stop/restart, upgrade and compatibility contract independent of host caches. |
| 3 | Agent-first resume onboarding | Ask for a local resume path; import and extract through managed storage; provide a readable chat review. Facts is an optional review/edit destination, not a prerequisite. |
| 4 | Repeatable intake and automatic checks | After resume review, offer owner-selected browser/URL intake or manual Jobs entry. Replenishment deduplicates and preserves workflow states. Run readiness automatically after intake. |
| 5 | Facts editing | Fact-type tabs, keyboard-accessible sticky Save, drafts preserved across tabs, and straightforward editing of promotion-related positions and shared descriptions. |
| 6 | Repeat acceptance and release qualification | Exercise UI-free and companion-assisted flows, compatible upgrades, restart, and owner feedback before final release acceptance. |

## Companion separation contract

The companion must not serve or import its runtime from a host plugin cache.
An in-memory asset snapshot is interim protection, not the new installation model.

- Distribute and install the companion separately in a stable user-managed
  location, with its own version and pinned runtime dependencies. Plugin removal
  or upgrade must not remove companion code, stop it, or mutate its Store.
- Keep the agent CLI operational in a normal plugin installation without a UI
  dependency. An optional workspace skill may discover and launch an installed
  companion or explain how to install it; it must not require installation for
  resume review, intake, or readiness.
- Extract a supported versioned Store/core interface shared by the CLI and
  companion. Both retain canonical locking, revisions, recovery and privacy
  semantics; the UI must never become a second database or write raw Store files.
- Define supported core/API and Store-schema versions before opening the Store.
  Incompatible combinations must fail with actionable guidance before writes,
  initialization, migration or recovery. Test supported mixed-version clients.
- Launch and status must identify companion version and selected Store without
  exposing its browser token. Preserve loopback/authentication boundaries.
- Upgrades install complete versioned bundles before switching the launcher.
  Running processes retain their version until an explicit restart. Document
  rollback limits when a Store schema has advanced; never silently downgrade data.
- Package tests must prove the plugin excludes UI assets/server, the companion
  runs with the plugin absent, and neither installation modifies applicant data.

Before implementing package extraction, document the chosen distribution format,
core public API, installation paths, compatibility matrix and upgrade commands in
a focused design. Prefer the existing Python runtime and avoid adding a new
service or frontend build requirement for owners.

## Onboarding and intake behavior

Agent-first review must be usable in chat when the companion is absent. Update
the current skill policy that forbids applicant values in chat to reflect the
owner's explicit request for a readable parse review. Distinguish user-directed
review in the conversation from public diagnostics, logs and receipts, which stay
value-free. Managed paths, credentials and claim authority remain private.

Ask for an intake source/count or offer manual entry after resume review. Do not
substitute a synthetic job or start browsing an unspecified source. Intake is
user-invoked and repeatable, not a recurring search automation.

Resume selection for readiness is: explicit job assignment, otherwise default,
otherwise the sole active usable resume. A broken explicit assignment is a
blocker, not permission to silently substitute another document. Ask only for
ambiguous selection or genuine blockers. Specify whether a sole-resume selection
is persisted and ensure preflight and application acquisition use the same choice.

Passing preflight, setting a job to Ready, and initiating an application remain
distinct. Automatic checks do not authorize either subsequent action. Preserve
existing job states during replenishment and keep final submission human-only.

## Evidence and current scope

The owner completed agent-led extraction/review and selected three live job
results for intake. All three passed preflight and remained saved; no applications
started. Recovery preserved Facts, the resume, and the job records. This is
dogfooding evidence, not final acceptance or a measured independent setup time.

Installed candidate directories repeatedly disappeared while a workspace process
remained alive. Disposable-package removal reproduced the asset failure. Host
cache-discovery warnings from browser helper clients are a lead; the exact
deleting process and version replacement cause remain unproven.

Implementation begins with the supplied defensive four-file patch from the owner
walkthrough investigation, based on `f1c8602`. This PR adopts that patch and
records the revised plan; it does not install into or restart the live walkthrough.
The stable walkthrough source and its explicit Store must remain untouched.

Keep a behavioral forward-port ledger in [python-release.md](python-release.md).
Coordinate compatible core contracts and lifecycle guarantees with TypeScript
work through dedicated follow-ups; do not overwrite migration files or share a
live Store between implementations.

### Companion separation implementation

The UI/server extraction and independent installer are now implemented in
[companion](../companion/README.md), including distribution boundaries, stable
launch/restart, atomic version selection and core compatibility checks. Agent-only
plugin output is built with `python3 scripts/build-plugin.py`. This supersedes the
interim-only scope above. The owner's live walkthrough has not been replaced;
owner acceptance and the other onboarding/Facts work packages remain open.

### Agent onboarding implementation

Agent-first routing, explicit extraction request creation, conversational review,
repeatable authorized queue intake and automatic agent preflight are implemented.
The canonical selector uses assignment/default/sole active resume without changing
saved job states. Focused synthetic regressions cover ambiguity, broken choices,
acquisition consistency, and repeat intake. Full owner dogfooding, manual UI
readiness presentation, and the Facts editing work package remain to be qualified.

### Facts editing implementation

The optional companion now offers separate Work history, Education and Skills
fact tabs alongside contact/location/link views and saved custom groups. Tabs
support arrows/Home/End and retain the same draft controls. A single sticky Save
action remains visible on desktop/mobile, saves changes across all tabs, and
supports Ctrl/Cmd+S outside dialogs. Existing revision-conflict handling remains
in force.

Work-history rows have numbered headings and full-width descriptions. Add
promotion creates a draft role with the same company/description and blank title
and dates. Copy description to company roles asks before replacing other matching
roles' descriptions; unrelated employers and other fields stay unchanged. No
shared-description schema or inferred career facts were introduced.

Synthetic browser checks exercise desktop/mobile visibility, keyboard tab
selection, drafts across tabs, promotion fields, cancelled/accepted description
copying, unknown-field preservation, and persisted multi-tab edits. Owner review
and complete release dogfooding remain open.
