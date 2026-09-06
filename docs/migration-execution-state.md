# Migration execution state

Updated 2026-09-06. Governing [execution plan](autonomous-typescript-migration-plan.md).
Current approved execution covers raw-test integration and inert numeric atoms.
Later waves are planned, not started or automatically published by this ledger.

## Accepted packages

| ID | Status | Immutable implementation | Evidence / next dependency |
| --- | --- | --- | --- |
| Profile/fact reference | Accepted | `b5dc97f` | 19 cases; no TS writer port claimed |
| Runtime documentation | Accepted as documentation | `9c6d029` | Zero clean-host cells; launch gate open |
| Integration receipt | Accepted | `a04bedd` | Historical full baseline failures remain explicit |
| Raw input diagnostic | Accepted | `5349cb5` | Original 18 request strings preserved |
| Raw matching contracts | Accepted and now registered | `b2d2241`, wiring `8712512` | 42 cases; interpreter differences remain distinct |
| 0A numeric codec | Accepted as inert code | `871251225cd3a37642ca534b01902148dfc03f0a` | Independent review/test evidence; no production caller |
| 0B numeric tests | Accepted | `871251225cd3a37642ca534b01902148dfc03f0a` | Two observed Python profiles; 3.12 unavailable |

Detailed [numeric integration receipt](numeric-atom-integration-review.md).
Implementation and independent test workers finished; review finding resolved.
No worker owns an active source-edit package at this checkpoint. No heavy test
process or capacity reservation is retained by this task.

## Ready and blocked work

| ID | State | Prerequisites and ownership |
| --- | --- | --- |
| 0C missing contracts | Ready for bounded assignment | Coordinator first selects one uncovered command/route family |
| 0R reference semantics | Blocked on Python 3.12 evidence | Use authorized available environment; no version change inferred |
| Runtime distribution/access | Evidence preparation ready; native acceptance blocked | Reserve explicit slot rotation; identify authorized clean host cells |
| 1A typed JSON | Ready for interface/design assignment | Consumes 0A; one parser owner plus independent test worker |
| 1B path/permission primitives | Ready for bounded assignment | May parallelize with 1A; JSON decoding waits for accepted 1A interface |
| 1C pure UI helpers | Ready for bounded assignment | Explicit helper subtree ownership; no bootstrap overlap |
| Restore staging CI | Required before production cutover | Restore automatic staging triggers and valid required contexts; complete integrated validation |
| Full matching | Held | 0R plus full raw input/Unicode equivalence; held worker not imported |
| Production cutover/removal | Not ready | Full command/writer/platform/runtime/rollback gates |

## Authority and checkpoint rules

PR49 merged into staging at `2ca9d6e2c47948df57e7649a2211d4ec523bb364`
on 2026-09-06; source head `bf7edcfece234f7d0dddb2bcf489006733f8281c`.
The clean migration branch incorporated that exact merge without conflicts in
`feb16c09b3bae240c3402b0556af774b91ff1075`. Existing migration edits were preserved.
The source owner reports its monitor paused. This was an explicitly approved
exception merge, not a full-CI success or a browser-to-CLI repair.

See [temporary staging CI exception](staging-ci-migration-exception.md): automatic
staging Validate Plugin triggers and staging required-status checks are temporarily
disabled; manual dispatch remains. Main/nightly/release validation remains unchanged.
No ruleset edits were performed by this integration task. Before production
cutover, the integration owner must restore automatic staging validation and
current valid required contexts, then complete integrated validation. Do not
restore the obsolete retired validate context. No publication/live activation
is authorized by these implementation commits.

Reconciliation checks: 30 focused tests passed, three Python 3.12 checks skipped;
all six fast suites, size, matrix, typecheck and build parity passed. Full/browser/
native-platform/release validation was not rerun or claimed complete. See the
[reconciliation receipt](integration-evidence/staging-reconciliation.json).

Before assigning more work, inspect the actual branch, dirty state, worker
ownership and receipts. Do not repeat packages marked accepted. Future package
rows must name exact allowed files and their emitted counterparts before dispatch.
Update this ledger only with observed outcomes, including skips and blocked cells.
