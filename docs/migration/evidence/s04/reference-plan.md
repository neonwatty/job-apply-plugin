# S04 reference preparation at the registered checkpoint

Draft for independent review; no reference acceptance is claimed.

Actual registration checkpoint: 2da2e1f52709c967915318a661b09339d2d3e49a. The effective 346-assignment DAG is
`docs/migration/evidence/p03/retry2/approved-dag.json`. All five reference commands
are registered. The original 32 source pins and complete 17-module Python union
were verified against this checkpoint. Historical draft SHA placeholders below
are superseded only by this concrete checkpoint and the eventual immutable
manifest base; original behavior and required observations remain unchanged.

Assigned implementation author and file owner: `timestamp_tests`. Independent
reviewer: `hooks_audit`. The coordinator alone writes preparation metadata.
Reference assignments retain their original `P00.V` dependency. They do not
accept product implementation or satisfy native launch gates.

All exact test names, budgets, allowed files and baseline obligations from the
reviewed v2 audit are retained. Freeze the plan and audit before the reference
manifest. Bind original source files, test support, package/lock/matrix and
runtime provenance. New reference helpers may load only that closed source set;
new imports require review before the exact source capture. All source/test
files remain at most 500 physical lines.

Expected-vector drafts are hand-derived review inputs, not automatically
refreshed golden output. Retain disagreements with actual CPython observations
until independently reconciled. Strip executable probe text from committed
vector data; preserve its exact source and provenance separately. Compare
complete errors and effect order, never only a category wildcard. Evidence
records actual host/interpreter details and keeps unsupported/native gaps open.

Bounded actual original-method probes confirmed all10atomic/8JSONL predictions on default/3.12/3.13/3.14, including separate LF, buffering and close/error context. These diagnostics support expected data review; full registered capture and baseline validation remain outstanding.

# S04.R bounded reference plan v2

Status: external freeze-review plan. Independently authored vector data and bounded original-Python probes are complete as described below; full registered reference source/tests and accepted capture remain outstanding. Required ordering is S04.R after P00.V; S04.I additionally requires S08.V and accepted S04.R. S05 remains a disjoint package.

## Purpose and exact scope

Observe actual CPython point-text chunking, strict UTF8 failures and the existing Python atomic/JSONL methods on exclusively owned synthetic files. Establish the missing literal-surrogate-pair behavior before its TypeScript port. Keep the old atomic34-case and JSONL43-case references unchanged as regression inputs. Do not instantiate the public Store, touch user data, select caller paths, change runtime code, claim raw-byte filename support or infer Linux/Windows/native fault coverage from this macOS run.

The reference passes original Python objects built from explicit codepoint arrays directly to json and the existing Python methods. It does not use the new TS parser, stringify points through JavaScript text, patch json.JSONEncoder or infer atomic behavior from a standalone encoding model. New tests compare independent fixed expected values/chunks/error positions and ordered effects; capture output is evidence, never its own expected result.

## Owned files and size limits

| Proposed exact path | Responsibility; physical-line target |
| --- | --- |
| tools/contracts/point-persistence/reference.py | Fixed entry, profile/provenance, standalone chunk observations and actual atomic/append dispatch; <=350. |
| tools/contracts/point-persistence/fixtures.py | Closed36 fixture IDs and explicit object/graph constructors; no caller-controlled cases; <=250. |
| tools/contracts/point-persistence/support.py | Owned-file operation observation, exact exception graph and non-invasive snapshots; <=450. |
| tests_js/point_persistence_reference.test.mjs | Five direct literal tests, fixed expectations, schema/identity/provenance/effect assertions; <=480. |
| tests_js/point_persistence_baselines.test.mjs | Two direct literal wrappers over unchanged old reference test commands, strict child-TAP validation and retention; <=180. |
| docs/migration/evidence/s04/reference-vectors.json | Independently authored expected data, fixed cases/points/graph recipes/chunk/error/effect expectations; never executable code or generated goldens. |
| docs/migration/evidence/s04/reference.md | Final scope, actual results, source/profile provenance and limitations. |
| docs/migration/evidence/s04/reference-plan.md; reference-audit.json; S04.R.json | Coordinator-owned prefreeze plan, exact audit and manifest. |

Only three reference Python modules are new; no production module is edited. All source/test files remain<=500, no minification/packing or size exceptions. Helpers stay inside the existing contracts-directory convention; both executable test paths are explicitly literal-registered at2da2e1f52709c967915318a661b09339d2d3e49a. No worker matrix edit, broad ownership extension or unregistered JS support module. JSON vectors are read as closed data, never used to select code/executable paths.

## Closed36-case matrix

Every case runs on each required actual CPython3.12/3.13/3.14 profile; the default alias is observed too and may repeat a profile. Captured patch versions are explicit, not silently generalized. IDs below and all points/limits/graph recipes are bound independently in tests and fixtures. Empty shared containers, typed numbers and key insertion order must be represented explicitly. Except the two numeric-limit cases, use a640-digit limit and small payloads; restore the interpreter-wide limit in finally.

| Group | Exact IDs and construction |
| --- | --- |
| Standalone chunks: text (6) | chunk-scalar: U+10000; chunk-pair: D800 DC00; chunk-high: D800; chunk-low: DC00; chunk-surrogate-run: D800 DC00 DC80; chunk-controls: NUL/LF/tab/quote/backslash/DEL. All are root strings, so surrounding JSON quote points are part of the error object. |
| Standalone chunks: structured (6) | chunk-pair-value: {a:pair}; chunk-pair-key: {pair:1}; chunk-key-order: insertion [scalar:2,pair:1,empty:0]; chunk-empty-nested: [{},[],{a:[]}]; chunk-shared: [sameChild,sameChild] with child=[scalar]; chunk-cycle: array referencing itself. |
| Standalone chunks: order/limits (6) | chunk-invalid-key: dictionary with string and integer keys; chunk-bad-before-cycle: array [pair,selfCyclicArray]; chunk-bad-before-integer: array [pair,641-digit integer]; chunk-integer640: root640-digit integer; chunk-integer641: root641-digit integer; chunk-unlimited641: same integer with limit0. |
| Atomic effects (10) | atomic-scalar: {a:scalar}; atomic-pair: {a:pair}; atomic-pair-key: {pair:1}; atomic-prefix-pair: {a:validASCII,z:pair}; atomic-pair-before-cycle: [pair,selfCyclicArray]; atomic-pair-before-integer: [pair,641-digit integer]; atomic-pair-close: {a:pair}, post-real-close injected EIO; atomic-pair-cleanup: same, pre-unlink injected EIO; atomic-pair-close-cleanup: both; atomic-installed-mode-error: scalar payload with failure at destination chmod after successful replace. |
| JSONL effects (8) | jsonl-scalar: {a:scalar}; jsonl-pair: {a:pair}; jsonl-pair-key: {pair:1}; jsonl-pair-before-cycle: [pair,selfCyclicArray]; jsonl-pair-before-integer: [pair,641-digit integer]; jsonl-gate-hit-pair: gate returns true; jsonl-gate-error-pair: gate raises injected EIO; jsonl-controls: {a:controlText} with fixed NUL/LF/tab/quote/backslash/DEL. |

Total18 chunk +10 atomic +8 JSONL =36. Do not expand this into a fault Cartesian product. The unchanged baseline43 JSONL cases (29append+14repair) retain rollback, short-write, descriptor-close and tail-repair coverage; baseline34 atomic cases retain mode/replace/directory-fsync and cleanup ordering. If a new observation exposes another necessary branch, report the gap for a reviewed contract amendment rather than silently extending IDs.

## Exact observation protocol

Standalone chunk cases have two separately constructed equivalent graphs. First exhaust json.JSONEncoder(indent=2,sort_keys=True,ensure_ascii=False).iterencode without UTF8 encoding and record every yielded chunk's points plus terminal serializer outcome. Then iterate a fresh encoder and encode each yielded chunk with strict UTF8, stopping on the first failure; record yielded points, successful encoded hex and exact failed chunk. These two traces distinguish a later cycle/integer error from an earlier Unicode failure. No flattening or encoding before yield. Serializer errors retain the already-yielded prefix and active-graph behavior.

Known independent anchors: a quoted literal pair has points[34,55296,56320,34] and strict UTF8 fails at start1/end3; quoted scalar has[34,65536,34] and bytes22f090808022. The three-point surrogate run fails at start1/end4. An indented array's scalar child is combined with its prefix in one chunk, so the expected error offset must count the actual prefix points [91,10,32,32] rather than copying the root-string offset. For dictionaries, assert the exact distinct3.12 versus3.13/3.14 first-indent/key-sort timing. Fixed tests must explicitly assert the full chunk arrays and error fields, not merely count chunks or accept whichever first failure was observed.

Atomic cases call scripts/job_apply_store/io.py:atomic_write_json with an observed native temporary file and the existing runtime injection. Its actual temporary.write receives the original chunk; observe each call before delegation and each result/error after delegation. Never replace TextIOWrapper encoding with a surrogate model. Observe visible bytes without flush/seek or changing the writer offset; use a read-only observation descriptor or pread only on the owned regular file. Record bytes after real close and before unlink, so earlier buffered prefix bytes remain observable even when cleanup removes the temp. Observational IO is labeled separately from production call events and cannot create extra production flush/fsync events. Distinguish Unicode failure, injected post-close failure, and cleanup failure with full context/cause chains.

Each atomic fixture owns an ASCII-named temporary root/private/document.json and an unrelated sentinel, initially fixed bytes/modes/mtime. Preserve the original target on pre-replace failure. Post-replace chmod failure must report an error while retaining installed new bytes. Normalize only the owned root and nondeterministic temporary basename into fixed labels. Retain actual path kinds, modes, bytes/hashes and mtimes, with explicit changed/unchanged relationships where the clock value itself is not deterministic. Do not alter atime to simplify snapshots. Final fixture cleanup runs separately after the captured method-return state and cannot be mistaken for method cleanup success.

JSONL cases call the existing CoordinatorPersistenceMixin method with a SimpleNamespace and test-owned gate, as the old reference does; no public Store is instantiated. Gate must receive the identical fixture event object. Trace gate before serialization and all production opens/writes/stats/fsync/close/chmod. Actual json.dumps(...,sort_keys=True,ensure_ascii=False) plus LF is encoded once before open. On pair-before-cycle/integer fixtures, actual serialization may fail before encoding; on a plain pair it reaches UnicodeEncodeError with the complete line as its object. A gate hit never serializes/opens. A gate error retains the injected error and unchanged bytes. These outcomes are asserted independently, not inferred from the atomic trace.

## Closed output and independent expectations

Output is one finite JSON object with schemaVersion, scope, profile, sourceProvenance, nativeProvenance and ordered cases. Each row binds id, operation, exact graph recipe/input point arrays, intMaxStrDigits, injected stages, observations and before/after owned-tree state where applicable. Results use typed point arrays/ordered entries, integer decimal and float.hex; never convert pair/scalar identities into ordinary JSON strings for comparison. Exception records contain name/message/errno, explicit cause, implicit context and suppression; Unicode errors add encoding, complete object points, start/end and reason. Preserve reused exception identities/back-references if encountered, rather than recursing indefinitely or flattening context into cause.

Tests bind the closed36 ID/input/limit/fault tuples and independently authored expected output/effect tables in reference-vectors.json. Exact timestamps or temporary randomness are checked through documented within-capture relationships; every deterministic byte/chunk/key/position/message/call-order field is exact. No auto-regeneration, wildcard outcomes, selecting an expected error after observing it, or replacing native setup errors with a capability skip. Initial reference development may reveal mistaken hypotheses: preserve the observation, explain the discrepancy and independently review corrected expectations before the accepted capture.

The capture script accepts no arguments or stdin. Argument/nonempty-input probes must exit2, emit no stdout and exactly ASCII point_persistence_reference_input_rejected followed by exactly one LF byte (hex0a). Non-POSIX hosts fail explicitly as unsupported for this native-effects reference; do not pretend a model run closes those cells. Each test child gets bounded time/output and isolated interpreter flags; no supplied path, remote service, browser, network or live Store. Retain complete successful raw JSON as TAP diagnostics and verify a SHA256 of its exact stdout; failure output is retained before assertions too. Target each profile capture<=150000bytes and<=20seconds, keeping four observations comfortably within1MiB/120seconds. An overrun is a failure requiring reviewed split, not truncation or a larger silent budget.

## Literal tests and baseline reuse

point_persistence_reference.test.mjs has exactly these five direct top-level names:

- S04 reference observes point chunks and persistence effects under default CPython
- S04 reference observes point chunks and persistence effects under CPython 3.12
- S04 reference observes point chunks and persistence effects under CPython 3.13
- S04 reference observes point chunks and persistence effects under CPython 3.14
- S04 reference rejects caller arguments paths and stdin

point_persistence_baselines.test.mjs has exactly two names:

- S04 reference preserves all unchanged atomic baseline witnesses
- S04 reference preserves all unchanged JSONL baseline witnesses

Each baseline wrapper runs its exact unchanged node --test command once, retains complete child TAP and hash, uses the existing strict parseTaskTap and requires every original expanded literal name/count with zero failures/skips/cancellations/TODOs. Atomic expected names are 'atomic JSON reference: python3', python3.12/.13/.14 variants, plus 'atomic JSON reference rejects caller paths, arguments and stdin'. JSONL expected names are 'JSONL append and pending tail reference: python3', python3.12/.13/.14 variants, plus 'JSONL reference rejects caller arguments and input'. Thus the new outer total is7; ten unchanged child tests cover all required actual profiles. Do not claim seven outer tests are the complete underlying case count. This reuses independent old assertions without editing them or importing their test registration into the parent process.

## Immutable inputs pinned during this scout

| Repository path | SHA256 |
| --- | --- |
| tools/contracts/atomic-write-json/reference.py | 283e45f35c5485a645fa71844958749e541108be5b55cad6a76fcc8687182381 |
| tools/contracts/atomic-write-json/support.py | a95c02ec86844aa931d20c26238d56436cdb576e0902ca7307f1b5d560fdfa39 |
| tests_js/atomic_write_json_reference.test.mjs | f022146fca2bf619338cd6113b788c728fc387bcba09f94022f954432a6d9d57 |
| tools/contracts/jsonl-append/reference.py | 6a877e92fb9c0ecbbcc19a76e4f15b4dd1f4112304c2c7b7aed2958647783d13 |
| tools/contracts/jsonl-append/support.py | cb6c28460033dea72c93807a457b6abefc2f98f0903519805d1fcf348224c0ea |
| tests_js/jsonl_append_reference.test.mjs | 2f4ee1c18f2c4cdb3b59a2a6403cb113d4f7890b72fff57e1bc7655c49b0d66f |
| scripts/job_apply_store/io.py | 6e4b36c224fdf34924f14fecbd6d8afaf398afcff455509b85a817008c407d53 |
| scripts/job_apply_store/domains/coordinator/persistence.py | 1296863bad9412b852879a3b9c653a98ca61375811df2690600e6f69bc7c3177 |
| scripts/job_apply_store/errors.py | be48cff00389f30d0f51f95ec154baec6162a57350b2ab3cfcb531da7456e01c |
| tests_js/persisted_json_ts.test.mjs (read-only comparison context) | 785b39a1c0348dcdfc53df5a3e968f86e18d789171e8b63568a0d3003ce3d9da |
| tests_js/jsonl_json_ts.test.mjs (read-only comparison context) | e607311957d866de4ff38b78a1fda86c39bb9f8b9a0bccf0a77d9eb045afb2f9 |

Before freeze, bind the current actual import closure, not just these entry files: scripts/job_apply_store package __init__, loaded domain/validation/helpers, new reference helpers, old drivers/support, strict TAP parser and its imports, package/lock/configuration and actual registered matrix checkpoint. Existing Python helpers are read-only. Runtime provenance independently resolves executable/version/implementation/platform/architecture/byteorder/encoding policy, hashes the executable, json/decoder/encoder/scanner, tempfile and pathlib implementation modules (including split packages), and native _json/_io/_codecs origins. Builtins are tied to executable hash. Assert actual provenance against independently probed module origins; a capture cannot attest to itself merely by repeating its own path fields.

## Parallel execution and done boundary

Tooling/P08 may edit its own tools while S04 prepares reference sources in a separate common-checkpoint worktree. Matrix/strict-TAP dependencies require actual immutable registered inputs before S04 freeze; no draft command registration assumption. Native owned-file capture remains serialized with any host-heavy worker by coordinator agreement. S05 reference ownership does not overlap these paths; S04 does not encode filesystem names containing raw surrogates or claim their native support.

R done means exact reviewed manifest/input hashes, closed36 new cases plus unchanged34atomic/43JSONL baseline coverage across actual required profiles, retained full raw observations/child TAP, exact expected-field assertions, successful size and normal hooks, and independent acceptance review of the committed subject/capture. An empty/unavailable interpreter, skipped native cell, missing error field, altered reference hash or unreviewed expectation change leaves R open. It does not authorize S04 implementation, native raw-filename acceptance, physical durability, live Store concurrency or S03 activation.

## V2 exact recipe decisions (same36 IDs)

These definitions remove placeholder ambiguity without adding cases. scalar points=[65536]; pair=[55296,56320]; high=[55296]; low=[56320]; surrogateRun=[55296,56320,56448]; controlText=[0,10,9,34,92,127]. String-key a/z are their ASCII points. All unspecified singleton object values use integer1. The640-digit integer is decimal '1' repeated640 times; the641-digit integer is decimal '1' repeated641 times, both positive. intMaxStrDigits=640 except chunk-unlimited641=0, always restored in finally. validASCII is the exact text 'ok'.

chunk-invalid-key is the insertion-ordered dictionary [('a',1),(1,2)]. Both key types are individually encodable; its failure is mixed-type sorting, not an unsupported key type. chunk-key-order insertion is [(scalar,2),(pair,1),('',0)]. selfCyclicArray is one list whose sole element is itself. The enclosing pair-before-cycle list is distinct from this cyclic list. chunk-shared is a fresh outer list containing the same single-element [scalar] child twice. Every operation uses a fresh equivalent graph; no sharing between cases.

All atomic dictionaries use insertion a before z where both exist. All targets start with exact bytes7b7d0a ({} plus LF), mode0600, parent0700; unrelated sentinel exact bytes 'sentinel' mode0600. Initial mtimes are captured as complete ns values and bound by equality relationships, not invented wall-clock literals. Synthetic EIO faults use OSError(5,'synthetic '+stage), where stage is exactly 'close', 'unlink' or 'target-chmod'; close fault occurs after real close, unlink fault before delegation, target-chmod fault after replace. JSONL gate fault uses OSError(5,'synthetic gate'). These messages are test controls, not claims about OS-generated wording.

Independent anchors: root pair chunk[34,55296,56320,34] fails UTF8 at1/end3; root scalar bytes22f090808022. First array pair chunk[91,10,32,32,34,55296,56320,34] fails at5/end7. Dict pair key sorting and error order remain actual-profile assertions. Complete deterministic chunk arrays, profile-specific errors and method effects are in the exact data-only vector file below; independent final vector/capture review remains required. Keep text writer buffering real.

## V2 refusal byte contract and current input closure

Refusal stderr is Buffer.concat([Buffer.from('point_persistence_reference_input_rejected','ascii'),Buffer.from([10])]); this specifies bytes, not runnable fixture data. Exactly one final LF, no CR and no literal backslash-n. Expected stdout is empty and status is2 for each existing argv/nonempty-stdin probe. No new probe identity or command is introduced.

Static source pins below were rechecked unchanged at2da2e1f52709c967915318a661b09339d2d3e49a. They are input provenance, not runtime evidence. Package initialization imports base/io/normalization and five validators even when the reference imports one leaf. Include the common13 rows plus the relevant domain initializer/leaf; S04 requires coordinator persistence, S05 requires resume storage. Resolve any additional actual new-helper imports at freeze.

| Path | SHA256 |
| --- | --- |
| scripts/job_apply_store/__init__.py | d1f3908a9875fdeda94a2d1823b0e42edb29c7814a638b8edcdc15e127052a04 |
| scripts/job_apply_store/base.py | e1deee9f49d012eac54f3ef4990c7641d43874afa699c8d12d79919599f27c88 |
| scripts/job_apply_store/constants.py | 4438a36055842e18af0ae806fed1f61bf8280908995f7295662a4213226e8b5c |
| scripts/job_apply_store/errors.py | be48cff00389f30d0f51f95ec154baec6162a57350b2ab3cfcb531da7456e01c |
| scripts/job_apply_store/io.py | 6e4b36c224fdf34924f14fecbd6d8afaf398afcff455509b85a817008c407d53 |
| scripts/job_apply_store/normalization.py | 8c299675838779908a1d3876db22fc2d9b32a2e08a890246357193b1d20b2beb |
| scripts/job_apply_store/domains/__init__.py | b112b206edd338aa0dd2a17d1414be2c843d6d44337249d59079a82129cd0c26 |
| scripts/job_apply_store/validation/__init__.py | b8e8d8f492cf48c33321d01db8899357f333cf94b93e5f20835cce62104524e3 |
| scripts/job_apply_store/validation/accounts.py | aa62b41eabe54f13c3b3fbb9791dedafc98dbac9d4e68262452e69bfb2457ddc |
| scripts/job_apply_store/validation/extraction.py | 6437704da0aefe5b3351c129a5b3e36e49da4db9a8d56c60ba19d28825b5d7d8 |
| scripts/job_apply_store/validation/jobs_resumes.py | 1ad4bffefc7cc6a605d2fa04b0d2e1ccb5804091064083787f4126c157274c83 |
| scripts/job_apply_store/validation/profile_answers.py | 599715a998b68fb0ac1ab67c0930564fda9fb69206084c12dafccfb83c9e65d9 |
| scripts/job_apply_store/validation/sessions.py | 9d1c6158facc0724e5500defbc8027931e2112927677d9f3b79d5a8fde5339ce |
| scripts/job_apply_store/domains/resumes/__init__.py | 9ff7cd33ef9e3c17454ac38ab147f3eaec75e44816a6ea8fa0a5d3fa381dfba0 |
| scripts/job_apply_store/domains/resumes/storage.py | 97ec178e0b3ddc1d3be97b1c6c34983ecf9c50caa9c6f4fd4125dbb71c6db6fe |
| scripts/job_apply_store/domains/coordinator/__init__.py | 8515203ac4bc80d5d722deffa1879e08518b2a200a7bdbab5425c8dee43ee1be |
| scripts/job_apply_store/domains/coordinator/persistence.py | 1296863bad9412b852879a3b9c653a98ca61375811df2690600e6f69bc7c3177 |


S04 baseline wrappers also bind tools/migration/tap-evidence.mjs and its transitive imports, unchanged baseline drivers/support/test assertions and actual Node/package/matrix inputs. S05 direct drivers bind unchanged four reference drivers plus managed-observation/native.py and four original independent assertion sources. Neither requires editing those inputs. Keep all original owned paths, cells, test identities, time/output budgets and baseline obligations. Audit JSON v2 is structurally unchanged; this plan supplies precise fixture/input obligations without introducing unrecognized audit fields.

All five literal registrations are committed at2da. Recheck active ownership, exact pins and DAG/receipt bindings at the fresh manifest base; retain these reviewed data hashes. Full reference execution and independent acceptance remain required.

## Exact reviewed data and diagnostic provenance

Normative data candidate: S04-reference-final-vectors.json; SHA256 5f780fccad0679310cd70f08a7b39493cb86879d4c65a3ffc262637b44bbe04a. Prepare it at docs/migration/evidence/s04/reference-vectors.json before the fresh manifest base. It contains no executable probe text.

- S04-persistence-probe.py: SHA256 2d7efcd0b2efc5a9b6f2fb3ee79263bddbc00eb4ee5c3d8e136c0845f672b9ec
- S04-persistence-observations.json: SHA256 86ff3701516600b1a59ea64a6c2aba1ae2ab41cbf406e51d9c85b4b0417ce561
- S04-persistence-provenance.json: SHA256 0ed3e3a5220534ad6530045af326c8cd73715c221f29da0a0aadfe4e5bb42a7b

These external provenance files preserve bounded diagnostic raw stdout and hashes; they do not replace the full registered test cells or accept the reference. Source revision for the probes is2da. No future commit SHA is implied.
