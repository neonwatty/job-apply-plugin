# Python plugin release lane

## Branches and checkout

- Release integration: `codex/python-release`, based on `3319033` (PR #47).
- Migration integration: `staging`; its TypeScript/React work continues independently.
- Release checkout: `/Users/neonwatty/Desktop/job-apply-python-release`.
- Release destination: `main`, through a draft PR until acceptance is complete.
- Refinements: separate `codex/python-*` branches/worktrees with PRs into the release branch.

The baseline includes Python CLI/domain modules, Python HTTP service, the HTML/JS
workspace, onboarding/extraction improvements through PR #46, and the modularization
and test tiers from PR #47. Its plugin version is 1.3.5; choose and synchronize the
actual next release version only during release preparation.

## Post-baseline audit

| Change | Decision |
| --- | --- |
| PR #51, skills cleanup (`4f6fcbe`) | Backported with source attribution; preserve recursive skill packaging checks, omit the absent TypeScript runtime tree from the inventory. |
| PR #50, local hooks (`f18fcda`) | Deferred: unconditionally invokes `build:check` and contains migration-only focused rules. Run existing Python test tiers directly. |
| PRs #48 and #49 | Excluded: TypeScript foundation/contracts/runtime evidence and later staging CI changes. |
| PR #52 and later native/React tranches | Excluded: migration integration; Python helper bridge changes depend on TypeScript runtime. |

Do not import staging wholesale. Audit any later independent defect fix by behavior
and dependencies before backporting. Historical checkpoint verification is evidence
of prior work, not current release acceptance.

## Protection and CI

Validate Plugin and Release Validation include this branch in push filters; Validate
Plugin also includes PRs targeting it. Protect the branch against deletion and force
pushes, require PRs, and require the GitHub Actions `PR gate` with an up-to-date base.
Keep the retained full cross-platform lanes until their existing equivalence gates
are met. Nightly schedules run from the default branch; they are not a claim of
scheduled release-branch coverage. Use explicit branch dispatch when needed.

## Release acceptance

### Running workspace and plugin cache replacement

The Python server snapshots its allowlisted static assets before initializing the
Store or binding a port. An already-running server therefore keeps serving its
original UI when its installed plugin directory is removed or replaced. Missing
assets at startup abort with a sanitized reinstall/restart message. This does not
prevent host cache replacement or make a deleted CLI executable restartable.

Regression coverage removes a disposable complete installation after startup and
checks every asset route, HEAD, authenticated job creation/readback, and rejected
unauthenticated access. An incomplete asset tree must fail before Store creation.
Migration follow-up: apply equivalent lifetime ownership to the TypeScript/React
server assets; do not share its Store with the Python witness.

Track execution in the [Python release readiness spec](python-release-readiness.md).

- [ ] Current release-head portable full tests pass.
- [ ] Required Linux, Windows, and macOS CI jobs and aggregate PR gate pass.
- [ ] Isolated fresh Claude/Codex installation and upgrade/package smoke pass.
- [ ] Browser walkthrough covers Overview/Jobs, Facts, Resumes/extraction, Answers,
      Needs Attention, Application Activity, and Trash, including reload/recovery.
- [ ] Owner UX refinement and final review are complete.
- [ ] Version, changelog, manifests, and upgrade notes are coordinated.
- [ ] Release PR is reviewed and merged to main, then publication is verified.

Use separate synthetic Stores and ports for both implementations. Do not activate
TypeScript against the Python Store. Native tests that interact with the owner's
visible browser retain their explicit opt-in.

## Forward-port ledger

Record each release fix as: release commit/PR, behavior changed, affected contract,
regression check, migration follow-up, and incorporation status. Translate behavioral
fixes into native code where needed; do not mechanically overwrite migrated files.
After the Python release, reconcile main into staging in a dedicated integration PR.

| Release change | Migration follow-up |
| --- | --- |
| Skill cleanup from PR #51 | Already present in staging. |
| Release branch CI and guidance | Branch-specific setup; preserve migration CI policy during later reconciliation. |
| PR #56: UTF-8 legacy report fixture | Forward-port the explicit UTF-8 fixture write to staging; its suspended CI did not establish Windows acceptance for this backported test. Pending. |
| Phase 1: task-spine answer-return synchronization | Test-only fix: wait for refreshed actions and focus together; controlled response-body regression and value-free stages. Audit migration oracle for the same race and port its behavioral check. Pending. |
| Phase 2: setup guidance and browser-open fallback | Port user-facing handoff wording where applicable; validate the migration launcher independently. Pending. |
| Workspace asset lifetime hardening | Adopted from owner investigation patch; reproduce package removal/startup failure in migration runtime. Interim only; companion separation remains required. Pending. |

### Independent Python companion

UI assets and HTTP implementation now live under `companion/`. The agent-only
marketplace build excludes them; a separate Python installer creates immutable
versioned runtime bundles outside host caches. The plugin workspace command is
only an optional installation discovery launcher. See
[installation and compatibility](../companion/README.md).

Migration follow-up: preserve the independent installation and optional-agent
contract when introducing the TypeScript companion. Python contract 1 does not
assert compatibility with migration writers or authorize a shared live Store.

Windows lifecycle follow-up: companion/discovery launchers run the selected entry
point in the attached Python process. Do not use `os.execv` for portable process
ownership: on Windows the original process can exit while the server retains its
pipes. Startup tests use a bounded wait and verify launcher termination stops the
server. Preserve this lifecycle guarantee in the TypeScript companion launcher.

### Agent-first onboarding and readiness

Onboarding imports or uses the selected managed resume, creates an exact extraction
request, completes semantic extraction in the active agent, and presents owner
review in chat. It preserves confirmed facts and offers optional browser/manual
job intake after review. Queue instructions reuse existing authorization for the
selected scope and run preflight after create/update/noop commits.

Job preflight now resolves assignment, default, then sole active resume, retaining
all ordinary file/integrity checks. It does not persist a default or assignment;
multiple active resumes remain ambiguous, and broken explicit/default choices
never silently fall back. Acquisition consumes the same preflight result. Facts
preparedness and resume-choice labels recognize the sole-resume path as well.

Forward-port these selection semantics and agent routing independently to the
TypeScript lane. Tests use prepared synthetic extraction facts to verify Store
behavior; they do not establish semantic extraction quality or owner acceptance.
Manual UI intake can be checked when the owner returns to the agent; automatic
checks do not imply a background agent or an automatic Ready/status transition.

### Facts UI refinement

Fact-type tabs, a sticky Save action and promotion/description editing live only
in the independent companion. Existing canonical paths, atomic work-history
patches and revision-conflict protection are retained. Forward-port the visible
editing behavior and keyboard/draft guarantees to the TypeScript companion;
do not share a live Store or merge its implementation wholesale.

### Navigation and resume discoverability follow-up

Owner findings UX-02/03/04: retain Pipeline (Overview, Jobs, Needs Attention),
Application Data (Facts, Resumes, Answers), and Controls (Automation, Trash).
Use a compact sticky header with grouped dropdowns and a mobile Menu disclosure.
The Job Apply brand links to Overview through the same navigation coordinator,
preserving Facts drafts and the selected tab.
The Ink & blue foundation applies neutral surfaces, readable light/dark colors,
consistent compact page headings and reduced-motion-aware transitions across
all eight destinations. Navigation resets scroll and focuses the destination
heading; Escape dismisses menus. Profile readiness lives on Overview and opens in a side panel from Facts,
preserving the current tab and draft. A sun/moon button toggles light/dark with
reduced-motion-aware transitions and persists the browser preference.
Move Facts section selection before readiness, reduce its introductory spacing,
and explain draft retention. Existing tabs and all-facts view remain available.
Expose View PDF, Preview text, or Download DOCX on managed resume cards and in
Manage. The existing authenticated content route and format support are unchanged.
Forward-port these navigation and discoverability behaviors to TypeScript separately.

The owner browser's localhost port matched the recorded candidate companion PID;
no page navigation, restart, installation replacement, or Store mutation was used
for that identity check. Automated synthetic PDF checks verify authenticated bytes,
unauthenticated rejection and the browser-open action. Headless shell cannot qualify
visual PDF rendering; owner PDF readability and UX acceptance remain open.

Motion polish: readiness opens and closes with a short slide; Escape, close and
backdrop clicks share dismissal and restore focus. Menus transition both ways,
page/tab content fades briefly, and reduced-motion preferences disable movement.
Forward-port these interaction details with the UX foundation.

Verification follow-up: abandoning a response body and immediately stopping the
server reproduced a request-thread stderr/finalization failure on Python 3.9 and
3.12. The orderly-shutdown test now consumes the response before stopping.
Abrupt-disconnect shutdown deserves a separate regression/fix before final release
acceptance; this UX change does not alter server shutdown behavior.

CI timing fixes: retire the attempt broker socket and PID before acknowledging a
terminal request, so an immediate review restart cannot reach a retiring broker.
A regression deliberately delays shutdown and verifies the replacement remains
reachable. Job dialogs now focus synchronously when opened; deferred focus could
interrupt editing. Trash focus skips cards absent from the refreshed canonical
list. Forward-port these broker lifecycle and focus fixes to the TypeScript lane.

UX-05: resume-card preview now reads the existing managed document directly,
without opening metadata/replacement controls. Manage separates current-document
actions from replacement. Preview/download, library and extraction-review errors
identify the failed operation and connection/authentication recovery steps.
Dogfooding port 61200 had no listener during investigation; its attached process
handle was unavailable, so the reason for its exit is unknown. This change does
not repair or restart that instance. Browser policy restriction HOST-03 and owner
PDF readability acceptance remain open; synthetic HTTP/action checks are separate.
Forward-port these direct-preview and error-context changes to TypeScript.

UX-06: PDF preview stays in the Companion tab using a modal embedded viewer,
with Close/Escape returning to the previous view. Authenticated bytes become a
short-lived blob URL, revoked on close; late responses cannot reopen the viewer.
An explicit download fallback remains available for unsupported or blank native
PDF renderers. TXT and DOCX behavior is unchanged. Embedded readability requires
owner acceptance; isolated headless tests verify wiring, not native rendering.
Forward-port this presentation and cancellation behavior to TypeScript separately.

### Desktop Facts conflicts and TXT preview focus

Facts comparisons now ignore JSON object key order, including nested work-history
objects. PATCH responses and subsequent canonical reads can serialize identical
objects differently; this must not create a conflict on the next save. Array
order, missing fields, and changed values still participate in conflict checks.
TXT preview restores focus to its invoking button after Close or Escape, with a
current-card fallback if the resume list was refreshed while the dialog was open.

Migration follow-up: use semantic JSON comparisons for draft bases and restore
focus by stable resume identity when preview triggers are replaced. These desktop
regressions use isolated synthetic data; owner walkthrough acceptance and
smaller-screen QA remain separate.

### Desktop readiness and recovery feedback

Workspace refresh still invalidates readiness proof, but now leaves a visible
instruction to rerun the check instead of silently removing its result. Pending
checks announce progress. Restoring a Trash record returns focus to a remaining
Restore button or Refresh when the list is empty, without pulling focus back
from another workspace.

Incomplete job cards show hostname/path (excluding URL credentials, query and
fragment). Empty search views offer Clear filters. Answer trash grammar, custom
Facts view summaries, job conflict field labels, and Automation wording are
clearer; technical field-permission inputs are behind an advanced disclosure.
Authorization, revision checks, and final-submission boundaries are unchanged.

Migration follow-up: preserve stale-readiness explanations, contextual focus,
filter recovery, and progressive disclosure. The reported education date format
and DOCX download-event timeout remain separate investigations. The observed
ready-check disappearance was reproduced via refresh invalidation; the original
walkthrough timing has not been established. Desktop owner retest remains open.

Work and education date fields explicitly describe the existing free-text
contract, with year and year-month examples. Existing partial dates remain
valid; this is guidance, not a new parser or Store migration.

Review follow-up: a ready-check attempt during an in-flight refresh now uses the
transient readiness status, so a successful retry clears its explanation. Answer
Trash guidance identifies the previous view rather than promising Library for
pending or declined answers. Preserve these behaviors in the migration UX.

Package oracle failures now distinguish second acquisition, managed-resume
continuity, review-fixture preparation, and review handoff using allowlisted,
value-free stages. This improves diagnosis without exposing applicant data or
weakening acceptance; an intermittent second-acquisition-stage CI failure remains
unattributed until those diagnostics identify it or reproduction establishes it.
