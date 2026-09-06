# Browser export inventory review

The seven browser surface shards enumerate 111 module/export identities across
all 16 JavaScript modules under `workspace/`. This is an exported API inventory,
not evidence that behavior is verified or that the browser migration is complete.
Every effect remains unclassified and all seven scenario cells are unverified.

## Static extraction

TypeScript's available compiler parsed each JavaScript source as an AST. The
review inspected exported function, class and variable declarations, named
reexports, export-star declarations and default-export forms. No module was
imported or executed; bootstrap, browser globals and Store code were not invoked.

`workspace/app.js` has two relative export-star declarations for `lib/api.js`
and `lib/helpers.js`, plus named reexports of `bootstrapWorkspace` and
`createWorkspaceContext`. Their relative source paths were resolved statically
against the complete module list, and target names were checked recursively.
The barrel has 49 exports: 11 API, 36 helper and two bootstrap exports.

The inventory binds each record's first source to its exporting module. Barrel
records additionally bind the defining source. Thus `app.js:tokenFromHash` and
`lib/api.js:tokenFromHash` are separate externally importable identities, not
duplicate inventory errors. The extraction rejects unresolved targets, conflicting
star names, cycles and unsupported export forms instead of silently dropping them.
No local export lists, namespace reexports or default exports occur in this tree.

## Counts and ownership

| Module family | Identities | Assigned node |
| --- | ---: | --- |
| app.js barrel | 49 | UIF |
| bootstrap.js | 2 | UIF |
| Ten feature modules | 10 | UIF |
| lib/api.js | 11 | UI0 |
| lib/helpers.js | 36 | UI0 |
| lib/dom.js | 1 | UI0 |
| lib/state.js | 2 | UI0 |

The library records occupy three shards, the barrel three shards and feature/
bootstrap records one shard. All records use normal expanded JSON formatting
and every file remains below 500 physical lines. UI0/UIF identify migration
owners; they do not classify every library function as pure or safe to execute.

`ApiError` is an exported class and `FACT_SAVE_REVISION_RETRIES` is an exported
constant. Counting only `export function` would miss both. Reexports are resolved
by declared exported name, preserving each module's import surface.

## Remaining gates

This inventory does not enumerate private functions, closure methods, DOM event
bindings, coordinator properties or runtime objects returned by factories. Those
are behavioral interfaces requiring separate effect and scenario classification.
It also excludes recorder/renderer modules outside `workspace/`, which belong to
their own inventory families. Static HTTP asset exposure is recorded separately.

Future source changes must trigger reconciliation, including new JavaScript
modules and changed reexports. An independent extractor/checker should compare
the exact module/export pairs and source bindings against these shards; review
lock hashes alone cannot establish that source extraction is complete. No current
scenario receives acceptance credit from this static inspection.

## Independent checker review

The coordinator checker independently matched all 111 identities and required
source bindings. Review reproduced two future fail-open forms: local export lists
and differently aliased bindings reaching the same terminal file. These now fail
closed with regression tests. Repeated star bindings conservatively require review
even when valid JavaScript would resolve them. All 13 focused inventory tests pass
without skips. No behavioral acceptance follows from this result.
