# TypeScript resume dogfooding tranche

Date: 2026-09-17

Branch: `codex/ts-job-apply-dogfood-tranche`

Base: `origin/staging` at `46e335d`

## Scope and safety

This run stopped before every job-application browser flow and final action. It
used a fresh native Store beneath an owner-private temporary parent. The
canonical Store was never opened, cloned, or mutated. Inputs were the committed
fictional TXT fixtures, the closed synthetic replay PDF, and a disposable DOCX
generated from the TXT fixture. No owner applicant value was read or recorded.

The macOS home directory was `0750`. An explicit nonexistent Store below that
parent was rejected before creation by the packaged supervisor. The check was
left intact; the dogfood proceeded only beneath a `0700` temporary parent.

## Agent Workflows readiness

The repository has no `.workflows` configuration. The requested Agent Workflows
skill and a callable Agent Workflows runner were not available in this task, so
no configuration was guessed and no runner evidence is claimed. Workflows
development remained frozen. Product validation continued through the packaged
Companion, its shipped command router, browser-level tests, and the local browser
surface. This is an integration-readiness blocker, not a product acceptance
failure.

## Product journey receipt

| Journey | Evidence |
| --- | --- |
| Packaged startup | Production standalone build and native lock provider started the process-owned Companion against the isolated Store. Restart issued a new authenticated URL and retained state. |
| Desktop navigation | Overview, Jobs, Needs Attention, Facts, Resumes, Answers, Automation, and Trash each exposed the expected title and level-one heading at `1440x900`. |
| Mobile navigation | The same eight workspaces rendered at `390x844`; every document reported no page-level horizontal overflow. |
| Resume import | A cancelled TXT draft left zero records. Bounded synthetic TXT, PDF, and DOCX imports produced three managed records with the expected media types. |
| Metadata and default | Tags were durable. The default was explicitly moved to PDF and back to TXT. |
| Replacement | The managed TXT was replaced with the separate synthetic replacement fixture and advanced to revision 2. |
| Preview/download | The content route already served authenticated no-store bytes but the React editor exposed no action. A focused browser test failed, the action was implemented, and the production browser journey then previewed the exact managed TXT bytes. DOCX now exposes a Download action. |
| Restart/readback | Three managed resumes, the selected default, the completed request, and the completed proposal survived process restart. |
| Extraction cancellation | The first exact UI-created request became `cancelled` at revision 2 and remained durable. |
| Extraction failure | The second request was closed once through the shipped agent command contract with the approved `interrupted` reason; the UI displayed the bounded failure copy. |
| Extraction retry | The UI created one new request whose `supersedesRequestId` was the failed request. |
| Exact completion | Only the retry request was resolved and completed. The value-free result reported six safe auto-fills and one pending review decision. A second completion attempt failed. |
| Selective review | The one conflict was explicitly resolved with `keep_current`; the proposal became `completed` with zero remaining decisions. |
| Privacy and cleanup | Aggregate resume/request/proposal outputs contained none of the fixture path, filename, contact marker, or candidate markers. Store directories were `0700`; all three managed files were `0600`. Private profile, resolution, candidate, and diagnostic files were deleted immediately after completion/negative checks. |

## Findings

### Product defect fixed

The native resume content endpoint and allowlist were already implemented, but
the TypeScript React resume editor had no preview or download control despite the
documented journey. The fix adds an authenticated client read and an editor
action that previews PDF/TXT in a blob URL or downloads DOCX with an opaque
filename. Reads are abortable, do not expose the managed path or original
filename, and do not mark the editor dirty.

An independent branch review then found that a Save or Make default mutation
could intentionally abort an in-flight preview yet briefly surface the browser's
abort error. A failing packaged-browser regression reproduced it. The content
reader now suppresses only cancellation or supersession from its own controller;
real content-read failures remain visible.

### Workflows-platform status

No Agent Workflows surface was available, so runner configuration, replay,
screenshots, and cleanup cannot be attributed to that platform. The desktop and
mobile visual evidence in this task came from the local Companion browser, and
the production browser regression came from the repository test harness. No
Workflows-platform defect was inferred from that absence.

The local in-app browser also did not surface a download event for the DOCX
blob action. The control rendered without a browser or application error, while
the production regression directly verified the same authenticated content
path and exact managed TXT bytes. This is recorded as an evidence limitation,
not as successful download proof or a Workflows-platform finding.

## Validation

- Initial focused production browser proof: failed because `Preview resume` was absent.
- Fixed production standalone browser journey: passed, including exact preview bytes, extraction lifecycle, restart/reload, privacy, and narrow-layout checks.
- `npm run companion:build`: passed.
- `npm run companion:typecheck`: passed when run after the build. A deliberately parallel build/typecheck invocation raced on generated `.next/types`; it was rerun sequentially and is not treated as product or Workflows evidence.
- Native resume and extraction domain tests passed before the walkthrough.
- Independent review follow-up: the cancellation regression failed before the
  fix and passed afterward; Companion typecheck and all nine native managed
  resume assertions also passed.
- `npm run test:affected -- --base origin/staging`: with the shell's default
  Apple Python 3.9.6, 13 suites ran and three failed because frozen reference
  tests require the repository's installed 3.12-3.14 profiles. The same gate
  was rerun with `/opt/homebrew/bin` first in `PATH`: 12 suites passed,
  including 1,897 assertions in `node-workspace-other`; only
  `migration-inventory` rejected the intentionally dirty evidence snapshot.
  The adjacent JSON receipt preserves that value-free result. After committing
  the implementation and explicitly reconciling the two changed source hashes
  plus their review-lock binding, `node tools/migration/check.mjs` passed with
  `inventory-consistent` and no errors.
- The final clean committed affected run selected 25 suites after that metadata
  reconciliation. Twenty-three passed. Two host-qualification suites failed for
  environment drift outside this tranche: `native-frozen-reference-profiles`
  rejected the newly installed, unreviewed CPython 3.12.14 patch, and
  `native-posix-lock` found that the pinned Xcode compiler executable could not
  resolve `sys/file.h` when invoked directly. The ordinary native-lock build
  used by this walkthrough succeeded; no frozen host evidence was updated or
  claimed. The adjacent JSON receipt is the final value-free gate result.

The disposable Companion process and private Store are removed after final
validation; only the fictional fixtures, product fix, regression, and this
value-free receipt remain.
