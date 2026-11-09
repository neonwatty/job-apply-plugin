# Current Python/TypeScript parity triage

Base: `staging` revision `43d5a687873037040cd2171b402de52e7ffd644f`.
This is an inventory and evidence triage, not migration acceptance. Regenerate the
cell-level list with `node tools/migration/triage-report.mjs --json`, or read the
compact totals with `--summary`. The report is calculated from the current
surface and requirement shards, so later batches change its totals automatically.

## What the number means

The catalog has 778 public surfaces. The checker pairs every surface with ten
scenario categories, creating 7,780 planning cells. A requirement row maps a
cell even when it has only planned tests; it does not grant passing evidence.
After this triage:

| State | Cells | Meaning |
| --- | ---: | --- |
| Required, planned | 101 | Named oracle and test binding planned; current acceptance is still open. |
| Reviewed inapplicable | 36 | Source-backed reason says the named surface does not own that scenario. |
| Unassessed | 7,643 | No requirement mapping yet. Existing unbound tests and genuinely untested behavior both occur here. |

The 7,643 unassessed cells are **not** known defects or failing tests. The
checker deliberately keeps every inventory scenario `unverified` and reports
`acceptance: open`. The current grid has no field that records a confirmed
Python/TypeScript mismatch.

| Surface kind | Surfaces | Required, planned | Reviewed inapplicable | Unassessed |
| --- | ---: | ---: | ---: | ---: |
| CLI | 293 | 45 | 0 | 2,885 |
| Browser export | 277 | 56 | 36 | 2,678 |
| HTTP | 155 | 0 | 0 | 1,550 |
| Document | 31 | 0 | 0 | 310 |
| Journal | 22 | 0 | 0 | 220 |

The CLI inventory includes Python commands, native commands, policy commands,
and entry points as separate surfaces. The original Python Store has 98
subcommands, not 293. In particular, the native Store inventory has 18 answer
and 24 resume command records with only one mapped answer cell and no mapped
resume cells.

## Behavior differences and evidence to link

No current mismatch was reproduced in the [job lifecycle](current-parity-evidence-batch-02.md),
[job contention and recovery](current-parity-evidence-batch-03.md), or
[profile/preferences CLI comparison](../../tests_js/native_profile_cli_parity.test.mjs)
already run on separate disposable Python and native Stores. This says nothing about unassessed commands
or non-CLI surfaces. A confirmed difference requires a reproducible shared
synthetic input and compared response, diagnostic, durable state, and authority
effects; it then needs a regression test. Do not infer one from an unmapped cell.

Some unassessed cells already have useful tests that need precise requirement
bindings. The [hybrid asset test](../../tests_js/workspace_hybrid_assets_support.mjs) checks seven GET/HEAD asset paths for bytes,
headers, empty HEAD bodies, and guarded paths, while HTTP has no current
requirement mapping. The [job CLI recovery test](../../tests_js/native_job_cli_lifecycle_parity.test.mjs) compares a torn coordinator
journal and repeated read across both runtimes, while document and journal
cells remain unmapped. Those tests should be inspected against each specific
scenario before a binding is added; a broad suite name does not prove every
case.

The prior 24 reviewed inapplicable cells cover concurrency, interruption, and
recovery for eight pure Trash presentation helpers. This triage adds 12 more
for four direct hash parsing/job filtering helper exports in UI0/UIF. Source
review found no owned scheduling, durable mutation, interruption checkpoint,
or recovery state in those named functions on ordinary data inputs. Browser
bootstrap, callers, and Store mutations remain separate surfaces. Other pure
helper aliases are still unassessed; no category was subtracted wholesale.

## Actionable queue

1. **Bind existing evidence precisely.** Start with the seven hybrid asset
   GET/HEAD paths and the coordinator journal recovery test. Check that each
   proposed binding has an independent oracle, exact test identity, and the
   durable or wire observation that the scenario requires.
2. **Run the next CLI differentials.** Prioritize native answer and resume
   commands, which have many unassessed cells and durable data/privacy risks.
   Use separate disposable Stores and compare failures, state, and repeat reads.
3. **Review applicability per surface.** Mark another cell inapplicable only
   after source review supplies the rationale, reviewer, and hashed source
   paths. Preserve concurrency/interruption/recovery requirements for writers,
   journals, locks, and other surfaces that own those behaviors.
4. **Fix confirmed counterexamples.** Record exact Python/native inputs and
   outputs, add a minimized regression, then fix the implementation. No new
   confirmed counterexample was established by this inventory triage.
5. **Advance acceptance separately.** Planned mappings and green local suites
   are not accepted migration evidence; immutable execution receipts and
   independent review remain required by the [acceptance contract](acceptance-contract.md).

The machine-readable `cells` array gives every surface ID, scenario, state,
and mapped requirement ID where one exists. Filter it by kind, node, or
category to assign bounded work without treating all 7,643 cells as defects.
