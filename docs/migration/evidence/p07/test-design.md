# P07 test design — explicit task and contract lineage

Design only. This task owns this document and changes no source, test, catalog,
manifest, log or accepted receipt. The implementation owner writes the production
contract separately. Root must freeze the reconciled interfaces, literal identities
and immutable audit cells before implementation. No P07 acceptance follows here.
The dedicated replacement witness for the existing PythonText contract is a later
node; it is not a P07 implementation file or an excuse to edit frozen tests.

## Bounded ownership and execution

Proposed new test files:

- `tests_js/migration_task_lineage.test.mjs`: five pure structural tests.
- `tests_js/migration_task_replacements.test.mjs`: five actual Git replacement tests.
- `tests_js/migration_task_lineage_lifecycle.test.mjs`: four actual Git lifecycle tests.

Proposed support files:

- `tests_js/migration_task_lineage_support.mjs`: fixed actors, versions, structural
  contracts and cloned negative permutations; no manufactured lifecycle acceptance.
- `tests_js/migration_task_lineage_git_support.mjs`: disposable repository,
  immutable capture/commit/checkpoint helpers and actual staged snapshot checks.

Both support files and all tests stay at most 500 physical lines each. Reuse
read-only existing task/product support primitives only where their real semantics
fit. If extraction from an existing helper is necessary, declare exact ownership
before editing; do not create a third giant fixture engine or expand this list
implicitly. Root owns source inventory and matrix registration.

Each of the three new cells has command `node --test <exact test file>`, reporter
`node-tap13`, environment `node-local`, timeout 180000 milliseconds and maximum
output 1048576 bytes. Unique proposed logs:

- `docs/migration/evidence/p07/logs/P07-lineage.tap`
- `docs/migration/evidence/p07/logs/P07-replacements.tap`
- `docs/migration/evidence/p07/logs/P07-lineage-lifecycle.tap`

The two actual Git cells separately retain their 180-second bounds. Do not hide
work by sharing mutable fixtures across files or treating synthetic logs as actual
captures. Within one test, restore an owned immutable checkpoint for independent
negative permutations. No skip, timeout, cancellation, todo or partial batch can
satisfy a required cell. Optimization must preserve stages and proof boundaries;
changing the budget requires a separately reviewed contract revision.

## Shared actual fixture

Use a disposable Git repository with real registered products, inventory shards,
requirements, exact literal Node test bindings, a test matrix, accepted prerequisite
reference/interface receipts and independent author/reviewer identities. Product A
has genuinely accepted I/V receipts obtained from actual subprocess TAP and the
checker. Save its immutable receipt identities, artifacts and file hashes for
comparison throughout every lineage transition. Do not inject accepted registries
into `checkInventory` or replace the loader with a test double.

Prepare original **product** task B with a frozen manifest and approved DAG
dependencies. Do not substitute an audit package to bypass registered product
ownership checks. Original B's allowed files include only its actual original
paths: no retry manifests, replacement witness or future support paths are
predeclared to make the later registry diff disappear. Two separate starting
states are necessary:

1. **Unexecuted original**: frozen planning/activation exists, but there is no
   subject execution, capture or acceptance claim. An explicit approved refinement
   may replace its contract before work starts; it must not fabricate a rejection
   or a passing predecessor receipt.
2. **Executed but unaccepted original**: run the actual declared command against
   an immutable subject and commit the complete attempt capture. A controlled test
   identity mismatch produces a real rejection even if the child process exits
   zero. Preserve the original manifest, input bindings, full TAP, command,
   environment, subject/tree and closed archived capture metadata. A rejection diagnostic is
   included only when the actual acceptance check rejected the capture; it is not
   mandatory for a valid unpublished attempt. This attempt is never
   inserted into the accepted-receipt set or counted as an accepted dependency.

For an executed attempt, first pin its archived capture JSON through a closed
preparation record and commit that preparation. Only afterward choose the
replacement manifest's input base, so the base actually includes the preserved
capture and its authorization. This ordering is itself observed in the lifecycle.
Freeze a new independently reviewed lineage contract explicitly linking old and
new immutable identities. Preserve the complete original contract, execution
attempt and accepted A history. Freeze replacement manifests before activation;
publish their catalog/version/lineage bindings and exact review lock together.
Revalidate on a replacement execution subject after activation, capture fresh TAP,
and require exact-subject independent V review before any replacement acceptance.
Do not reuse an earlier successful log as evidence that the new contract ran.

Retain the same logical package with new immutable task IDs, for example B.retry1.I
and B.retry1.V. Preserve the original B.I/V assignments in their original and later
DAG archives; explicit one-to-one retirements map each role to its replacement.
The root archive/catalog binding is not overwritten. Never infer replacement or
acceptance from filename suffixes, matching package IDs, status or later dates.

Bind the attempt's exact closed capture metadata, not just a bag of log paths.
Its schema is preservation-only: original subject/tree, evidence commit, exact
allowed-file states including null absence, and raw capture/log/artifact bindings.
Where capture metadata records observed command, environment and execution
results, preserve those actual fields byte-for-byte; the original manifest's
expected declarations cannot substitute for observed capture fields. A diagnostic
may explain a real rejection but must not fabricate a failure for a valid,
unpublished capture. The loader must preserve partial/mismatched captures without
converting them into accepted receipts or requiring their TAP to pass.

## Product registry version facts

Use the author's explicit `transition.packageVersions` interface. Each entry binds
`packageId`, `originalTaskIds`, `replacementTaskIds`,
`previous: {packageSha256, registry: {path, sha256, revision}}`,
`next: {packageSha256, registry: {path, sha256}}`, and
`additions: {allowed_files: [...], emittedFiles: [...]}`. The registry path is fixed
to `config/migration/packages.json`. Tests compare these bindings with actual Git
bytes and decoded structural package records, not fixture-injected trusted hashes.

Assert original manifests match their package in the historical registry at each
original freeze. Assert replacement manifests match the new structural package
and exact current registry bytes at activation. Only the named unreceipted product
may gain the explicitly listed retry manifest/witness/support/emission paths;
retain original owned paths and all unaffected package fields. Unrelated product
records must stay unchanged. Existing closed status values are not arbitrary
metadata exemptions and never imply acceptance.

The activation commit atomically publishes the pinned registry, catalog, lineage
and exact review lock after the replacement documents and transition are frozen.
No production source change is hidden in this registry operation. The original
unaccepted product record, although preserved and historically well formed,
grants neither current acceptance nor predecessor readiness to an unrelated task.

## Pure structural cell: five literal identities

1. `P07 lineage preserves accepted DAG edges and their exact receipt bindings`
   accepts an explicit unused-task refinement while keeping accepted assignment
   roles, predecessor edges and receipt hashes fixed. Reject omitted or substituted
   accepted dependencies, including transitive dependencies and audit/product
   boundary changes. Historical acceptance cannot migrate to a new identity merely
   because its fields look similar.
2. `P07 lineage binds immutable versions and rejects cycles or fake ancestry`
   binds exact version/contract hashes and rejects missing ancestors, self links,
   multi-edge cycles and unrelated sibling revisions. Structural tests use supplied
   facts only; actual Git ancestry is independently covered below.
3. `P07 lineage maps implementation and review roles without laundering acceptance`
   preserves I/V pairing, exact author/reviewer identities and role-specific
   dependencies. Reject I-as-V mappings, cross-package pairs, self review, stale
   reviewer authorization and an independently accepted role silently becoming a
   pending or differently scoped role.
4. `P07 lineage rejects competing transitions and ambiguous active versions`
   permits one explicit successor per retired version and rejects duplicate IDs,
   inconsistent equivalent links, two active replacements and unresolved forks.
   One invalid entry invalidates the batch; no otherwise valid sibling transition
   supplies partial acceptance or dependency readiness.
5. `P07 lineage preserves required coverage across approved refinements`
   permits explicit required-test expansion for an unexecuted contract while
   retaining requirements, applicable environments, prerequisite bindings and
   required artifacts. Reject omitted requirements/platforms/tests, longer-than-
   authorized budgets, weakened zero-skip gates and unaudited substitutions.
   Preserve original test names under an explicit old-cell/command to new-cell/
   command mapping. A later dedicated witness may expose the original four
   literal names while checking all eight child outcomes. Do not approve arbitrary
   renamed "semantic equivalents", raw matching counts, removed environment cells,
   or weakening command/output/time constraints. Include mismatched historical
   package hashes, undeclared ownership additions and a next-registry hash that
   changes an unrelated package; each must fail structural lineage validation.

## Replacement Git cell: five literal identities

1. `P07 unexecuted refinement preserves the original contract without inventing an attempt`
   uses an actual frozen but unexecuted B contract. Commit a linked replacement
   version, validate preparation and activation, and assert original bytes remain
   readable at their original revision and current archival path. No old attempt
   record, accepted receipt or retroactive result is fabricated. Replacement
   acceptance remains open until actual fresh execution and independent review.
   Test null-attempt eligibility against every relevant revision after activation,
   excluding legitimate planning records: edit then revert source bytes, or create
   then delete a registered log, still requires preservation of the attempted work.
   Matching endpoint trees alone cannot establish an unexecuted original.
2. `P07 rejected attempt remains immutable while an explicit replacement is prepared`
   captures and commits the real wrong-test-set attempt. Freeze its linked
   replacement, verify the original rejection and complete TAP stay unchanged, and
   keep A's accepted receipt hashes unchanged. Also preserve a genuinely valid
   unpublished capture with no invented rejection diagnostic. The checker reports
   no replacement acceptance during preparation or activation in either case.
   Assert old product manifests still match their historical registry while the
   newly activated replacement matches its explicitly changed current registry.
   The original unaccepted package itself must not appear in accepted sets.
3. `P07 replacement acceptance requires fresh exact-subject revalidation`
   runs the corrected literal test set after activation and verifies its exact new
   subject/tree, command, environment, complete TAP and review. First attempt reuse
   of original logs/subject or preactivation capture and require rejection.
   Copy the retired TAP bytes into a new replacement log path and commit after
   activation: the fresh pathname/revision must not launder the old content hash.
   Test that copied-hash rejection explicitly, then supply an actual fresh capture
   and require the explicitly mapped replacement
   acceptance only. The original rejected attempt remains rejected.
4. `P07 altered historical attempt logs and rejection records fail closed`
   changes original log bytes, attempts to rebind their hash, removes the archived
   manifest, changes actual capture metadata/result/command/environment, alters an
   existing diagnostic, or replaces the preserved subject. Include unknown capture
   fields, duplicate artifact paths and missing outputs recorded as if present.
   Preserve
   otherwise valid replacement records so each negative tests historical integrity,
   not an unrelated malformed field. Also tamper with the previous structural
   package hash or historical registry binding while keeping current replacement
   records valid; historical product validation must still fail. No new acceptance
   survives. A's original
   accepted receipt bytes remain unchanged even while current validation is invalid.
5. `P07 ambiguous or competing replacements grant no acceptance`
   constructs two individually well-bound successor manifests and independently
   frozen transition records for the same original version, with valid actors and
   ancestors. Reject the competing binding, duplicate transition identity and
   mismatched active-version selection. Do not substitute a duplicated JSON object
   for the genuine two-successor witness.

## Lifecycle Git cell: four literal identities

1. `P07 replacement cannot weaken accepted dependencies or required coverage`
   starts from the valid actual A→B fixture and tries to remove or change A's
   accepted V dependency, its receipt digest, a required scenario, an environment
   or an expected artifact while renewing otherwise valid planning hashes/locks.
   Also change an unrelated registered package, silently preauthorize extra retry
   paths, or omit a declared ownership addition from the next structural package;
   a valid-looking registry/lock hash must not make those changes permissible.
   The result must identify the lineage/coverage violation. Independently check
   that the intended inventory is current, so an uninventoried source cannot make
   the negative pass for the wrong reason.
2. `P07 replacement cycles and fake Git ancestry fail closed`
   creates real branches from an owned common ancestor, with valid-looking
   contracts on siblings. Assert the actual Git graph, then reject a claimed
   ancestor relation, a self replacement and a two-version cycle. Also reject
   attempt evidence from a sibling that is not an ancestor of its claimed freeze
   or execution boundary. No fabricated SHA-only fact grants acceptance.
3. `P07 later replacement success cannot retroactively pass the rejected attempt`
   completes a genuinely valid replacement, then attempts to relabel the original
   rejection as passed, alias the new receipt to the old attempt identity or use
   the old attempt as an accepted dependency for an unrelated C task. Assert the
   exact accepted-ID mapping, not just a successful overall status. A and the valid
   replacement retain their immutable historical receipts; original rejected
   evidence remains unchanged and cannot unlock C.
4. `P07 lineage activation and receipt snapshots preserve accepted history`
   checks the full positive lifecycle through actual dependency-linked hook
   snapshots: original preparation/planning, explicit unaccepted attempt capture,
   initial capture-JSON preparation committed before replacement.base, then linked replacement preparation and freeze, activation, new implementation
   subject, evidence,
   independent review and final receipt publication. Every required planning stage
   is checked immediately; no hidden failing intermediate commit is called a valid
   lifecycle. In particular the old implementation remains pending while new
   preparation records, DAG archive, manifests and transition document are staged;
   this must work before transition activation, not only after all files exist.
   Check historical-versus-active product structural versions at their respective
   immutable boundaries, and include the exact registry change in the activation
   snapshot instead of modifying packages.json in an unobserved intermediate step.
   Preserve rejected and accepted histories together. Add unrelated
   untracked dirt and require failure rather than extending the dependency-link
   exception to arbitrary files.

## Snapshot and helper interfaces

Use real `withSnapshot(root, revision, callback, { dependencies: true })` with an
owned fixture dependency directory and both `node_modules/` and `/node_modules`
ignore rules. Assert the snapshot link resolves to the intended fixture dependency
root, and original checkout HEAD, index tree and status are unchanged after each
snapshot. Record staged commit-tree inputs explicitly; preserve actual ancestry
when a merge is part of a fixture. Cleanup only owned worktrees and temporary files.

Proposed support-facing API, to reconcile with the production author before code:

- `createLineageRepository(t, { lifecycle })` returns an owned repo with actual
  accepted prerequisite/product receipts, fixed IDs and cleanup registration.
- `freezeOriginal()` returns immutable manifest/contract bindings without inventing
  execution; `captureRejectedAttempt(original)` runs and archives the real failure.
- `freezeReplacement(original, { mapping, mutate })` writes only frozen planning
  documents, retaining active bindings in memory until `activateReplacement()`.
- `captureReplacement(replacement)` runs the fresh immutable subject and commits
  its logs; `completeReplacement()` writes independently bound review/receipts.
- `observe(stage)` validates the exact staged dependency-linked snapshot immediately;
  `check()` invokes actual `checkInventory` on the current clean fixture.
- `checkpoint()`/`restore()` reset only the owned fixture between negatives and
  restore in-memory records along with Git state to prevent cross-case pollution.

Keep fixture observations separate from production proof facts. Public lifecycle
assertions target checker output and immutable repository contents, not private
validator return shapes. A pure structural test may inject a closed fact registry;
that does not satisfy any actual lifecycle cell.

A receipt snapshot already checked at the staged tree may provide the test's
completion result after its real commit if the helper asserts identical tree bytes
and unchanged original-checkout invariants; this avoids an immediate duplicate
validation without omitting the actual pre-commit gate. Fresh execution logs must
still come from the exact immutable replacement subject, not a mutable checkout.

## Preparation records and remaining freeze details

Root identified that P06's pending-source checks can reject new replacement
planning documents before the transition that would authorize them exists.
Exercise the author's closed append-only preparation-record protocol explicitly:
records pin exact regular-file paths and hashes only under
`docs/migration/evidence/`, with `.json` or `.md` suffixes. They grant neither
execution nor acceptance and cannot waive input hashes or source ownership.
Observe the preparation registration, each document freeze and activation through
actual clean staged snapshots while the original source remains pending.

Negative permutations in the lifecycle metadata/coverage tests must reject source,
runtime, test, arbitrary config, TAP or outside-directory paths presented as
preparation; changed pinned hashes; removal/rebinding of prior preparations; and
using a preparation record as permission to execute replacement source. Future
freeze validates the complete pinned DAG/manifest/transition relationships; merely
matching a preparatory file hash cannot activate a task or broaden accepted scope.
The exact preparation schema belongs to the author's implementation document and
must be reconciled before immutable audit freeze; this test plan grants no broader
metadata exemption.

Published receipt history is never filtered by retirement: retirement of any task
with a valid or invalid published receipt must fail. Same-package roles and
requirements are preserved, old dependency obligations map only through explicit
retirements, and existing accepted assignment edges remain immutable. Null attempts
are justified by per-revision post-activation history, not a caller label or an
endpoint-only diff. The closed I/V retirement group accounts for shared original
logs without inventing a V execution or hiding captured I work.

Reference expectations remain independently fixed. No test rewrites old TAP,
autogenerates a passing rejected receipt, edits the existing PythonText suite or
silently broadens metadata exemptions. P07 success enables the reviewed lineage
mechanism only; the later dedicated replacement witness still requires its own
frozen contract, new execution, independent review and acceptance receipt.

## Frozen product fixture choice

A owns only disjoint source, source-catalog and manifest paths, and does not
input-bind `config/migration/packages.json`. B alone owns that global registry for
ordinary scoped status edits. Its replacement's changed structural registration
uses the exact reviewed packageVersions delta. No A-to-B P06 handoff is needed or
fabricated; the existing shared-registry P06 helper cannot be reused unchanged.
