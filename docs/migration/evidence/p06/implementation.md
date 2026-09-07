# P06 implementation contract: reviewed product ownership handoff

Design only until P06.R and P01.V are accepted and both implementation/review
manifests are frozen and activated. This package closes the existing P06 DAG
acceptance: an accepted predecessor can hand exact overlapping paths to one approved
successor without weakening historical evidence. Metadata lifecycle repair is a
necessary part of that integration, not sufficient evidence of P06 completion.

## Scope and prerequisites

The companion implementation-audit.json owns exactly seven production modules:
`evidence-io`, `task-manifests`, `task-receipts`, `load-task-evidence`, `packages`,
`check`, and new `task-handoffs`, all under tools/migration with .mjs extensions.
It also owns the four existing impacted test files, existing task support, two new
regression files, new handoff support, these documents and both future I/V manifests.
Every file must stay at most 500 physical lines. No emitted production runtime is
needed. Root owns matrix registration and inventory reconciliation; the worker does
not own the actual catalog, review lock or actual handoff authorizations.

The new leaf task-handoffs depends on shared immutable evidence primitives only.
The loader gathers Git/filesystem facts; pure handoff validation consumes those
facts. The checker composes task acceptance and structural ownership validation.
Existing primitives must not import checker or handoff integration modules.

Existing P00/P01 manifests currently bind tooling source, not catalog/review-lock
contents. Freeze P06.R first and accept its actual baseline witnesses. Then freeze
P06.I and P06.V with current source hashes and exact seven-module ownership; activate
these manifests before editing accepted tooling. Both I/V subjects and reviews must
obey the current archived DAG: P06.I requires P01.V and P06.R; P06.V requires P06.I
and P01.V. Empty structural audit dependencies do not waive those task dependencies.

## Separate closed handoff shard

Keep the current task-contract catalog shape unchanged. Proposed optional path:
`config/migration/task-handoffs.json`, containing exactly `schemaVersion: 1` and
`handoffs`. An absent shard means no ownership release. Each handoff entry binds
exactly `path`, `sha256`, `revision` to a frozen regular-file contract. The inventory
review lock must include this shard when present. No arbitrary receipt-supplied
path or command is executed.

A frozen handoff contract contains exactly:

- `schemaVersion: 1`, `id`.
- `predecessorPackageId`, `predecessorPackageSha256`, `predecessorReviewTaskId`,
  `predecessorReceiptSha256`.
- `successorPackageId`, `successorPackageSha256`, `successorTaskId`,
  `successorManifestSha256`.
- `paths`: nonempty unique `{path, sha256}` entries binding the exact overlap and
  predecessor subject bytes; paths must appear in both structural ownership lists.
- `author`, `reviewer`, `decision: approved`.

The predecessor review task must actually be an independently accepted V task for
that predecessor product package. The successor actor must match its frozen
manifest and structural owner; the reviewer must match the independently authorized
reviewer and differ from the author. The successor must depend transitively on the
predecessor review in the approved DAG. Require predecessor subject ancestry in the
successor immutable base, and matching successor base input hashes for every path.
The handoff revision must precede source changes and remain immutable/current.

The frozen successor manifest already exists when its hash is bound. Root can then
commit the handoff contract and activate the separate shard before implementation.
Treat those exact immutable contract bindings as reviewed planning artifacts; this
must not become a generic docs/config exemption. The execution boundary must follow
both successor authorization and its required handoff activation. Changes to an
unrelated handoff must not move an already active task's boundary.

Reject duplicate IDs, duplicate paths, unknown package/task IDs, wrong structural
hashes, stale receipts, non-V predecessor claims, self review, unknown actors,
missing dependencies, changed input bytes, scope expansion and two active successors
for one predecessor path. A handoff authorizes ownership transfer only; it does not
claim that the successor's behavior is accepted.

## Structural and evidence integration

Do not implement partial transfer by passing the predecessor ID into the existing
blanket releasedPackages set: that would release every owned path. Add an explicit
validated per-path handoff context to validatePackages. Release only the contract's
exact overlap to its one named successor; keep every other predecessor path reserved.
The usual implemented/ready checks, required references/interfaces and requirement
coverage remain mandatory. Arbitrary caller status or a handoff-like field in a
package must never manufacture release.

During approved successor edits, historical predecessor receipts remain valid but
current acceptance is open. Return empty current accepted sets while unresolved
authorized drift exists. The checker may use independently verified historical
predecessor evidence solely for the named handoff successor's dependency readiness;
it must not restore general acceptedPackages or unlock unrelated dependents.
This distinction needs explicit trusted context, not swallowing structural errors.

Once the successor's full receipts and independent V review pass, its exact subject
must match current bytes through the validated chain. Only then report current
acceptance. If any record in the required batch is malformed, no partial release or
acceptance survives. Raw receipt assertions cannot satisfy the handoff verifier.

## Coordinator metadata evolution

The worker does not own config/migration/review-lock.json. Catalog and lock changes
are coordinator operations proven separately from the owned implementation diff.
Keep recording the complete actual Git diff; classify only exact validated metadata
transitions. Do not delete these entries from receipts or normalize their hashes.

The permitted coordinator paths are the task catalog, receipt shard, new handoff
shard and review lock, each with its own closed-schema validation. At every relevant
revision the review lock exactly binds every top-level migration JSON shard and
nothing else. Catalog evolution preserves prior actor/manifest/environment/audit
identities and the frozen DAG. Receipt evolution preserves existing immutable
receipt identities and validates new records before they can affect acceptance.
Handoff evolution preserves frozen bindings and rejects conflicting recipients.
Unrelated shard edits are still outside the worker's allowed diff.

For manifests binding coordinator metadata as read-only inputs, distinguish its
exact base hash from subsequent independently validated transitions: verify the
base bytes first, then prove the permitted path-specific transition at activation,
subject and current evidence revisions. Do not apply this rule to any source input,
frozen manifest, log or artifact. This removes the activation/receipt self-reference
cycle without treating all configuration as mutable. A changed file masquerading
as one of these schemas must fail closed.

## Regression and completion contract

The audit names every test literally. The four existing impacted suites retain
all 37 current literal names. New handoff tests prove the actual registered product
checker path: overlap fails without a handoff; exact reviewed transfer succeeds;
forged/stale/expanded/competing transfers fail; unreleased paths remain reserved;
and pending versus independently accepted completion is reported correctly.

New metadata tests prove actual activation and receipt snapshots, forbidden source
or unrelated-shard edits, immutable historical identities, and the complete product
lifecycle through real dependency-linked hook snapshots. Reuse withSnapshot with
its node_modules dependency link, not an approximation that omits hook-created
files. Exercise staged activation, implementation, evidence, receipt, a later
successor and a parallel authorization that must not shift existing boundaries.
The root checkout/index must remain unchanged after disposable tests, and unrelated
untracked files must still fail cleanliness.

Test fixtures must include a real registered implemented product A with accepted
reference/interface requirements and a ready product B. Pure audit receipt tests
alone cannot satisfy this package. Verify that a third product C cannot reuse A's
historical proof through B's limited readiness authorization. Include partial
ownership transfer so accidental whole-package release is observable.

Each of the six audit cells has a 180-second wall budget and one-MiB output bound.
Cell logs have distinct exact paths under docs/migration/evidence/p06/logs. I/V may
share immutable execution logs at the same subject, but V must independently review
the exact subject and outcomes; shared logs do not claim separate reruns. Required
skips/failures/cancellations/todos/timeouts fail acceptance. Extra artifacts are not
required. Root registers the two new literal test paths and support ownership,
keeping costly actual-Git lifecycle replay in the full tier and focused review gate.

P06 is done only after all six cells, applicable existing integration checks,
source-size checks and independent exact-subject review pass, with the real
registered product path and coordinator lifecycle covered. Do not mark a metadata
repair or an audit-only successor chain as full P06 completion. Evolving the frozen
DAG, native reporters and production Store activation remain separate packages.
