# Agent Workflows automation and Trash readiness receipt

Date: 2026-09-18

Base: `origin/staging` at `9a7e56ee5426e3334918bd0017f959a78a530144`

Branch: `codex/agent-workflows-automation-trash-journey`

Repair base: `d537abe396e0bcd6a088349b0cd7730efe372a38`

Repair branch: `codex/repair-automation-trash-training`

## Scope and outcome

This receipt covers candidate authoring, fictional fixture preparation, direct
product observation, validation, and deterministic hash computation. It does
not claim a Training run, runner evidence, promotion, ATS interaction, employer
action, account creation, credential use, application claim, final action, or
submission. No `workflow train` or run-creation command was executed.

The candidate is bounded to an isolated Store and a committed synthetic fixture.
Its fixture creates one fictional job, managed resume, and confirmed answer,
then moves each record to local Trash with revision-checked native commands. The
browser journey verifies the closed Automation boundary, enables local controls,
adds one fictional Workday-shaped URL as a local record without following it,
inspects the non-final Trusted Fill boundary, restores all three records, and
ends with the job still `saved`, with no active application claim or session.

## Existing evidence inspected

The journey is derived from the existing TypeScript Phase C product dogfood and
receipt:

- `docs/dogfooding/2026-09-17-typescript-automation-trash-tranche.md`
- `docs/dogfooding/2026-09-17-typescript-automation-trash-tranche-receipt.json`

Those results establish the previously observed product boundaries: live
execution disabled, provider setup unavailable, exact non-final Trusted Fill
operations, revision-conflict no-retry behavior, redacted Trash projection,
job/resume/answer restoration, and zero application completion or applied
events. This candidate does not elevate those direct dogfood observations into
Agent Workflows evidence.

## Historical supervised execution and bounded repair

A later supervised session produced one completed desktop run after two
invalidated attempts. The completed run is retained as historical evidence only:
the session-level retries mean it is not fresh lifecycle proof and it must not
be used for promotion. No mobile run was started. The session exposed four
repairable findings addressed by this change:

- the native `summary` was present in accessibility state but lacked an explicit
  button role for the supported semantic Playwright lookup;
- desktop and mobile orchestration reused one product Store basename, so moving
  only the active Store left its native rollback sibling bound to the mobile
  startup path;
- the mobile candidate resolved 390 by 844 instead of the required 393 by 852;
- the live-region shell copy rendered `1 records are in Trash.`

The repaired candidate gives the settings disclosure an explicit button role,
uses distinct desktop and mobile product Store basenames under the same isolated
runner root, resolves mobile to 393 by 852, and pluralizes the Trash status.
Focused manifest and production-browser tests cover those boundaries. No new
live Training run was created for this repair.

## Direct UI observation

Companion was built and opened against two new disposable Stores under
`/private/tmp`. The explicit legacy-profile paths were absent. The canonical
Store was not read, cloned, or mutated.

Observed Automation copy and controls included:

- `Account preparation Off`
- `Live actions off`
- `Workday setup unavailable`
- `Greenhouse status unresolved`
- `Oracle setup unavailable`
- `Trusted Fill approvals`
- `Advanced controls for exact, non-final field operations`
- `No Final Action`

Observed Trash behavior included redacted cards for exactly one job, one resume,
and one answer; per-record `Restore` and `Delete permanently…` controls; a local
`Restore record?` confirmation; and the saved-mutation notice that restoration
must not be repeated if refresh fails. Restoring the synthetic job changed the
visible counts from 1/1/1 to 0/1/1 without creating an application claim,
session, or status transition.

The browser viewport was explicitly measured on both Automation and Trash:

| Platform | Viewport | Automation scroll width | Trash scroll width | Overflow |
| --- | ---: | ---: | ---: | --- |
| desktop-web | 1440 × 900 | 1440 | 1440 | false |
| mobile-web (historical observation) | 390 × 844 | 390 | 390 | false |

The repaired candidate now requires 393 × 852. That viewport still requires a
fresh post-merge supervised observation; the historical 390 × 844 measurement
is not reused as evidence for it.

No browser left the authenticated loopback Companion origin, and no employer or
ATS page was opened.

## Synthetic fixture

Fixture ID: `job-apply.synthetic-automation-trash-v1`

Files:

- `.workflows/fixtures/job-apply.synthetic-automation-trash-v1/fixture.json`
- `.workflows/fixtures/job-apply.synthetic-automation-trash-v1/resume.txt`
- `.workflows/fixtures/job-apply.synthetic-automation-trash-v1/prepare.mjs`

The preparation script was exercised against a fresh Companion-owned native
Store. It returned `prepared: true`, revisions of 2 for all three trashed
records, and counts `{answer: 1, job: 1, resume: 1}`. Its reproducible fixture
source hash, computed over `fixture.json` followed by `resume.txt`, is:

`sha256:e49a0d27dc23f31be04567740579782557d25c4545feabc451051c410e308a98`

The fixture uses only fictional data. Its `example.invalid` job URL is inert.
The Workday-shaped portal string is never fetched or followed; it is entered
only into Companion's local portal registry during the future journey.

## Candidate hashes

Candidate:
`.workflows/workflows/job-apply.synthetic-automation-trash.workflow.yaml`

The installed `@lineagehq/workflows@0.1.0` CLI produced:

| Platform | Source hash | Effective hash |
| --- | --- | --- |
| desktop-web | `sha256:9cd4503e37b9718ba61f83dab44cab6e8682d8cb8df56d1417ddb345f1f24c3b` | `sha256:1f7b9314ae28f96a7a65edd2c16f20e42ec5365289c6aa6d6813e65a6ec3aaaa` |
| mobile-web | `sha256:9cd4503e37b9718ba61f83dab44cab6e8682d8cb8df56d1417ddb345f1f24c3b` | `sha256:b241d957312d6205e94c9419b2f3f2ebf7bd9c6437a2de30531abe90109ed4df` |

Reproduce them with:

```sh
node_modules/.bin/workflow show \
  .workflows/workflows/job-apply.synthetic-automation-trash.workflow.yaml \
  --platform desktop-web --json
node_modules/.bin/workflow show \
  .workflows/workflows/job-apply.synthetic-automation-trash.workflow.yaml \
  --platform mobile-web --json
```

The raw manifest file SHA-256 is
`4f8774e648a66f0d77516d383cc2c41864900f145cc060c7649e3f6093cfceea`.

## Validation

- `npm ci`: passed; zero vulnerabilities.
- `npm run companion:build`: passed.
- `workflow doctor --json`: passed with package `0.1.0`, Node `v22.22.3`,
  and all six expected schema kinds.
- `workflow validate`: accepted the candidate without warnings.
- `workflow show`: resolved all nine steps for desktop and mobile.
- Focused workflow contract tests passed for distinct platform Store roots and
  the resolved 393 by 852 mobile viewport.
- The rebuilt production Companion browser journey passed with the exact
  semantic button lookup and singular `1 record is in Trash.` assertion.
- Fresh native Companion fixture preparation: passed with exact 1/1/1 Trash
  counts and no active job listing.
- `npm run check:size`: passed; the workflow and fixture sources remain below
  the 500-physical-line policy.
- `git diff --check`: passed.
- `.workflows/local`: absent; no run Store or Training evidence was created.

The repository-prescribed affected gate selected all 25 suites because the new
fixture path is not mapped to a narrower group:

```sh
npm run test:affected -- --base origin/staging
```

The aggregate command exited 1. The product-facing TypeScript, Companion,
renderer, migration-evidence, Python, and browser suites observed in its output
passed, including the Companion browser assertions for both 390 px and 1280 px
layouts, disabled live execution, and all three Trash record types. The
aggregate remains red for repository/host prerequisites unrelated to these
new data-only files:

- The historical migration audit requires a clean snapshot, while this
  pre-commit candidate necessarily leaves its owned files uncommitted.
- The frozen native JSON profile rejects the installed, not-yet-reviewed
  CPython `3.12.14` patch. A focused rerun passed the other three profiles and
  failed only that profile.
- The local Mac native-lock qualification cannot compile because the active
  Xcode toolchain does not provide `sys/file.h`. A focused rerun passed 74 of
  75 tests and failed only that qualification cell.

No shared test configuration, package metadata, baseline, or production source
was changed to mask these environmental gates.

## Fresh-proof prerequisites and hard stop

The installed Workflows package at immutable commit
`1e9f91c6f6f0a04bdc8003ef1dbbe68ad3468225` contains the observation-only
policy fix. That prerequisite is now satisfied, but this repair deliberately
does not create replacement lifecycle proof.

After merge, a fresh Codex task at the exact merged commit must again show
`agent-workflows` in its supplied skill catalog, invoke the skill, and read the
installed contract before any run or browser control. It must use a fresh run
and host identity for each platform, the distinct product Store roots pinned in
the resolved manifest, 1440 by 900 for desktop and 393 by 852 for mobile, and a
new authenticated browser tab. Any retry, intervention, reconciliation,
unexpected state, uncertainty, or capability gap invalidates that run as proof.
The external host must still perform start, fixture, viewport, and stop
orchestration because Workflows 0.1.0 does not execute those operations.

Validation and hashing are complete. Promotion, replay, evaluation, and fresh
supervised lifecycle proof remain intentionally pending.
