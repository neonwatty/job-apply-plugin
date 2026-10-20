# Python release readiness spec

Status (2026-09-11): PR #75 UX candidate passes CI and scoped installed Companion QA; PR #72 CI hardening continues. Fresh installed calling-agent acceptance is owner-skipped, not passed. Final integration/release acceptance remains open.

## Objective and scope

Release the Python CLI/plugin and HTML/JavaScript workspace with reliable tests,
straightforward setup, verified upgrades, and observed owner workflows.
Refinement PRs target `codex/python-release`; final release targets `main`.
Keep the TypeScript migration independent, with separate Stores and ports.

## Owner-directed revision

The [dogfooding improvement plan](python-dogfood-improvements.md) now controls
implementation order: availability, separately managed optional companion,
UI-free agent onboarding, repeatable intake/readiness, then Facts refinements.
The earlier UI-first setup guide describes the current build, not the target flow.

## Ordered acceptance checklist

Complete these phases in order; record evidence against the exact candidate
commit. Passing synthetic tests does not establish installed-agent or live-site
acceptance. A retry alone does not close a recurring failure.

- [x] **1. Stabilize the baseline.** Diagnose the recurring task-spine
  `answer_save` failure, distinguish test synchronization from product behavior,
  and fix the demonstrated cause. Add a focused regression check and obtain
  passing full, cross-platform, and package validation on the resulting candidate.
- [ ] **2. Simplify setup.** Document supported Python/host prerequisites and one
  agent-first path: install plugin → provide resume → extract/review in chat →
  choose intake → automatic readiness check. Offer the separate companion optionally. Verify launch, stop, relaunch, and actionable failure guidance. Record
  fresh-user completion time, confusion, and assistance required.
- [ ] **3. Qualify installs and upgrades.** Exercise fresh Claude/Codex sessions
  with the installed candidate. Upgrade from the actual previous release using
  a populated synthetic Store; verify package selection and preservation of
  Facts, Answers, jobs, managed files, sessions, and history. Cover both hosts.
- [ ] **4. Audit and refine workspace UX.** Produce a prioritized usability and
  visual backlog covering navigation, layout, readability, terminology, forms,
  and feedback, with acceptance criteria for each change. Walk all eight views and test empty,
  loading, error, conflict, restart, and recovery states. Check keyboard/focus,
  zoom, and smaller windows. Track defects and verify their fixes by journey.
- [ ] **5. Dogfood installed-agent workflows.** Exercise actual PDF/DOCX/TXT
  extraction and review, job preparation, missing-answer resolution, interruption,
  and resumed work. Complete an owner walkthrough. Record tested host/site scope;
  distinguish closed replay from live ATS evidence. Final submission stays manual.
- [ ] **6. Prepare and accept the release.** Coordinate version metadata,
  changelog, upgrade notes, release checklist, and draft PR description. Complete
  final candidate validation and review. Merge to main and verify publication
  only when release acceptance and publication authorization are established.

## Phase 1 investigation and exit criteria

The failure recurred in post-merge run `34403717299`; a separate release-package
run passed on the same commit. The controlled focus race and its fix are recorded below.

1. Preserve failed-run evidence and inspect the answer-save request, activity
   refresh, draft-preservation, and focus-restoration sequence.
2. Add bounded, value-free diagnostic codes where needed to identify the exact
   failed assertion or timeout. Do not record applicant values or raw tokens.
3. Reproduce under isolated synthetic conditions, including relevant timing
   variation. Fix the demonstrated product or test cause without weakening
   assertions, adding blind retries, or substituting arbitrary sleeps.
4. Add a regression case that exposes the original cause. Record a bounded
   repeated-run result, then pass affected and full/package/platform checks.
5. Document cause, fix, evidence, and migration follow-up. Close the phase only
   when the cause is explained and the resulting candidate passes its gates.

## Evidence and tracking

For each phase, record: candidate commit/PR, scenarios and environment, check/run
links, defects and disposition, and remaining limitations. Keep private data out
of receipts. Use isolated fixtures by default; owner-visible native/browser
testing retains its explicit opt-in.

| Phase | Status | Evidence / outstanding work |
| --- | --- | --- |
| 1 | Complete | PR #57 merged; 20 repeated runs, full local/package tests, and CI run `34406170344` passed |
| 2 | Re-scoped | Owner dogfooding completed; agent-first and optional-companion improvements required |
| 3 | Partial / scope revised | Isolated package smoke passes; actual prior-release upgrade remains open; fresh installed-agent sessions skipped by owner |
| 4 | Refined / scoped QA | PR #75 CI and installed Companion receipts pass for recorded journeys; DOCX and uncaptured browser branches remain unqualified |
| 5 | Scope revised | Recorded owner/browser journeys only; fresh installed calling-agent acceptance skipped, not completed |
| 6 | Planned | Final candidate, review, and release |

Record behavioral fixes and TypeScript follow-up in the
[release lane ledger](python-release.md). Update this table as evidence arrives;
historical green checks do not qualify a subsequently changed candidate.

### Phase 1 investigation receipt

Controlled response-body scheduling reproduced a false early focus success:
native answer-dialog closure focused the old action; activity rendering then
replaced that node before the separate identity assertion. The oracle now waits
for the refreshed recheck action and its matching focused edit action together.
The regression fails with the original focus predicate and passes with the fix.
Additional allowlisted stages distinguish response, closure, activity, draft,
and focus failures without exposing response contents.

This establishes a test race, not an answer persistence defect. Historical CI
reports identify only `answer_save`, so they cannot conclusively attribute every
previous failure to this race. PR #57 passed all required checks before merging.


### Phase 2 setup pass

The [setup guide](setup.md) covers prerequisites, workspace launch, resume import,
extraction handoff/review, job preparation, stopping, and returning. Overview now
names its destination and explains the setup journey; waiting extraction requests
say where to paste the handoff. Failed browser opening gives local fallback
instructions without repeating the private URL or exception.

A scripted clean synthetic Store walkthrough verified import, queued extraction,
Facts populated through a prepared extraction candidate, job creation, ready check,
and Ready status after server stop/relaunch. The complete path is retained in
`tests_js/workspace_setup_journey.test.mjs`. This is developer verification, not
an independent fresh-user timing measurement or actual agent extraction acceptance.
Remaining: observe a fresh user following only the guide, record time and assistance,
and verify the host-managed launcher lifecycle on the intended desktop environment.


### Owner setup acceptance record

Use a fresh host conversation and the setup guide without additional coaching.
Record the candidate commit, host/version, OS/Python, elapsed time, extra commands,
confusing steps, and whether help was needed. Stop at a prepared job; no submission
is needed. Use synthetic data for the first pass.

- [ ] Installed skill launches the workspace in a fresh conversation.
- [ ] Resume import and agent handoff are understandable without extra explanation.
- [ ] Actual agent extraction completes; the owner can find and review the result.
- [ ] The owner creates a job, resolves its ready check, and reaches Ready.
- [ ] Stopping and relaunching preserves saved work and opens a working new URL.

The owner has since exercised extraction, review, selected live intake, preflight,
and recovery; see the revised improvement plan. Acceptance is still pending and
this checklist is not evidence that the old UI-first experience was accepted.
Automated test duration is not a human setup time.


Phase 4 observation: Facts provenance is nested inside field labels, so an exact
accessible name such as “First name” changes when provenance loads. Evaluate
separating the field name from its provenance description in the accessibility
walkthrough; the setup regression selects the stable field path after data loads.

### Owner acceptance scope update — 2026-09-11

The owner explicitly skipped fresh installed-plugin calling-agent acceptance for
Claude and Codex because isolated sign-in could not be completed. Record this as
**not completed**, not a pass. Do not pursue further sign-in or substitute package
smoke for actual installed-agent acceptance. Keep the limitation in release notes
and final review. Existing package, controlled browser and installed Companion
receipts retain their narrower scope. DOCX browser-download confirmation remains
unqualified under the host inspection restriction.

Browser closeout for installed Companion candidate
`5ccf85be700f3c4d080623dc8d755038f860425d`: normal-speed readiness action-window
and actual Ready transition passed; changing/restoring the profile invalidated
and recovered readiness with unchanged job revision. Answer Trash toast, restore
view guidance and Automation copy passed. The synthetic answer was restored;
settings and prior environments were preserved. Brief pending-disabled state,
no-scroll and missing-resume-specific branches remain controlled-test evidence,
not independent browser acceptance. This receipt does not qualify later PR #72
changes or remove the skipped calling-agent/DOCX limitations above.
