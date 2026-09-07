# P10: isolate verbose reference suites without widening output limits

External proposal only; no repository edits or tests. Start after accepted P03.retry2.V, S04.R and S05.R. P10.I depends on those three; P10.V depends on P10.I/P01.V. Append P10.V to never-frozen T05.I while preserving every existing dependency; validate that eligibility at both transition preparation and activation, rather than assuming it from this proposal. Use an inert CI audit package and the actual then-effective DAG; coordinator resolves actors and immutable bindings.

## Proven problem and bounded change

The five accepted reference logs total2,268,762bytes: S04=569,260; S05=1,699,502. Current node-workspace-other runs every selected file in one Node process with2,097,152bytes per stdout/stderr stream. New references alone exceed that cap by171,610bytes, before existing workspace output. Individual frozen reference captures remain below their unchanged1MiB caps.

Move the two point_persistence files into `node-reference-s04`, and the three point_paths files into `node-reference-s05`. Both are node-test/full-only with explicit maxOutputBytes2097152. Remove only their five old literals from node-workspace-other. Preserve all existing other suites, global rules, limits, environments and platform behavior. Each group gets its own process through the existing suiteCommand implementation; do not edit runners or raise caps. Exact suite objects/filename lists are in the JSON proposal.

Keep execution serial under the coordinator’s existing --concurrency=1 heavy-run discipline; splitting matrix groups does not create a host lease or change default runner scheduling. Actual integrated execution must verify complete untruncated logs. Historical byte totals establish the current problem, not a perpetual upper bound on future output.

## Preserve consumer selection

Append both new suites to the existing broad tools/contracts/** and scripts/**/*.py ownership rows while keeping every previous owner. This preserves their old conservative reach through shared Python initialization and legacy reference drivers. Add S04 evidence docs plus its atomic/jsonl baseline test sources to S04. Add S05 evidence docs plus all six baseline/sourcePins test sources (atomic,jsonl,managed-resume-path,posix-path-bytes,private-digest,managed-observation) to S05. The S05 JSON actually hashes the atomic/jsonl test files too, so omitting those edges would be incorrect. Moved tests select their own suites through ordinary self-ownership. Existing migration/tooling globals already select every full suite.

Generic docs remain links-only unless inside the explicit reference input directories. Native/browser tiers are not broadened. Full inventory must continue to count each test exactly once, including both new groups.

## Frozen witnesses and scope

Retain all eleven existing selection names/bodies. Add exactly two literal names:

- `P10 reference suites isolate S04 and S05 without changing process output limits`
- `P10 reference suite ownership preserves shared inputs and rejects missing or duplicate coverage`

One existing registered command `node --test tests_js/test-runner-selection.test.mjs` captures all13 names,180seconds/1MiB, zero failures/skips/cancellation/TODO. First new witness asserts actual grouping, exact filenames, full-only tiers,2MiB caps, exact-once inventory and actual suiteCommand arrays. Second asserts independent fixed expected input→suite fanout and mutates cloned matrices to remove owners/files, duplicate membership and collapse grouping/change caps. Do not derive all expected ownership from the matrix being tested. These are static matrix/selection tests; they do not rerun the five large native/reference captures.

Executable/config ownership is config/test-matrix.json, existing selection test, and the new tests_js/reference_suite_support.mjs test helper. New planning/audit/DAG/manifest/transition files live under docs/migration/evidence/p10. All source/tests stay≤500physical lines. The selection file keeps its eleven existing bodies and adds only two literal callbacks. The new helper holds fixed independently authored suite/file/input expectations and readable assertion/mutation helpers, exported as assertReferenceSuiteIsolation(matrix, tracked) and assertReferenceSuiteFanout(matrix, tracked). It does not register tests, spawn processes, generate source or define production policy. Add its exact path to node-runner-fast ownership in the matrix; no new command/glob is needed. This makes the assertions inspectable without squeezing the existing427-line test to its ceiling. No S04/S05 source, raw log, runner, consumer graph or process recipe changes.

The selection test’s revised source identity intentionally invalidates its old finite process recipe in the live graph. Do not renew that pin: conservative live fallback is correct and the immutable b540 six-rule proof remains mandatory. New P10 assertions/helper need no new subprocess; use existing matrix APIs (suiteFiles and suiteCommand may be imported read-only). At freeze bind their recursive local import closure, current analyzer/tooling inputs, package/lock/config and the accepted reference input documents supporting the exact fanout; avoid permanently freezing all product source merely because discovery observes it.

## Separate generic runner defect

Direct test:affected/full uses runStreaming, whose prefixStream clips excessive output and emits a truncation message without forcing a failed result. A zero-exit child may therefore produce a passed suite with incomplete evidence. verify:deep instead uses runLocalCommand and fails output-limit. P10 avoids the demonstrated overflow through grouping, but does not repair or conceal this generic discrepancy. A separate runner task must define truthful overflow behavior and exercise real stdout/stderr overrun cases; neither runner belongs in P10 ownership.

The new helper is a future owned implementation path, not an invented immutable base input. Its final source and transitive imports must be reviewed/captured after activation; all old selection assertions and the immutable baseline proof stay intact.
