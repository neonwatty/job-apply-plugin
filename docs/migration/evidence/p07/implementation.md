# P07 implementation contract: reviewed DAG lineage and replacement attempts

Status: design for a separately frozen implementation assignment. This document
supplies no acceptance, execution authorization, or receipt. Root owns planning,
registration and commits; the implementation author is jsonl_review. Transition
review authority for this bounded protocol is root / hooks_audit, distinct from
implementation authorship. Freeze those exact transition actors in the P07 audit
policy before dispatch; do not infer authority from arbitrary replacement authors.

## Scope clarification

The prior P07 description permits refinement of unexecuted tasks. This package
also explicitly permits replacing an **executed but unaccepted** attempt. S02 is
that case: its captured PythonText run contains eight passing identities while
its old manifest declares four. Those results cannot satisfy that manifest and
must never be promoted, rewritten, relabelled, or silently discarded. Preserve
the original manifest, subject and raw logs as unsuccessful acceptance evidence;
freeze a corrected contract and run fresh post-activation validation.

Receipted tasks are immutable. A receipt means any published receipt record, not
only a currently accepted task: malformed or stale evidence must fail the entire
batch and cannot be made invisible by retiring its task. A valid but unpublished
attempt is also unaccepted and may be replaced with the same preservation rules.
No test-count waiver, old-log reuse, acceptance alias or product activation exists.

## Files and directional modules

At most eight production modules are authorized by the future package:

- `tools/migration/task-lineage.mjs`: pure closed-schema/DAG transition validator.
- `tools/migration/load-task-lineage.mjs`: immutable lineage, history, attempt and
  activation facts; extracts DAG decoding/history work from the existing loader.
- `tools/migration/load-task-evidence.mjs`: integrate active versus historical
  identities and retain existing exact Git, test, receipt and handoff gates.
- `tools/migration/task-manifests.mjs`: validate each manifest against its own
  immutable archived DAG and assignment identity.
- `tools/migration/task-receipts.mjs`: derive a review's implementation dependency
  from the same-package DAG role instead of constructing `${package}.I`.
- `tools/migration/task-handoffs.mjs`: preserve exact task/manifest bindings when
  consulting lineage; no logical-name substitution of a handoff.
- `tools/migration/check.mjs`: report active/retired identities and open acceptance.
- Required extraction target `tools/migration/task-metadata.mjs`: move existing
  coordinator history/lock checks here to keep the 400-line loader below 500
  lines, and validate the narrowly bound activation registry delta. This preserves
  existing behavior outside the explicit lineage transition. It is the eighth
  production module and must appear in allowed_files before dispatch.

Evidence IO, prerequisite loaders/receipts, packages and TAP parsing remain shared
unchanged primitives. New leaves do not make them depend on task-specific leaves.
Every source/test/support file remains at most 500 physical lines. Tests need
separate pure lineage, actual Git lineage lifecycle, and bounded shared fixture
support files, alongside the existing affected manifest/receipt/loader suites.
Root freezes their exact literal identities and registrations before execution.

## Append-only schemas

A binding is exactly `{path, sha256, revision}` with existing safe-path, SHA256
and immutable commit rules. A file binding is exactly `{path, sha256}`; a tracked
source state is exactly `{path, sha256}` with null permitted only for absence.
All objects below are closed: unknown fields, duplicates and malformed values
fail. No path can name symlinks, untracked data, commands or external locations.

`config/migration/task-lineage.json` is exactly:

```json
{"schemaVersion":1,"preparations":[],"transitions":[]}
```

Each transitions item is a binding to an immutable transition document. The root
is always the existing immutable `task-contracts.json.dag` binding. It is never
replaced, and old catalogs are never edited. The first transition's previousDag
must equal that root. Each subsequent transition extends exactly the preceding
nextDag. Every transition document has exactly these fields:

```text
schemaVersion: 1
id: unique nonempty string
previousDag: binding
nextDag: binding
retirements: Retirement[]
additions: [{id, manifest: binding}]
refinements: [{id, beforeDependencies: string[], afterDependencies: string[]}]
packageVersions: PackageVersion[]
witnessMappings: [{originalTaskId, replacementTaskId, originalCellId, replacementCellId}]
author: "root"
reviewer: "hooks_audit"
decision: "approved"
reason: nonempty string
```

The fixed author/reviewer values implement the explicitly frozen authority for
this migration, not general actor administration. A future authority change
requires its own reviewed protocol; a transition cannot appoint its successor.
`nextDag` is another immutable archive in the existing assignment-array schema.
The current task catalog remains append-only: it adds new assignment and audit
bindings normally, retaining all old entries and environments byte-for-byte.
The lineage shard alone identifies retired entries; they never become aliases
for replacement acceptance. DAG archives and all frozen manifests remain present
and unchanged in the working tree as well as Git history.

A Retirement is exactly:

```text
id: original task ID
manifest: original frozen binding
replacementId: new unique task ID
attempt: null | {
  subject: {sha, tree},
  evidenceCommit: immutable commit,
  capture: file binding,
  files: tracked source states[],
  artifacts: file bindings[]
}
```

Retirements are one-to-one replacements. Splitting pending work uses additional
new DAG nodes feeding the named replacement completion task; it does not create
multiple competing successors for one old identity. Each addition is a newly
frozen task ID with a manifest bound to nextDag. Original and replacement retain
the same logical package, role and audit/product kind. Example identities are
`S02.retry1.I` / `S02.retry1.V`, package S02. Requirements and old prerequisite
obligations are retained; new tasks can add obligations, not erase them.

An attempt record is mandatory when post-activation history contains original
owned implementation edits or registered outputs. Examine every relevant commit
on all ancestral branches between first original activation and transition freeze,
including edits subsequently reverted. Exclude only previously validated planning
bindings and coordinator transitions. An empty endpoint diff does not prove an
unexecuted attempt. A null attempt is valid only when that historical check finds
no attributed implementation/output work. This cannot prove that no process ran
without leaving repository evidence; the protocol does not make that claim.

Attempt files cover every original allowed path at its subject, with null for
absence. Artifacts bind every existing original cell log/declared output at the
evidence commit. The separate capture binding names the closed JSON artifact
described below; it cannot collide with an original artifact/log path.
Missing outputs remain missing; partial or mismatching TAP is preserved without
being interpreted as success. The original subject precedes evidenceCommit;
both precede transition freeze and replacement activation. Exact trees and hashes
come from Git, not timestamps. Original source states may later change, but frozen
manifests and preserved capture/log/artifact paths cannot be rewritten.

The capture artifact has exactly these fields:

```text
schemaVersion: 1
id: unique nonempty string
subject: {sha, tree}
executionBase: immutable commit
attributions: [{taskId, manifestSha256, cellIds: string[]}]
cells: [{
  id: original cell ID,
  command: exact original argv array,
  environmentId: original environment ID,
  environment: {id, platform, node, unicode},
  result: {exitCode: integer|null, signal: string|null, timedOut: boolean,
           durationMs: finite nonnegative number, outputBytes: nonnegative integer},
  log: file binding|null,
  artifacts: file bindings[],
  diagnostic: null|{code: nonempty string, message: nonempty string}
}]
```

The result fields describe captured execution, not acceptance; nonzero exits,
partial outputs and valid unpublished passing runs are legitimate observations.
No rejection diagnostic is required or fabricated for a valid unpublished run.
Cell/attribution sets must exactly account for the original manifest cells claimed
as executed; omitted, duplicate, cross-task or ambiguous attribution fails. Command
and environment identities must match those original frozen cells. Log byte counts
must match the bound bytes; declared artifacts must match original artifact paths.
Observed environment is checked against the captured approved environment profile.
A missing log is allowed only with zero output bytes, never for an existing output.
Diagnostics are preserved explanatory data and cannot override structural checks.

When I/V share a command/log path, one capture may attribute execution solely to I
and be referenced by its retirement. The V retirement can have null attempt only
when all shared output history is covered by that exact I capture and V has no
separate implementation/output history. Alternatively both can reference the same
capture with explicit, compatible cell attribution; this still does not establish
an independent review. The loader validates the retirement group together and
rejects any output left unattributed or assigned to contradictory subjects.

## Witness preservation and capture trust

Each old required cell maps exactly once to a new cell through witnessMappings.
No old requirement, environment, artifact obligation or literal test identity may
be removed. Test-name sets stay equal, not merely equal-sized. New cells may add
coverage. The mapping binds both actual manifest commands/cell IDs explicitly;
commands can change only to another registered owned witness whose exact literal
identities match. Timeout and output budgets must be equal or stricter. Original
artifact obligations remain and replacement logs get fresh paths. Generic semantic
renaming or a reviewer assertion that different test names mean the same thing is
not supported by this package.

For S02, a dedicated wrapper can expose the original four declared literal names
while independently running and checking all eight actual PythonText child cases.
That wrapper must be separately owned/frozen and reviewed; its nested evidence
cannot be reduced to child pass counts. P07 itself neither writes the wrapper nor
claims its acceptance. Emitted-subject discovery and exact TAP matching still run.

Reject any replacement output log whose hash equals a known preserved original
log hash, even at a new path/commit. Require a newly tested subject after activation,
fresh output paths, evidence ancestry and root-owned capture followed by independent
review. These checks reject known reuse; they cannot cryptographically prove that
an arbitrary process was rerun rather than its output forged. Trusted execution is
the root-owned capture boundary, with immutable receipts recording its result.
Do not claim that a timestamp, Git commit or differing hash alone proves execution.

## Graph and historical invariants

Decode every archive independently; reject duplicate IDs, unknown dependencies
and cycles before resolving transitions. Existing assignments stay in nextDag;
retired nodes remain historical. Exact accepted/receipted assignments, roles,
packages and dependency lists are unchanged through every archive. An unchanged
historical manifest is always validated against its own bound archive, never
against a conveniently edited latest definition.

Only never-frozen, unreceipted pending assignments can have dependency lists
refined in place. The refinements list must enumerate their exact before/after
lists. If a consumer already has a frozen manifest, changing its dependency
contract requires retiring and replacing that consumer too. New IDs cannot reuse
any historical ID or manifest path. Retirement of any task present in any receipt
shard history is rejected, even if a later shard tries to remove that receipt.

Derive final gate identities and their complete transitive ancestor sets from
the original approved DAG. Preserve each terminal identity and every ancestor
obligation, mapped through the complete transitive retirement chain. Also preserve
the equivalent obligations at every intermediate archive; a later transition
cannot erase a prerequisite added earlier. Reject replacement-map cycles before
computing closure. Every mapped prerequisite must remain an ancestor of the same
terminal, not simply appear elsewhere in the new DAG. Each replacement retains
all old prerequisites under that mapping. Added tasks must feed the relevant
replacement/final gate; no disconnected extra acceptance. Explicit edge mapping
from a retired obligation to its replacement never means it is already fulfilled.

For every independent-review assignment, the manifest's own archived DAG must
contain exactly one direct same-package implementation-or-gate dependency. Reject
zero or multiple matches, even if one matching ID ends in .I. Receipts must bind
that exact implementation receipt and subject. This supports new attempt names
without guessing identities or using a differently refined current DAG.

## Product structural versions

Historical product manifests must not be compared against an incompatible current
registry or exempted from registration. A transition contains a closed
packageVersions array; an audit-only replacement needs no product version entry.
Each PackageVersion is exactly:

```text
packageId: existing logical package ID
originalTaskIds: retired original product IDs[]
replacementTaskIds: corresponding new product IDs[]
previous: {
  packageSha256: structural package hash,
  registry: {path, sha256, revision}
}
next: {
  packageSha256: structural package hash,
  registry: {path, sha256}
}
additions: {allowed_files: new paths[], emittedFiles: new emitted paths[]}
```

The registry path is exactly `config/migration/packages.json`. The previous
binding identifies the actual immutable registry at an original manifest freeze,
not a caller-supplied lookalike document. At every listed original manifest freeze,
read that real registry and verify its package's structural hash and fields equal
the original manifest package. If original I/V froze at different revisions,
independently verify both registries; differing structural versions cannot be
collapsed into one entry. Preserve the old manifest's own DAG, inputs, ownership,
requirements and structural validation; only select its verified historical
registry version instead of the current one.

The next hash must equal every listed replacement manifest's package hash. Its
registry binding pins the full exact bytes expected at activation, without a
future revision reference. Activation reads the actual tracked registry and
compares its bytes, path and package contents. No product version is trusted merely
because the transition repeats a claimed hash. Root reconciles the registry as a
coordinator operation only during this exact validated activation.

The bounded structural delta is additive ownership: allowed_files may gain only
the explicitly listed new replacement manifest, witness, witness-support and
required emitted paths. emittedFiles may gain only declared corresponding runtime
outputs. New manifest/witness paths are absent from the original package; fixtures
must not predeclare future paths to avoid this check. Old allowed files remain;
all owner, activation, dependency, requirement, interface and reference fields
remain equal. The changed package's status is preserved from immediately before
activation, never promoted by lineage. Normal later status changes still require
existing scoped ownership and validation. Duplicate package-version entries or
unlisted added/removed ownership fail.

Compare the complete before/after registry: every unrelated package record and
top-level field remains unchanged. All named package deltas must match their
reviewed entries exactly. Multiple named replacements can share the same pinned
whole-registry output only when their nonoverlapping package deltas all validate.
No generic packages.json or config exemption is introduced. The exact review lock
must bind this registry update together with the catalog/lineage activation.

The active replacement passes ordinary current structural, prerequisite, source,
requirement and ownership checks; historical facts cannot satisfy them.
Product command mappings must also satisfy the unchanged current requirement
registry. P07 does not authorize requirement-shard rewrites or reinterpret its
command bindings; a product wrapper needing a new required command is outside this
bounded delta. The S02 wrapper is audit-form and does not have that product
restriction. The real product fixture can retain its required command/literal
identities while adding new retry-manifest and support ownership paths. Retired
unreceipted product tasks contribute neither current ownership nor acceptance.
Previously accepted unrelated packages retain their exact registry/receipt facts.
A package-version transition cannot modify a receipted package as a shortcut around
P06 handoffs. The loader supplies historicalRegistryByTask facts keyed by exact
manifest identity, while currentRegistry remains the actual checker registry.
Shared validatePackages remains unchanged; historical manifests use its normal
validation against the captured historical registry context, not a skip flag.

## Temporal activation and parallel histories

P06 rejects unknown replacement planning files while an original task remains
pending. Add explicit preparation records; do not waive that pending drift gate.
Each preparation is exactly:

```text
{id, author: "root", reviewer: "hooks_audit", reason, files: [{path, sha256}]}
```

IDs and paths are unique. Files are new pinned documents strictly beneath
`docs/migration/evidence/` with `.json` or `.md` extensions. They cannot overwrite
an existing tracked path, source, test, output log, manifest binding or artifact;
no symlink or arbitrary extension is permitted. Their actual bytes must match
before the preparation can authorize their presence. A subsequent preparation
cannot revise the same path/hash binding. Preparation records are append-only
under the same ancestry-aware history checks as transitions.

Preparation authorizes only that exact document creation. It grants no ownership,
execution, activation, readiness or acceptance. Prepared JSON is not executed or
used as a contract until the normal frozen contract validator accepts its later
binding. Old pending tasks still reject every unowned non-document change. The
lineage shard and review lock themselves use separately validated exact coordinator
transitions; preparations cannot exempt other metadata paths.

Acyclic commit sequence, checked at every actual staged snapshot:

1. Preserve the original raw logs at their existing immutable paths. Create its
   closed capture JSON and pin it in an initial preparation record; stage only
   that pinned document, appended shard and exact review lock, validate and commit.
   The capture binds the earlier original subject/evidence; no replacement manifest
   base is chosen before this preparation commit. Choose the replacement base at
   this commit or a later verified descendant containing the capture and adopted
   original source bytes.
2. Pin new DAG/manifest/audit documents, and any desired-registry review document,
   in another preparation. Stage the exact files, shard and lock, validate and
   commit. The desired-registry document is explanatory; it cannot change actual
   packages.json or grant registration. Normal manifest inputs bind the preserved
   capture already present at their immutable base.
3. Their now-known commit binds the next DAG and replacement manifests. Construct
   the transition, including exact old/new package versions, original attempt and
   its capture binding. Add another preparation pinning this transition document;
   stage it with shard and lock, validate and commit. Nothing is active yet.
4. Atomically append the transition binding and new catalog entries, apply only
   its exact reviewed registry delta, and update the review lock. Validate the
   staged tree through the actual checker before committing activation. Its
   transition and all preparation/document bindings refer to earlier commits.
5. Only after activation create the replacement tested subject and fresh outputs,
   then publish reviewed receipts through ordinary snapshot-checked commits.

Replacement manifests can precede their transition for acyclic hashing but cannot
activate beforehand. Their input base must include the original attempt and all
adopted source bytes. Base-to-activation changes remain limited to exact validated
planning/coordinator artifacts, now including prepared pinned documents. A source
edit concealed in preparation, even later reverted, must not pass execution-base
validation. The preparation creation commit must strictly precede any transition
binding it supplies; direct same-snapshot invented revision references fail.

Explicitly bind adopted original files to the preserved attempt hashes. A changed
implementation must instead be a real post-activation owned diff. New source
introduced by another verified parallel task follows P06's existing attribution
rules; lineage is not a generic source or metadata exemption. Corrected manifests
cannot backdate their activation to the original attempt, and original logs cannot
be claimed as fresh replacement evidence. New logs use fresh paths and descend
from the newly tested subject after replacement activation.

Lineage is a single reviewed chain. Two different transitions extending the same
previousDag compete and are rejected, including an eventual sibling-branch merge;
one branch must freeze a new rebased transition before activation. Identical
immutable bindings merged from siblings are the same transition and are not
applied twice. Independent ordinary catalog appends remain valid and do not move
another task's first activation boundary. Validate append-only coordinator
history by ancestry, not flattened chronological log order. Historical shards
must retain every earlier ancestral transition and immutable record; a merge
cannot erase a rejected branch transition to conceal its attempted activation.

## Acceptance and P06 coexistence

Lineage validation grants no accepted task/package IDs. Retired attempts leave
pending execution iteration and cannot unlock consumers; their preservation
checks continue on every load. New tasks remain open until existing exact-subject
receipt checks and independent review succeed. Invalid lineage, original receipt,
replacement receipt, missing artifact or metadata history invalidates the entire
batch and empties all current acceptance sets. P06 historical readiness remains
internal and scoped to its named successor/path; it is never globally restored
by a lineage mapping.

Previously frozen handoffs continue to name exact predecessor review receipts
and successor manifest hashes. A retired successor's handoff cannot automatically
transfer to a replacement ID. For this bounded implementation, reject retirement
of a task already named by a handoff contract. Reauthorization of such a handoff
requires a later explicit protocol; unaffected P06 chains must continue working.
This restriction does not block S02's inert audit attempt. Product→audit
substitution remains forbidden, and replacing an audit never creates product
acceptance. Reference/interface prerequisite receipts remain unchanged.

## Test-owner integration interface

Pure helper proposal:

```text
validateTaskLineage({preparations, transitions}, context) -> {
  errors,
  dagsByHash: Map<hash, assignment Map>,
  activeAssignments: Map<id, assignment>,
  retiredTasks: Set<id>,
  replacements: Map<oldId, newId>
}
```

Context contains the immutable root binding, decoded archives, original/current
catalog bindings, actual historical/current package registries, published
receipt-history IDs, handoff task IDs, and verified
facts keyed by transition ID. Facts include source/artifact hash maps, ancestry,
first activation and historical catalog membership. Caller-controlled JSON never
supplies trusted booleans. On error all returned resolution maps/sets are empty.
The replacement map is dependency-resolution evidence only, never accepted IDs.

`loadTaskLineage(io, {head, catalog, collection, handoffs})` collects these facts
using shared evidence IO and returns the validated resolution plus exact planning
bindings. It does not run tests or commands from receipts. Existing task loading
then validates historical manifests and all receipts before exposing acceptance.
To avoid validation cycles, preliminary lineage resolution is provisional until
the whole receipt/handoff batch passes; published receipt membership cannot be
filtered using that provisional retirement set.

Fixture support should expose `freezeTransition`, `activateTransition`,
`implementReplacement`, `captureReplacement`, and `publishReplacementReceipts`.
Each advances real disposable Git commits and verifies the actual staged snapshot
through checkInventory. Provide an original accepted A, an executed unaccepted B
with mismatched observed names, and a pending consumer C. Preserve B's source and
logs, retire B.I/V, activate new identities, rerun corrected cells, review exact
subject, and only then let C become eligible. No synthetic accepted registry or
hook bypass substitutes for that lifecycle.

Adversarial cases include competing transitions, tampered archives, changed
accepted dependencies, reused IDs, retirement of a published valid or invalid
receipt, lost final-gate ancestry, missing preserved logs, a valid unpublished
attempt, backdated activation, concealed source changes, old-log reuse, frozen
consumer edits without replacement, wrong emitted literal identities, partial
receipt batches, and coexistence with an unrelated accepted P06 ownership chain.
The S02 replacement preserves its original declared literal identities through
an explicitly mapped wrapper checking all eight actual child identities; exact
observed-name matching remains mandatory, regardless of pass counts.

## Frozen fixture ownership decision

The real product fixture gives A only its disjoint source, source-catalog and
manifest paths; A neither owns nor input-binds global `packages.json`. B alone
owns the registry for ordinary scoped status edits. Its replacement registry
structure still changes only through the explicit packageVersions activation.
Do not reuse the P06 shared-registry A-to-B handoff fixture unchanged: that would
make B handoff-bound and correctly prohibit its retirement. Test product lineage
without inventing a handoff exception or predeclaring future retry paths.
