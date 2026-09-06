# Migration execution state

Updated 2026-09-06. Governing [approved map](migration/end-to-end-map.md) and
[acceptance contract](migration/acceptance-contract.md).
User approved end-to-end execution through S7 READY. Milestone PRs may publish
after required gates; merges and live release require separate authorization.
The active goal is recorded in this task. Node I (executable coverage inventory)
and SEM evidence discovery have started; FS implementation waits for its bounded
reference/ownership package. HOST acceptance remains open; no native cell inferred.

## Active graph checkpoint: I4 and SEM ingress evidence

I4 establishes an executable consistency gate, not node I acceptance. It binds
263 source/manifest files, 144 CLI subcommands, 17 root parser surfaces and 127
HTTP surfaces, 111 browser exports, 28 persisted artifact patterns and 19 journal variants across the 36-node graph. Effects/classifications and scenario
evidence remain explicitly open. The gate is registered in fast/full validation;
`check:migration -- --acceptance` intentionally fails until real acceptance is
implemented and satisfied. See [inventory protocol](migration/inventory-protocol.md).

Independent review found and resolved a missing-digest lock check and an omitted
Codex marketplace manifest. Regression tests include real temporary Git checkout
source/ledger drift, not only in-memory fixtures. Parent I still requires complete
complete writer classification, reference bindings and
reviewed scenario receipts; no filesystem implementation package is accepted yet.

Browser records were independently compared against static source discovery. Review
found two future export forms that could lose binding identity; both now fail closed
and have regression coverage. The 13 focused inventory tests pass without skips.
Local export lists and repeated star bindings require explicit review, including
some valid JavaScript forms. This guard does not execute browser modules.

SEM now has [ingress evidence](migration/json-ingress-evidence.md): 25 fixed inputs
produce 77 outcomes, including 45 actual production wrapper calls through memory
transports. All five tests pass with the existing 3.12 alias exposed, covering
3.12.13, 3.13.13 and 3.14.4. HTTP byte decoding and file/text decoding deliberately
differ. Caller recursion, actual stdin configuration and Unicode profile selection
remain open. No production decoder or compatibility contract changed.

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

I3 independent review confirmed all 399 prior identities preserved, with exactly
47 new artifact/journal records. All 446 records now have ten explicit open
scenario categories. Reviewed regressions cover Windows absolute paths, control
characters, unknown fields and journal/document bindings. Focused inventory plus
trash-reference validation passed 21 tests without skips. The trash reference
family is independently reviewed; parent I/UI0 acceptance remains open.

## Next integrated child: UI0 trash helpers and SEM stdin

Reference family is frozen at `8e0cb97`, independently reviewed by numeric_codec.
Implementation owner migration_sequence allowed only
`src/workspace-ui/lib/trash-view.ts`; root owns its emitted counterpart
`runtime/workspace-ui/lib/trash-view.js`. Independent test owner numeric_codec
allowed only `tests_js/workspace_trash_view_ts.test.mjs`. validation_strategy
also independently reviewed the implementation. No ownership overlap or bootstrap
change occurred. Dependencies are the accepted compiler/inert foundation and
these four inventoried exports with their accepted family reference; whole I/UI0
remain open under incremental family scheduling.

The new helper tests and unchanged reference pass 11 tests without skips, including
1,200 seeded differential observations (seed 334460). Typecheck, build parity and
size checks pass. Custom filter return types, coercion/getter order, propagated
errors, sparse arrays and object identity are preserved. Ordinary data inputs have
no helper-owned IO; caller-defined methods/getters can execute caller code.
This is locally verified inert implementation; final immutable acceptance receipt
binding remains to be completed. No UI0 parent or real browser gate is closed.

SEM actual pipe stdin now has 28 fixed outcomes for each of CPython 3.12.13,
3.13.13 and 3.14.4; five tests pass with zero skips using the existing temporary
3.12 alias. Exact bytes, interpreter family, Unicode version, stdin error mode,
UTF-8 mode and recursion setting are checked. See
[memory-independent stdin evidence](migration/json-stdin-evidence.md).
Stdin surrogateescape and HTTP surrogatepass are distinct observed contracts.
No TypeScript transport adapter is accepted by this evidence.

Next work: complete executable family requirement/receipt and ownership validation,
bind the reviewed UI child to its immutable implementation revision, and continue
FS family reference capture. Node I still needs complete source/writer/launcher
classification; SEM still needs profile selection and remaining caller/depth/native
coverage. Missing host cells remain open while portable work continues.

Immutable trash implementation/evidence checkpoint: `7fa2687f3cac5d2ac4a28053124dcf13524fae4d`.
[Reviewed local receipt](migration/evidence/trash-helper-7fa2687.json) binds source,
oracle, compiler and dependency bytes plus the 11-test log. All nine commit suites
passed for that implementation. This receipt remains distinct from the pending
executable child/node acceptance gates.

## I4 and FS raw-reader reference checkpoint

The machine gate now checks requirement bindings and package structure in addition
to the surface ledger. Ten Trash-family requirements bind literal registered tests
and hashed oracle files; one planned machine package records exact ownership.
No acceptance is inferred: 4,380 requirement cells remain unmapped, and all parent
acceptance gates remain open. Existing inert implementation receipts remain valid
local evidence rather than machine readiness claims. Independent review found and
resolved no-op command/fabricated test bindings, malformed requirement crashes and
historical ownership release. Thirty focused migration-checker tests pass.

FS now has a 22-case [raw-reader reference](migration/raw-file-reference.md).
All five tests pass without skips across the three installed Python profiles;
all tested macOS symlink cases were observed and every snapshot remained unchanged.
No filesystem TypeScript writer/reader or native parent acceptance was introduced.
Next: accepted reference/interface receipt validation and the actual raw-byte reader
with explicit Node platform typing/build support; preserve strict UTF-8, BOM,
symlink and narrow exception behavior observed by this reference.

## FS inert raw-reader implementation

Reference source/tests were frozen in `dc260d6`. Implementation owner
migration_sequence edited only `src/store/read-file.ts` and
`src/store/read-json-object.ts`; the coordinator emitted their runtime counterparts.
Independent test owner numeric_codec edited only
`tests_js/store_raw_read_ts.test.mjs`. validation_strategy independently reviewed
reader behavior and owned the build fixture update. No live Store was accessed.

Pinned development-only Node declarations (`@types/node` 22.20.1, locked
`undici-types` 6.21.0) support builtin filesystem/decoder imports with strict types.
No runtime dependency or installation-at-launch requirement was added. Build tests
retain one implementation per emitted module and reject declaration shims in src.
All seven build tests pass; eleven modules emit reproducibly.

The reader follows the raw Python helper's links, strict UTF-8/BOM/newline behavior
and narrow error boundary, then reuses typed JSON and object validation. It does not
initialize a Store or enforce caller-level path security. Internal TS error classes
remain StoreValidationError and NumericAtomError; public caller error/diagnostic
mapping and recursion/native platform gates remain open. Local comparison proves
application messages and typed values for this reference, not traceback parity.

Coordinator verification passed 110 tests with zero skips: raw reference plus TS
clones across Python 3.12.13/3.13.13/3.14.4 and the existing Trash helper contracts.
The default interpreter duplicates 3.14 evidence. Each side uses separate disposable
files; byte hashes, modes, mtimes, directories and links remained unchanged.
Type declarations changed compiler inputs, so the prior Trash receipt is historical;
its source/emitted bytes are unchanged and its 11 tests were rerun under this setup.
Parent FS/SEM/READ and machine package acceptance remain open.

Private resume digest reference now freezes 16 cases across all three installed
Python profiles with zero skips. It distinguishes initial size from post-stat
growth, symlink substitution, read failures and escaping close failures.
A separately reviewed prerequisite verifier binds exact contract scope, immutable
files/logs, ancestry, environment and complete TAP counts; seven tests pass.
The initial reference/compiler logs are captured for immutable binding next.

## Descriptor digest implementation and verified prerequisites

The private digest reference was frozen in `e57c7e7`. migration_sequence owned only
`src/store/private-file-digest.ts`; the coordinator emitted its runtime counterpart.
numeric_codec owned the independent `tests_js/private_file_digest_ts.test.mjs`.
validation_strategy separately reviewed the source. The default adapter uses real
opened file handles; injected test adapters wrap real descriptors on owned clones.
No live Store or application routing changed.

Coordinator tests passed 74 cases with zero skips across all three Python profiles,
including all 16 reference cases, real descriptor closure, short reads, full hashing
after post-stat growth and symlink substitution refusal. Initial-size-only behavior
is preserved. Native Windows, actual permission denial, interruption and complete
pre/post identity observation remain open; digest success is not stable observation.

The checker now loads two immutable prerequisite receipts at `e57c7e7`, with exact
scope and captured logs: Trash reference and Node compiler interface. The existing
Trash machine package can be represented as implemented; it is not marked accepted.
Reference requirements must cover the package's required scenarios, preventing
unrelated evidence reuse. Actual temporary Git tests reject source drift,
uncommitted evidence and static symlink escapes. Independent review resolved
malformed-record conversion and unsafe evidence-path issues. Receipt commands are
never executed by the loader. Parent I/REF/FS/UI0/SEM and release gates remain open.

## Remaining UI helper and managed-path references

Independent review of the 27 remaining synchronous UI exports found one ordinary
aliasing behavior missing from the first reference draft: overlapping patch paths
mutate a caller-supplied parent object. Fixed expectations now preserve this and
the frozen-parent failure. The coordinator reviewed source and expectations;
17 reference tests pass with zero skips. Groups are answer (9), activity (12), and
profile/form (6). Browser FileReader IO remains a separate boundary.

The coordinator independently inspected the managed-path capture and reran all
five tests with zero skips on macOS CPython 3.12.13, 3.13.13 and 3.14.4. Each
profile observes 22 cases on owned synthetic trees, including the version-specific
parent-loop error and accepted final-component links. Snapshots remain unchanged.
These are bounded reference contracts, not full filesystem or UI acceptance.

## Remaining synchronous UI helper implementation

The reference was frozen at `7f6e1f4` after all nine commit suites passed.
migration_sequence ported all 27 exports into three independent TypeScript leaves;
numeric_codec authored nine independent differential test groups in separate files.
The coordinator reviewed the source expressions and test fixtures, emitted all 15
runtime modules, and registered six new source/emission paths (269 catalog rows).
Strict typing and build reproducibility pass without compiler configuration changes.

The coordinator additionally tested actual Chromium 151.0.7922.34 module loading: all
35 synchronous helper exports load without Node globals, and 12 sampled results
match both fixed expectations and original JavaScript. numeric_codec independently
reviewed this test; an explicit 30-second bound addresses the review finding. Its
FileReader observation is original-only and does not claim an IO port.

The focused run passed 32 tests with zero skips: 17 UI references, nine differential
groups, one real-browser check and five managed-path profile tests. The expanded
managed-path reference contains 38 cases per profile (36 native, two injected),
independently reviewed by migration_sequence. Both loop forms retain the Python
3.12 versus 3.13/3.14 distinction. Native permission denial, unsupported platform
resolution, races and complete observation remain open.

The bounded worker contract is in `docs/migration/remaining-helper-package.md`.
No bootstrap or live writer changed. Formal per-surface requirement/acceptance
receipts and parent UI0/FS acceptance remain open; code and passing examples alone
do not close those gates. The broader local full-tier regression completed with 13 of 14 suites passing.
The workspace Node suite passed all 350 tests without skips, including the bounded
browser test after its timeout change. Python QA failed three subtest assertions
in two unchanged tests because its frozen QuietParser signature omits Python 3.14
parameters `suggest_on_error` and `color`. The same two tests pass under installed
Python 3.12 and 3.13; isolated Python 3.14 reproduces all three failures. No Python product
or test files changed in this wave. Two opt-in visible account-browser tests were
skipped. This full-tier run is not a passing release gate; interpreter-profile
expectations and the visible-browser cells remain outstanding.

A follow-up coverage audit added three focused test groups for stale answer
selection/key/sequence/generation rejection, absent job selections, unchanged
attention membership and missing patch/draft inputs. The final focused run passes
35 tests with zero skips. This test-only addition followed the broader run; no
emitted runtime bytes changed after that broader run. The full-tier failure remains
recorded rather than being replaced with this narrower pass.

Commit whitespace checking removed a trailing blank source line; emitted runtime
bytes are unchanged and the recorded source hash was updated.
