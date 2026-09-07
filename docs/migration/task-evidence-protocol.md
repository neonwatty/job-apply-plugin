# P01 executable task evidence

This package implements the bounded task evidence verifier. It does not accept P01,
any bootstrap gate, any parent migration family, or the migration itself. Historical
work without a frozen task manifest remains historical evidence. New explicitly
scoped audits may rerun its witnesses; they must not fabricate retrospective planning.

The proposed catalog locations are `config/migration/task-contracts.json` and
`config/migration/task-receipts.json`. Root owns their registration and review-lock
reconciliation. An absent task catalog preserves the previous consistency behavior. The inventory
JSON now exposes `taskEvidence.currentAcceptance` and sorted accepted task/package
IDs; overall migration acceptance remains open.
A present catalog requires a clean tracked checkout. Invalid manifests, receipts,
contracts, dependencies, logs or file facts invalidate the entire batch: no task or
package is unlocked. The checker passes only accepted product package IDs to the
existing structural package validator. Parent acceptance remains open.

## Frozen contracts and planning order

The closed task catalog has `schemaVersion: 1`, `dag`, `assignments`, `environments`
and `audits`. `dag` and each audit binding contain `path`, `sha256`, `revision`.
The DAG is the approved assignment array, each with `id`, `package`, `role` and
`dependencies`; unknown dependencies and cycles fail. Roles are `reference`,
`implementation-or-gate` and `independent-review`. An assignment authorization
contains `id`, `author`, `reviewer`, and `manifest` (the same three-field binding).
Environments contain exactly `id`, `platform`, `node` and `unicode`.

A manifest contains exactly:

- `schemaVersion`, `id`, `role`, `kind` (`package` or `audit`), `author`, `reviewer`.
- `dag`: the approved path and SHA-256; `base`: the immutable input commit SHA.
- `package`: the existing structural package schema, including exact `allowed_files`,
  emission paths, interfaces, references, dependencies and requirement IDs.
- `packageSha256`: SHA-256 of sorted-key JSON for that package excluding `status`.
- `auditContract`: null for product work, otherwise the audit path and SHA-256.
- `inputs`: unique `{path, sha256}` entries binding every existing owned file and
  other declared inputs to the base. New owned files have no fictitious base hash.
- `oversized`: entries with `path`, `baselineLines`, `ceiling`, `extractionTargets`.
- `cells`: the required execution declarations described below.
- `artifacts`: exact required artifact paths, separate from owned source files.

Freeze the manifest in a planning commit after the immutable input base and before
the execution-base and tested-subject commits. The manifest's exact path is itself an owned file; this introduces
no exemption for other planning files. Its frozen bytes must remain identical in
the subject and current checkout. This avoids a self-referential base hash. Both
implementation and review manifests must be frozen before the implementation subject
if the review assignment will accept that exact subject. Planning file paths remain explicitly owned. The later receipt records an
`executionBase` commit after activation of the frozen catalog and its review lock.
The full input-base → execution-base diff may contain only exact authorized
DAG/audit/manifest paths, `config/migration/task-contracts.json`, and
`config/migration/review-lock.json`. Frozen bindings must match; historical catalogs
must preserve the same approved authorization identities, and the review lock must
bind every top-level migration JSON shard at that commit. All immutable base inputs
stay unchanged. Thus no caller-selected boundary can conceal an earlier source edit.
Only execution-base → subject is the implementation diff; it remains exactly scoped.

Concurrent implementation uses isolated branches/worktrees. A shared branch's
base-to-subject diff would include another worker's intervening commits and correctly
fail exact ownership. Preserve task subject ancestry when integrating branches; the
later evidence commit and final catalog commit may follow integration. No receipt
changes the tested subject SHA to a later integration or evidence commit.

Product manifests must match the registered structural package and existing required
scenario contracts. Every required platform and test binding is covered. Audit
contracts are separate closed objects: `schemaVersion`, `id`, `assignmentIds`,
`allowed_files`, `emittedFiles`, `dependencies`, `requirementIds`, `cells`, `artifacts`.
They bind the audit's scenario IDs without inventing product surfaces. Audit packages
have empty product surfaces, requirements, references and interfaces.

A cell contains `id`, `requirementIds`, `environmentId`, `reporter`, `command`,
`testNames`, `timeoutMs`, `maxOutputBytes`, `logPath`. The initial reporter is `node-tap13`:
only direct, literal, registered Node test names, an exact `node --test <file>`
command, and flat successful TAP13 are supported. A planning manifest may declare
a future owned test file with names that are not discoverable yet. Planning performs
no test execution. Every accepted receipt must prove those literal names from its
immutable tested subject, in addition to matching the observed log. The inventory
checker recognizes explicitly registered future test paths without broadening globs. Nested suites, dynamic identities,
other reporters and native adapters fail closed pending P05. Each product cell also
obeys its existing requirement command and budgets. Commands are never executed by
this loader. Maximum captured file/output size is eight MiB.

At most eight owned production modules are allowed, excluding declared emitted
copies. Production roots include QA and the JSX/TSX/MTS/CTS extensions. Source-size
enforcement separately mirrors every extension and excluded directory component in
`scripts/check-source-size.py`; reference and test sources remain covered, while
Markdown and JSON planning artifacts do not require source exceptions. Baseline
entries use the actual `{ceiling, owner, reason, removalPhase}` object schema. An oversized source requires owned extraction targets and ownership of
`.source-size-baseline.json`. It cannot grow beyond its actual base line count,
even when an old exception ceiling was larger. Shrinking lowers the exception;
reaching 500 lines removes it. New exceptions are rejected.

## Receipts and immutable evidence

The receipt catalog contains `schemaVersion: 1` and `receipts`. Each receipt contains:

- `schemaVersion`, `id`, `manifestSha256`, `status: passed`.
- `subject: {sha, tree}`, `executionBase`, and a separate `evidenceCommit` SHA.
- `diff`: exact ordered Git entries `{status, oldPath, path}`; A/M/D/R are supported.
  Both sides of a rename are owned. Deletions bind an explicit null file hash.
- `files`: exact owned `{path, sha256}` bindings, with null only for deleted paths.
- `dependencies`: exact approved DAG predecessor IDs and their canonical receipt
  SHA-256 digests; no caller-selected dependency subset.
- `cells`: `{id, environment, command, result, log}` for every required cell.
- `artifacts`: exact `{path, sha256}` bindings present at the evidence commit.
- `review`: `author`, `reviewer`, `subjectSha`, `subjectTree`, `manifestSha256`,
  `decision: approved`. The reviewer differs from the author. A review task's subject
  must equal its own implementation predecessor's subject.

`result` has `exitCode`, `timedOut`, `durationMs`, `outputBytes`, `tests`, `failures`,
`skips`, `cancelled`, `todo`. Success requires zero exit/failure/skip/cancel/todo,
no timeout, positive tests, and bounded duration/output. The observed TAP terminal
duration must itself fit the timeout and must not exceed recorded runner wall time
by more than one millisecond (the explicit rounding tolerance). Disposable runner
fixtures measure elapsed wall time around the actual child process. `log` is `{path, sha256}` and its path must equal the frozen cell's `logPath`.
Observed TAP names and counts must match declarations; equal passing counts with
wrong names do not qualify. The parser checks one initial header, ordered matching
announcements/results, one closing plan and a unique ordered terminal summary.
Duplicate reserved metrics cannot conceal the terminal duration. Log and artifact
paths remain immutable and current; symlinks, missing or untracked files fail.

Git facts use fixed read-only commands with replacement objects disabled. No
receipt-provided executable, shell command or Git option is executed. Regular-file
modes are required for evidence at every accessed revision. Subject tree, full diff,
file bytes, ancestry, artifact/log hashes and current bytes are read independently.
The receipt is committed after its evidence commit, avoiding a self-hashing commit.
These are reviewable local evidence records, not cryptographic attestations of a
runner or reviewer identity; a reviewed catalog remains the authorization boundary.

## Later approved edits

Historical subject hashes stay immutable. A later task may supersede a source file
only through a complete valid receipt chain: it owns that path, binds the previous
subject bytes as its base input, depends transitively on the previous task in the
approved DAG, and its base descends from the previous tested subject. The final
successor must match current bytes. Missing or stale successor receipts invalidate
the whole batch. This is not a general waiver for stale inputs, nor does it permit
rewriting historical manifests, logs or artifacts. Dependencies are always checked
against current relevant inputs through this chain.

## Remaining lifecycle and ownership boundaries

Current product ownership reuse remains blocked by the existing structural validator.
An accepted predecessor does not by itself authorize releasing its files to another
writer. The receipt successor chain verifies historical evidence; it does not provide
a reviewed ownership handoff. Such a handoff needs an explicit contract before product
packages can share previously owned files. No release flag is inferred from status.

A frozen pending descendant can hold current acceptance open while its commits and
evidence are assembled. It must own each changed predecessor path, bind the previous
subject bytes at its immutable input base, and depend on that predecessor in the
approved DAG. Its execution base is derived from the assignment's first catalog activation with
identical manifest, actor, environment and audit identities,
validated under the same exact planning rules. Activating another parallel task or
reviewed environment cannot shift an older task's execution boundary. Pending changes are limited to frozen
owned paths, declared artifacts/logs and independently validated planning/evidence
metadata. Undeclared drift remains an error. No failing, malformed or stale receipt
is converted into a pending state.

When such a pending edit affects historic evidence, `currentAcceptance` is `open`
and both accepted-task and accepted-package sets are empty. Historical receipt
digests remain available for eventual successor binding; they are not acceptance.
A complete valid successor receipt restores current acceptance through the immutable
chain. Invalid batches return `invalid` and unlock nothing. The staged-snapshot
regression exercises this before source, evidence and receipt commits, without a
hook exemption. The snapshots are real temporary Git worktrees of the staged tree;
these tests verify the evidence loader used by the hook, not unrelated hook suites.

The approved DAG hash is frozen for this catalog lineage. Later task splits require
a separately reviewed DAG-lineage protocol preserving receipted assignments and
dependencies. Until that exists, use an immutable archived approved DAG; never
silently rehash historical manifests after changing a generated plan.

## Evidence in this package

Pure manifest/receipt tests remain in the fast tier. Actual Git lifecycle tests run
in the full-tier `node-migration-evidence` suite and the focused author/reviewer
gate, so every ordinary commit does not replay the longer Git lifecycle. Full
integration and pre-push checks retain that coverage.

Focused tests exercise malformed manifests and receipts, identity substitutions,
self review, wrong SHA/tree, budgets, stale dependencies, invalid-batch closure,
rename/delete ownership, actual source-size growth, strict reporter sequencing,
and an implementation → review → dependent edit chain. Disposable Git tests capture
actual Node TAP, separate planning/subject/evidence/catalog commits, and reject dirty,
untracked, symlink, out-of-scope, rewritten-manifest and replaced-object evidence.
The chain is covered both with explicit trusted facts and through actual staged
planning → implementation/review → evidence → receipt → pending successor → successor
receipt snapshots. Full native or distributed runner acceptance is outside P01. Existing prerequisite tests protect shared-reader
and legacy parser behavior. Root performs the final combined gate and independent
review before registering any real task acceptance.
