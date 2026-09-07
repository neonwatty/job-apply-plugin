# Executable inventory checkpoint I4

This is a partial implementation of node I, not its acceptance. Parent I remains
open until writer classification and reviewed
behavioral evidence are represented and checked. The current gate intentionally
cannot grant migration acceptance.

## What is recorded

- 36 graph nodes and hard dependency edges, including stricter explicit table edges.
  Family REF prerequisites still need per-surface evidence binding before Ready.
- 263 source/manifest file hashes across scripts, workspace, QA, native, source and
  emitted runtime. Every entry remains `unreviewed` for classification.
- 144 Python CLI subcommands, discovered by AST without importing application code
  or running main. Literal parser names and Chrome's constant loop were expanded.
- 17 root parser construction surfaces, including internal QA entrypoints.
  Root surfaces identify options-only interfaces and still need shipped/internal
  classification; they are not claimed to be 17 distinct installed launchers.
- 127 workspace HTTP surfaces from independent inspection: see the
  [HTTP inventory review](http-inventory-review.md) for aliases and route order.

- 111 browser module/export identities, independently enumerated and compared with
  a parse-only checker; see [browser review](browser-inventory-review.md).

- 28 persisted artifact patterns and 19 journal variants, including three empty
  operations. See [persisted-state discovery](persisted-state-inventory-review.md).

All 446 surface records have unclassified effects and unverified scenario cells.
Mapped node IDs are proposed responsibility, not implementation/test acceptance.
In particular GET or a command name containing `get` never proves absence of writes.
Static-asset routes and rejected-method classes are distinguished in their review.

## Running and interpreting the gate

```sh
npm run check:migration
npm run check:migration -- --acceptance
```

The first command checks consistency only. The second currently fails intentionally:
the migration still has required unclassified and unverified coverage. A successful
`inventory-consistent` result is never a passing migration or release result.
The gate runs in fast/full tiers; it does not run browsers, Python or application code.

The checker includes untracked source modules and rejects additions, edits, deletions
and renames until inventory is reconciled. Source content hashes bind manual route
and command observations to exact implementations: a dynamic predicate cannot change
silently. It also rejects invalid ownership, cycles, duplicate public identities,
missing source bindings, malformed HTTP methods and invented acceptance claims.

A review lock binds all inventory shard bytes. Removing a route record or editing
scenario claims requires an explicit lock reconciliation. This is a regression guard,
not a signed attestation or proof that a manual inventory contains every route.
Updating hashes alone is never sufficient review. No automatic refresh command is
provided; the coordinator must inspect the semantic change and adjust corresponding
surface/scenario mappings before sealing a new reviewed snapshot.

## Reconciliation protocol

1. Identify changed/new/deleted sources and inspect the behavior/dispatch changes.
2. Enumerate added/removed commands, aliases, actions, routes, options, exports,
   entrypoints and effects. Unknown dynamic construction requires an explicit adapter.
3. Add/update the appropriate surface records; deletion needs evidence the surface
   is removed from all callers and the package, consistent with approved scope.
4. Reopen affected acceptance cells, including downstream integration evidence.
5. Independently review the mappings, then update source hashes and shard lock.
6. Run checker regression tests, inventory consistency and relevant behavioral tests.

Readable JSON is sharded below 500 physical lines. No compact record packing is used.
The current source discovery does not inventory JSON fixtures, all documented command
examples or dependencies as public interfaces; package and documentation reachability
must still be reconciled before I and CLOSE can pass. Changes to manifests are guarded.

## Remaining node I packages

- Review AST-derived CLI records against safe actual parser construction and root
  option/launcher aliases; record any dynamic extraction adapters durably.
- Complete ancillary artifact discovery, native adapters and all installed
  entrypoints, then classify every source and write effect with source evidence.
- Define accepted scenario receipt schema with required command/test/platform binding,
  reviewed inapplicability and stale-dependency detection. Until then all acceptance
  claims fail rather than trusting a status string.
- Add readiness/ownership checks for child packages and explicit per-family REF
  edges; verify the machine graph and prose graph stay synchronized.
- Extend discovery/behavior adapters as Python modules move to TS without resetting
  inventory or losing historical coverage. Final required tools remain Python-free.

This checkpoint is durable scaffolding for those packages. No filesystem port,
writer switch or completion claim is authorized by its green consistency result.

Scenario requirements include valid, invalid, missing, no-op, privacy, conflict,
concurrency, interruption, recovery and platform. Adding the three previously
implicit categories opens cells explicitly; no existing evidence was promoted.
Inventory acceptance will require complete classified requirements and bindings,
while family REF acceptance separately requires passing reference receipts. This
avoids making whole-inventory acceptance depend on its own descendant behavior.

## I4 requirement and ownership declarations

Ten initial Trash-family requirement records bind registered test files, exact
literal test identities, canonical runner arguments, command bounds and current
oracle bytes. A parse-only adapter discovers nonempty direct node:test declarations;
dynamic test construction and other runners need an explicit adapter. This proves
registration, not assertion quality, test execution or passing behavior.

The checker reports 4,380 remaining unmapped requirement cells. The mapped 80
cells are declarations across eight module/export identities, not 80 passed tests.
The selected whole-file commands execute the shared reference suite; category and
per-helper adequacy still need receipt review before behavioral acceptance.

The Trash machine package is now formally implemented with a verified reference
and compiler prerequisite. The ledger retains its independent local implementation
results. Prerequisite receipts bind exact reviewed file/requirement scope, canonical
commands, current and committed hashes, a verified ancestor relation, known runtime
profile, independent review and complete captured TAP counts. They do not grant
whole-package, node or release acceptance. The supported TAP adapter currently
requires direct top-level tests; unsupported report forms fail closed.

The loader executes only fixed Git inspection commands, never receipt commands.
It rejects static symlink components before reading evidence. It is a local
repository evidence loader, not a guarantee against concurrent hostile filesystem
replacement or a replacement for live Store path-security adapters.
A dependent package must have accepted references covering every required scenario;
an unrelated passing reference cannot unlock it. An explicitly released, accepted
historical package retains its original allowed_files while a repair takes ownership.

Requirements require reviewed source-bound inapplicability; pending behavior can
coexist with a valid declaration. Inventory acceptance and behavioral acceptance
remain separate gates. Migration-wide --acceptance remains deliberately failing.
