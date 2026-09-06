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

## Managed path port and observation reference

At base `54069e0`, migration_sequence implemented the inert POSIX path primitive
and managed-resume parent check. numeric_codec independently compared separate
owned filesystem trees against the 38-case Python reference. validation_strategy
reviewed the implementation and found corrections for relative roots, Python 3.12
loop cancellation/final stat, profile-specific readlink errors and NUL error
categories. All were fixed before the final coordinator test run.

The path function consumes typed JSON Maps and an explicit Python 3.12/3.13/3.14
profile. It preserves lexical returns separately from parent resolution. The
coordinator emitted 17 modules and registered 273 source/manifest rows. The focused
reference/path/observation run passed 176 tests with zero skips using all three
installed Python profiles; the default interpreter duplicates 3.14 evidence.

The coordinator also captured an 18-case observation/cache reference without Store
initialization. Independent review by numeric_codec required exact initial cache
ages/fields/identity assertions and a real leaf-symlink rejection case. Both are
now included; five reference tests pass with no skips. Fresh/zero-age cache reuse,
expiry at 30 seconds, future entries, identity mismatch, malformed entries and
post-read changes retain distinct outcomes and observable call counts.

Parent FS/SEM remain open. Native Windows, raw-byte/surrogateescape path support,
actual permission denial and race-safe observation are not accepted by this path
port. An independent byte-path reference is being prepared to replace the current
explicit unsupported adapter branch, not turn it into a permanent restriction.
The preceding full-tier Python 3.14 signature failures and two opt-in browser
skips remain recorded and unresolved. No live routing or writer changed.

The path/observation checkpoint was committed as `9e90619`; all nine staged commit
suites passed. A separately reviewed byte-path reference now captures 16 cases.
On this macOS filesystem, all three installed profiles verify 11 observations,
including raw-byte symlink targets, surrogate encoding errors and lexical final
leaves. Five raw-filename fixtures cannot be created because mkdir returns EILSEQ.
The driver records exact stage/error/capability evidence; other setup errors fail
instead of being relabeled as unsupported filenames. Independent review required
exact source/profile bindings, fixed inputs/operations and complete snapshot
witnesses before freezing these partial observations.

The coordinator's final byte-reference run has one passing input-rejection test
and four explicitly skipped partial profile tests (default duplicates 3.14).
Those skips are not native acceptance. The next adapter work must preserve
surrogateescape bytes rather than permanently reject valid Python paths. Native
Linux evidence is still required for the five unavailable filename cases; Windows
remains a separate required path implementation and native verification lane.

## Filesystem byte adapter and timestamp reference

At base `6e36bb8`, migration_sequence implemented UTF-8 surrogateescape encoding
and decoding in a new leaf and routed native POSIX stat/lstat/readlink through
Buffer paths. The explicit unsupported-byte branches are removed. The source
review by validation_strategy exercised all 65,536 two-byte sequences against
Python and found an encoding-before-NUL precedence defect; the owner fixed it
and numeric_codec added actual-Python regression cases before final testing.

Committed tests compare 4,368 byte strings and 2,066 Unicode strings per Python
invocation, plus separate owned native path trees and error-precedence cases.
The final coordinator run, including existing managed-path comparisons and the
new timestamp reference, reports 232 passes, zero failures and 20 explicit skips.
Those skips are five unavailable native filename fixtures repeated across four
interpreter invocations; the default repeats Python 3.14. All three supported
Python profiles were present. This is partial native evidence, not FS acceptance.

The timestamp reference contains 24 fixed binary64 fixtures (23 distinct bit
patterns) and four actual filesystem nanosecond-to-stat-float conversions.
It preserves microsecond rounding before second formatting, negative timestamps,
year limits and exception categories. validation_strategy reviewed exact bits,
source/profile bindings and owned-file checks. The five reference tests pass
without skips on the three installed macOS Python profiles.

Build emission is reproducible at 18 modules; inventory has 275 source/manifest
rows. Strict typing, size and registration checks pass. Native Windows paths,
Linux byte-named files/current directories, raw argv/string transport distinctions,
complete timestamp/observation implementation and race-safe storage remain open.
Node's cwd string API alone does not establish byte-named cwd compatibility.
No live routing, writer or runtime delivery configuration changed.

## Timestamp and native observation implementation

At base `86b01fe`, migration_sequence implemented timestamp formatting, complete
observation/cache control flow and the native POSIX adapter. The coordinator
implemented explicit fused/separate stat timestamp conversion. numeric_codec
wrote independent actual-Python comparisons; validation_strategy reviewed all
four source modules and confirmed the final cache fixes. Ownership and limits
are detailed in [the package record](migration/managed-observation-port.md).

Review found sparse identity arrays falsely matching, numeric identity values
not matching Python equality, and null cache entries failing. Each was corrected
and covered by independent regressions. Native integration runs on separate
owned Python/TypeScript trees, preserving bytes, modes, links and mtimes. The
established typed StoreValidationError represents Python StoreError with exact
message comparison; no other exception category is normalized.

Final coordinator verification passed 360 focused tests, zero failures and zero
skips across the three installed Python profiles (the default repeats 3.14).
Timestamp evidence includes 24 fixed inputs, four frozen native conversions,
3,048 generated float values, 50 native samples and 112 exact arithmetic cases
per invocation. Native observation contributes 27 tests across three profiles.
Build emits 22 modules; typing, size and test registration pass. Inventory has
283 sources; 4,380 unmapped requirement cells remain, so acceptance stays open.

The next coherent durable-write package is atomic JSON persistence: exact
persisted serialization, private parent permissions, exclusive temporary file,
flush/fsync/close, chmod/replace/directory fsync and cleanup error precedence.
It requires its own frozen reference before implementation. Native flock remains
a parallel provider/contract investigation; process-local or directory locks are
not an authorized semantic substitute. JSONL rollback and journal recovery follow.

A parallel delivery package can port the installed-artifact verifier without
choosing a distribution prematurely. Existing users are promised no Node runtime
requirement; incidental developer Node availability cannot change that promise.
No fresh-host acceptance cells are established. Native Windows/Linux, runtime
distribution, CI restoration, Python-free full candidate and final-artifact
upgrade/offline/rollback gates remain open, along with previously recorded QA
profile failures and visible-browser opt-in skips. No live writer changed.

The timestamp/observation package was committed as `1da7f3f`; all nine staged
commit suites passed. The next reference wave uses that immutable base and three
disjoint packages: migration_sequence captures atomic JSON persistence,
validation_strategy captures installed artifact operations, and the coordinator
captures bounded POSIX file-lock ordering. numeric_codec independently reviews
the write/lock captures; the coordinator reviews the artifact capture.

The atomic reference has 34 cases per profile, including exact persisted bytes,
serialization failures, actual path/symlink effects, every named write boundary
and cleanup/error precedence. Independent review required exact filesystem
argument/descriptor checks and complete post-operation path sets. The artifact
reference has 33 cases per profile, including complete inventory, byte mismatch,
symlink/FIFO rejection, permissive mode/root-alias behavior and copy preflight.
Coordinator review required closed copy path sets and unchanged non-copied files.

The lock reference has 14 cases per profile using actual POSIX flock on owned
files. It preserves observed open/mode/acquire/callback/release/close ordering and
reports descriptors left open by the Python helper before safe oracle cleanup.
It does not cover missing-parent creation, process death or eight-process
contention and does not select a TS/native provider. Independent review required
exact operation arguments, closed artifact paths and input/schema checks.

These references are the prerequisites for the next inert ports, not acceptance
of durable TS transactions or Python-free installation. All native Windows and
fresh-host delivery gates remain open. No runtime module or live writer changed
in the reference wave.

Final independent rereview accepted the bounded atomic and lock reference
captures; coordinator rereview accepted the artifact capture. The combined
reference run passed 15 tests, zero failures and zero skips: 81 cases per
interpreter invocation across all three installed profiles (default repeats
3.14). Source-size, registration and whitespace checks pass. Freeze this
reference wave before assigning the atomic serializer/writer and installed
inventory/verification ports; preserve separate owners and independent tests.

## Atomic persistence and installed verification ports

The reference wave was frozen as `a4ddb1f` after all nine commit checks passed.
From that base, three workers implemented/tested atomic JSON persistence and
installed inventory/verification in parallel; the coordinator reviewed artifact
source, implemented the shared filesystem exception-category bridge and ran
independent native package tests. Full scope, ownership and limitations are in
[the checkpoint record](migration/persistence-and-artifacts-port.md).

Review/testing corrected native exception categories, sync/close context,
temporary-name length, setup cleanup, collision exhaustion and buffer visibility
at Python 3.14's exact 128 KiB boundary. The artifact port also now matches actual
readable/non-executable-directory behavior and root error categories. No outcome
was made green by weakening exception-category assertions.

The final coordinator run passed 282 tests with zero failures/skips across all
three installed Python profiles. Atomic evidence includes 34 reference cases,
seven unwrapped native writes, long-name/context regressions, 13 buffering
sequences and 213 deterministic serialization values per invocation. Artifact
evidence includes 24 reference cases per profile plus real permission/root-error
regressions and an emitted verifier loaded from a disposable package with empty
PATH. That child uses an existing absolute Node executable and is not fresh-host
or runtime-distribution acceptance. Copying artifacts remains unimplemented.

Emission is at 28 modules; inventory contains 295 source/manifest rows. Required
coverage remains open with 4,380 unmapped cells. The next durable-write work is
real cross-process locking, followed by JSONL rollback and journal recovery;
the delivery lane still needs artifact-copy metadata and native runtime/host
acceptance. Real device faults, recursion/caller limits, Windows/Linux-specific
cells and previously recorded full-tier failures remain open. No live writer,
launcher, facade or bootstrap changed.

## Native lock provider and next transaction references

The atomic/artifact checkpoint was committed as `d17a910`; all nine commit checks
passed. The next package implements a small nonblocking Node-API 8 POSIX flock
provider and TypeScript lifetime wrapper, with explicit development compilation
into owned temporary directories. No runtime build/download fallback or shipped
binary is introduced. Details and remaining gates are in
[the native checkpoint](migration/native-lock-port.md).

The coordinator's native suite passes 64 tests with zero failures/skips using
all three installed Python profiles. Eight distinct TS writer processes each
observe actual contention, then produce the exact protected counter total.
Additional native checks cover alias contention, killed-holder release, event
loop progress and retained kernel ownership during held cancellation.
numeric_codec independently reviewed the implementation and added all 14 frozen
fault cases with real descriptor/byte/mode witnesses. Test review strengthened
held-abort and alias proofs rather than inferring them from pre-acquisition
messages. One earlier invocation lacked the temporary Python 3.12 alias and
reported a skip; the corrected full run supplies it.

In parallel, numeric_codec captured 43 JSONL append/tail cases from actual
production methods with synthetic domain gates; validation_strategy reviewed
them and required exact gate-event identity. validation_strategy captured nine
artifact-copy metadata cases per profile; coordinator review required exact
copy/utime/chmod arguments. Both reference packages are ready to freeze before
their TypeScript ports. Combined reference verification passes 11 tests with
zero failures/skips; source-size policy tests pass 15 and inventory tests pass 9.

Copy evidence confirms exact nanosecond mtimes cannot be reproduced by Node's
double-valued utimes. On these Mac Python builds, os has no xattr API: the real
copy keeps the target-only synthetic attribute and does not copy the source's
attribute. This is a recorded build distinction, not permission to discard Linux
attribute behavior. Access times, broader metadata and real partial-copy faults
remain open. JSONL domain idempotency/recovery semantics remain outside its
primitive reference and must be integrated separately.

Emission is at 30 JavaScript modules; source inventory now includes native C and
headers and contains 300 rows. C/header size limits are tested; no ceiling grows.
The matrix has 19 suites including native POSIX full/platform tests. Full TX,
Windows/Linux native acceptance, final binary packaging, installed native-byte
verification and all previously recorded release/candidate gates remain open.

## JSONL transactions and exact timestamp primitive

The native-lock/reference checkpoint is committed as `d1b90ed`. The next package
ports JSONL append/rollback and pending-tail repair into three bounded TS leaves,
with explicit synthetic domain callbacks and no facade/bootstrap activation.
The coordinator's complete run passes 223 tests, zero failures/skips across all
three installed Python profiles. It covers the 43 frozen cases, ten unwrapped
native filesystem cases and 212 deterministic typed serialization values per
interpreter invocation. Eight processes each witness native lock contention,
then append complete unique records despite synthetic retries. Two process-death
tests witness partial/completed append bytes before killing the holder, require
a contending recovery process and prove repeatable tail repair and exact final
bytes. Independent source/test review found no bounded compatibility defect.
An initial run lacked the expired Python 3.12 temporary alias; the complete run
restored access to the existing interpreter. See
[JSONL evidence and remaining gates](migration/jsonl-port.md).

The parallel delivery lane adds a separate asynchronous Node-API 8 timestamp
primitive and explicit development builder. It copies validated path bytes before
queuing, checks signed seconds losslessly and preserves nanosecond remainders.
Independent native tests report 17 passes, zero failures and one EILSEQ filename
skip. Testing exposed and fixed Node's broad napi_is_buffer acceptance by using
a captured Buffer.isBuffer predicate with per-function cleanup. Far-future
behavior is compared with actual Python os.utime/os.stat on the same file; the
host's observed clamp is recorded rather than treated as exact precision or
skipped. Actual permission rejection, valid Unicode, symlink ownership and
negative/fractional timestamps pass. Source and fix received independent review.
See [timestamp evidence](migration/posix-timestamps-evidence.md).

Emission now contains 34 JavaScript modules; inventory contains 309 source rows
and the matrix 20 suites. The 4,380 unmapped requirement cells and all complete
node/subset/release gates remain open. Next work is real history identity/journal
integration and artifact-copy source-stat/atime/flags/xattr behavior. Runtime
distribution, required host access, final package acceptance and prior full-tier
failures remain outstanding. These local primitives do not accept S1, TX or DIST,
and Python remains the sole live Store writer.

The first commit attempt passed eight checks but the existing foundation suite
hit its unchanged 120-second deadline. Its isolated diagnostic then passed all
12 tests with zero skips in 78.8 seconds. The failed receipt remains retained;
the commit gate must pass on retry and is not bypassed. Read-only assessments
also identified the disjoint [next reference packages](migration/next-history-copy-packages.md)
for real history identity and artifact-copy metadata ordering.

## Real history and metadata-order references

The JSONL/timestamp checkpoint committed as `b1f4bb1` after all nine commit
checks passed on retry. The next parallel wave captures real history reading,
validation and identity, plus actual artifact-copy metadata ordering. No
production source, runtime module, facade or live Store changes in this wave.

The history reference contains 117 cases plus seven direct canonical cases,
tested under Python 3.12/3.13/3.14 and effective hash seeds 0/1/2. It captures
native text read-ahead error precedence, read/write validation asymmetry, exact
physical line labels, numeric and surrogate identity, complete input/tree
preservation and canonical comparison order. Independent review required and
verified closed fixture/callback/error/provenance assertions, and corrected a
reordered-key fixture that previously normalized away the intended difference.
See [history reference](migration/history-read-idempotency-reference.md).

The separate 12-case copy-order reference captures access/modification timestamps
before verification reads, post-data source-stat timing, nonzero native flags,
suppressed/propagated errors and existing/new-target attribute behavior. Root
review strengthened rejected flag updates with a nonzero requested flag and a
zero target flag witness. Actual Python data copying retains existing mode until
the metadata phase. A separate Node probe demonstrates copyFile changes mode
earlier, so it cannot be substituted without violating partial-failure state.
See [copy ordering](migration/artifact-copy-order-reference.md) and the
[data-only copy prerequisite](migration/artifact-data-copy-probe.md).

The final coordinator run passed ten reference tests, zero failures/skips, on
all three installed profiles; default Python duplicates 3.14.4. Both references
received independent review before freezing. Native Linux/Windows and the
documented failure/resource/caller gaps remain open. Next implementation can
split history validation/canonical behavior from the streaming reader, with
independent tests and root identity integration. The delivery lane still needs
data-only copying evidence before its copy orchestrator. Inventory remains 309
source rows, 34 emitted modules and 4,380 unmapped requirement cells; no complete
node/subset or release gate is inferred from these reference receipts.

## Codepoint text, HTTP ingress and data-copy reference freeze

The next three disjoint references passed the combined coordinator run: 15 tests,
zero failures and zero skips across installed Python 3.12/3.13/3.14 profiles.
Default Python repeats 3.14.4. Independent reviews accepted their stated scope
after executable/native JSON provenance and native byte-order assertions were
strengthened. No live Store or production consumer changed.

The [text reference](migration/python-text-reference.md) freezes twelve explicit
codepoint sequences, all 144 comparisons, three joins and complete UTF-8 errors.
The [HTTP reference](migration/http-json-bytes-reference.md) freezes 39 raw-byte
cases through the actual extracted request method, canonical helper and persisted
encoding expression. Literal surrogate pairs and Unicode scalars can remain
distinct in values and object keys; an inert text foundation must precede coherent
parser, dictionary, serialization-chunk and path/cache integration. These method
receipts do not claim complete HTTP route acceptance.

The [data-copy reference](migration/artifact-data-copy-reference.md) freezes 34
native, controlled buffering, accelerator and preflight cases, including partial
bytes, target mode, cleanup ordering and descriptor state. Linux accelerator
sequencing and broad host acceptance remain open. The next implementation lanes
are the inert codepoint text leaf and a separately scoped copy primitive; neither
accepts a complete migration node. All previously recorded end-to-end, release,
host and Python-free gates remain required.

## Inert text and data-copy implementations

Reference freeze `13191ee` passed all nine commit checks. Two disjoint workers
then implemented the [codepoint text leaf](migration/python-text-port.md) and
the [explicit-I/O copy protocol](migration/data-copy-port.md). The final combined
reference/implementation run passed 153 tests with no failures or skips across
the installed Python profiles. Python remains the only live Store writer.

Text preserves literal surrogate/scalar distinctions, immutable content,
content-based identity, lexicographic order and exact strict UTF-8 errors. Its
eight focused tests include 200,000 codepoints and independently fixed encoding
boundaries. Independent review accepted the inert scope. No existing parser,
dictionary, path or persisted writer consumes the new representation yet.

Copy comparisons cover the 30 frozen direct-copy cases through explicit I/O,
plus eleven actual-Python branch witnesses and four OS-classification cases per
profile. Review exposed and fixed cyclic implicit exception contexts and lost
directory-error subclass handling. Root also corrected model symlink permissions,
a Python 3.14 probe recursion bug, and missing effect/provenance assertions. The
first failing test receipt remains distinct from the successful rerun. The
independent reviewer identified the source defects; its later turn hit an account
usage limit, so root independently reviewed the worker's final fixes and passing
regressions. No unperformed final subagent review is claimed.

The copy leaf explicitly requires an adapter. Deterministic stream-model results
do not accept native buffering, native accelerators, metadata composition or a
whole installed candidate. Runtime emission contains 37 modules; inventory has
315 source rows and the matrix remains 20 suites. The 4,380 unmapped requirement
cells and complete node/subset/release gates remain open.

Next dependency-ready work is documented in
[text integration packages](migration/text-integration-packages.md): inert
content-keyed objects and byte decoding can be prepared in parallel, followed by
coordinated typed consumer and write-boundary integration. The copy lane requires
native binary-stream and accelerator evidence before native activation. All
previously recorded host, Python-free, broad validation and release requirements
remain mandatory.
