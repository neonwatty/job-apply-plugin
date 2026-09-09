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
