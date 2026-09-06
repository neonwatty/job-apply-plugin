# Migration execution state

Updated 2026-09-06. Governing [approved map](migration/end-to-end-map.md) and
[acceptance contract](migration/acceptance-contract.md).
User approved end-to-end execution through S7 READY. Milestone PRs may publish
after required gates; merges and live release require separate authorization.
The active goal is recorded in this task. Node I (executable coverage inventory)
and SEM evidence discovery have started; FS implementation waits for its bounded
reference/ownership package. HOST acceptance remains open; no native cell inferred.

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
The first wave-one batch extends this checkpoint with inert primitives; see the
[wave-one receipt](wave-one-foundation-receipt.md) for ownership and limitations.

## Ready and blocked work

| ID | State | Prerequisites and ownership |
| --- | --- | --- |
| 0C missing contracts | Ready for bounded assignment | Coordinator first selects one uncovered command/route family |
| 0R reference semantics | 3.12.13 captured; caller/depth/Unicode semantics still open | Existing installation discovered; no default-version change |
| Runtime distribution/access | Evidence preparation ready; native acceptance blocked | Reserve explicit slot rotation; identify authorized clean host cells |
| 1A typed JSON | Inert parser/serializer implemented and independently tested | Production byte ingress and caller diagnostic/depth gates remain |
| 1B Store primitives | Pure object/version validation implemented; filesystem work next | Path/permission/raw-read adapters remain; typed JSON interface available |
| 1C pure UI helpers | Four inert resume-view helpers implemented and tested | Original JS remains authoritative; no bootstrap changes |
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

## Local validation during the CI exception

The [local testing protocol](local-testing-protocol.md) adds worktree-specific
commit/push hooks and explicit deep validation. Staged snapshot verification passed
all eight local suites, including 29 new hook regression tests. Independent review
checked snapshot isolation, escalation, receipt reuse and installer safety.
Broad pushes require fresh deep evidence for their actual outgoing commit/base;
workers run focused checks and the coordinator validates the integrated wave.
No workflow/ruleset changes or production activation were made by this work.
The isolated hooks PR50 merged as `f18fcda0fdd68c69bc9f0f787f9864060deb33bb`.
Its deep run passed 18 suites; Windows was deferred and two opt-in browser cases
were skipped. The migration branch reconciled that merge at `6100b1d`. These
results do not validate subsequent source edits. Release Validation still runs
on staging pushes despite the Validate Plugin freeze.
