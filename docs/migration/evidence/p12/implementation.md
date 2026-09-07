# P12: isolate the historical graph proof from its launching environment

External draft only. Wait for accepted P11 before any P12 documents/manifests: P12 read-binds process.mjs and must capture its accepted corrected bytes. P12.I depends directly on P11.V, P10.V and P03.retry2.V; P12.V depends on P12.I/P01.V. Append P12.V to eligible never-frozen T05.I preserving all dependencies.

## Reproduced cause and scope

Real npm lifecycle injects npm_config_prefix even when a direct Node launch has no guarded overrides. executeSuites inherits it; the immutable b540 source fixture still reads executing process.env, so its unconditional reasons=[] assertion fails. Production correctly refuses an unproved environment. Do not whitelist the prefix, weaken the guard, conditional-skip the baseline, or alter accepted caller/Python pins.

Own selection test, new graph_environment_support.mjs and matrix only, plus evidence planning files. Matrix appends one exact helper ownership row to node-runner-fast, no grouping/cap/tier changes. No generic helper glob owns this path today. Existing P10 reference_suite_support stays unchanged. All files≤500 physical lines with clear extraction.

## Isolated worker boundary

Extract fixed b540 Git reading/materialization and the strict baseline/caller/source mutations into the new helper. Preserve every existing proof assertion and old thirteen literal names in selection. Only four current analyzer modules overlay immutable b540 bytes; copied data/callers/Python/helpers remain frozen. Missing baseline remains an explicit failure. Read-only Git protocol keeps --no-replace-objects, scrubbedGIT variables, fixedcwd, bounded output, path/mode/OID validation.

The parent invokes process.execPath with the exact helper absolute path and a single finite worker token. Helper importing is inert; direct dispatch requires argv[1] resolve to its own file and exact argument shape/token. No eval/arbitrary script/target argument, no recursive node:test invocation and no name-filter-skipped child tests. Worker runs assertions directly, completes registered temporary cleanup in finally, emits one bounded closed JSON success result only after all assertions/cleanup succeed. Parent requires exit0, empty stderr, exact complete JSON, and no timeout/truncation. Retain bounded external worker timeout below the180second cell and1MiB output cap; malformed/extra/absent result fails.

Build a new child environment object from an explicit allowlist, never spread the entire inherited environment or mutate parent process.env across asynchronous tests. Retain only required absolute PATH/actualNode toolchain, bounded locale and OS temp settings; set HOME to an owned empty fixture directory. No inherited runner/Python overrides or npm configuration/lifecycle context enters the positive worker. Set explicit npm_config_userconfig and npm_config_globalconfig paths to owned empty regular files and use the immutable baseline directory without project.npmrc. The executing actual npm config query still verifies defaults; absence of overrides is controlled fixture setup, not a production exemption. Do not read or overwrite user npmrc or infer arbitrary shell/workspace config safe from hashes. Test readonly import without invoking worker behavior.

Parent liveGraph evaluation uses original inherited environment unchanged. Nonempty guarded overrides must produce the existing environment reason and unbounded result. Exact file equality alone is insufficient for live boundedness: require both original reviewed file identities and proved current execution context. A legitimately changed source/config/native/reference context can fail closed without failing the unconditional isolated baseline.

## Fourteen exact witnesses

Retain thirteen existing literal names and P10 assertions; add `P12 immutable graph proof isolates fixture environment while inherited overrides fail closed`. The new witness covers one actual inherited override: the fixed npm_config_prefix sibling defined by the closed protocol below. It asserts the exact existing override reason and unbounded empty-change closure. It also inspects the constructed positive environment to require absence of inherited uppercase/lowercase runner, NODE, PYTHON and npm configuration keys, and exact owned HOME/user/global config selectors. These are environment-construction assertions, not additional launched override/native startup cases. Do not claim executed uppercase/script-shell/NODE/PYTHON/hostile-npmrc permutations. Actual default npm querying remains exercised by the four positive workers against their owned empty configuration. The parent’s selected environment presence/value map remains byte-equal before and after success and failure; no parent mutation or untrusted startup option is used. Import-inertness and argument-shape validation use pure helper functions in this same witness; they do not add worker launches beyond the four positive groups and one prefix sibling.

Avoid broad fake env trust. Positive worker must always execute strict baseline, source mutations, inspection edges and native-six checks. Preserve source/data mutation negatives with intended reasons. Add malformed-worker-token and import-inertness checks without new arbitrary command interfaces. Exact existing registered selection command captures14 names,180seconds/1MiB, zero skips/fail/cancel/TODO. Development must also invoke the same command through actual npm lifecycle in an owned controlled test fixture, while keeping outer13/14 exact receipt semantics and no full affected rerun for diagnosis.

## Ordering and input holders

P10.I/V own matrix+selection; P03.R and retired/original/retry2 P03 roles also own or read-bind their historical matrix/selection. Preserve exact historical lineage; P12 directP10.V/P03.retry2.V dependencies authorize current successors, not overwrites of receipts. P11 reads matrix and source tooling, and P12 reads P11 process source through its static import closure. Sequential P11 acceptance then P12 freeze eliminates cross-base drift; explicitP11.V retains its currentness ancestry. Do not freeze P12 manifests while P11 source is pending.

At invocation recompute all catalog owned and input-only overlaps against actual immutable manifest revisions, record them, reject unknown active owned overlaps and report unexpected input-only holders for independent review. Resolve actual clean base/latest DAG and require all direct prerequisites passed/ancestral. Recursive closure includes selection imports, existing reference-suite helper, new helper future ownership, fouranalyzers/matrix/execute/process/Git primitives, package/lock/config and normativeconsumer table. No fixed futureSHA or all-productsource permanentinput.

Generate review-only documents→manifests→transition→activation bundles using P10/P11 pattern, coordinator separately applies and normalcommits. No phase execution is authorized by this external draft. No production process/environment APIs are changed.

## Closed worker protocol for freeze

Invoke exactly `[absoluteHelperPath, --p12-worker, TOKEN]`. Dispatch only when argv[1] resolves to this helper and those two following arguments are present. Import is inert; missing/unknown/extra arguments fail before work. No caller-supplied code, path, environment JSON or arbitrary command.

- `runtime-dependencies` executes every preserved assertion belonging to `P03 graph follows runtime type support and literal child-process dependencies`.
- `unresolved-inputs` executes every preserved assertion belonging to `P03 graph rejects unresolved relevant imports and missing owned targets`.
- `immutable-consumers` executes every preserved assertion belonging to `P03 graph re-evaluates newly added consumers from the immutable subject`.
- `source-emitted-identities` executes every preserved assertion belonging to `P03 graph binds source and emitted module identities without duplicate consumers`.

Each original literal callback invokes its own token and validates its own assertionGroup; no generic common result can satisfy another name. The immutable-consumers group retains the strict six-rule positive, caller/source/native/inspection-edge mutation checks; every other group retains its original positive/negative obligations.

Positive success is exactly `{schemaVersion:1,token:TOKEN,status:"passed",assertionGroup:EXACT_ORIGINAL_NAME,cleanupComplete:true}`. Emit exactly one newline-terminated JSON object after all group assertions and cleanup complete. Parent requires exact keys/values, exit0, empty stderr and no extra records or trailing text. Assertion, cleanup, malformed output, timeout or overflow fails.

A fifth token `inherited-context` sets only a fixed npm_config_prefix=/p12-unproved-prefix on the safe child fixture context. It actually evaluates production discovery and requires the existing reason plus unbounded empty-change selection. Its success object has exactly the five common keys plus bounded:false and reason:"Unproved runner environment override", with assertionGroup:"P12 inherited override refusal". It cannot satisfy any P03 positive group. Untouched parent live discovery remains separate.

Every invocation has timeout20000ms and maxOutputBytes65536; four positive groups plus one inherited-context invocation maximum, serial with no retries, inside the existing180000ms/1048576byte cell. The new environment regression verifies fixed worker protocol/import inertness and environment separation without duplicating all four workers. Any need for additional repeated workers or larger bounds requires review before freeze.
