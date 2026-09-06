# Executable inventory checkpoint I2

This is a partial implementation of node I, not its acceptance. Parent I remains
open until document/journal/writer classification and reviewed
behavioral evidence are represented and checked. The current gate intentionally
cannot grant migration acceptance.

## What is recorded

- 36 graph nodes and hard dependency edges, including stricter explicit table edges.
  Family REF prerequisites still need per-surface evidence binding before Ready.
- 255 source/manifest file hashes across scripts, workspace, QA, native, source and
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

All 399 surface records have unclassified effects and unverified scenario cells.
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
- Add document types, journal kinds, native adapters and all installed
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
