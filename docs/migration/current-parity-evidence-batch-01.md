# Current parity evidence batch 01: native CLI boundaries

Base: `staging` merge `7dcccfa75b8a30b80a6b635dca7478a5246d54e0`.
This batch records requirement-to-test declarations. It does not grant behavioral
acceptance, native platform acceptance, or migration acceptance.

## Inventory finding

The current native Store root and the native final-action policy root and seven
policy commands had source catalog entries but no CLI surface records. The new
`cli-native-entrypoints-surfaces.json` shard records all nine identities. A
focused test compares the seven policy names with the Python parser and checks
the native root rows, so a later policy command cannot silently escape this
inventory boundary. All nine rows retain unclassified effects and unverified
scenarios.

## Mapped requirement cells

`requirements-current-native-cli-01.json` maps only the scenarios named here.
Each binding names an exact registered Node test and frozen Python oracle bytes.

| Surface | Scenario | Test observation |
| --- | --- | --- |
| Native Store root | valid | Global help exits successfully and lists Python Store commands. |
| Native policy root | valid | Global help exits successfully and lists Python policy commands. |
| `profile-patch` | missing | Required arguments fail with usage and exit 2 before Store creation. |
| `answer-key` | valid | Repeated `--question` values use the last value, matching Python output. |
| `task-intake` | valid, invalid, missing, noop, privacy | The CLI test exercises create/update, invalid options, absent input, repeat intake, and redacted output on a disposable Store. |

These bindings are a plan for exact scenarios, not evidence that every possible
behavior in a category is covered. `task-intake` is a TypeScript extension; its
Python oracle is the original Store job-intake implementation, not a Python
`task-intake` CLI command.

## Count and remaining work

Before this batch: 769 inventoried surfaces, 80 mapped cells, 7,610 unmapped
cells. After this batch: 778 surfaces, 89 mapped cells, 7,691 unmapped cells.
The backlog grew because nine omitted surfaces add 90 required scenario cells;
this batch maps nine. The remaining cells by interface are CLI 2,921, browser
2,690, HTTP 1,550, documents 310, and journals 220. No cell is accepted by the
current checker, which intentionally reports `acceptance: open`.

The next CLI batch should separate parser help/argument cases from command
behavior, add command-specific response and durable-state oracles, and map only
the scenarios those tests actually exercise. Independent review and immutable
execution receipts remain necessary before any cell can be accepted.
