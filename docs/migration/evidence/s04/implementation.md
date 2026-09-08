# S04.I/V freeze proposal

This external specification refreshes accepted S04 reference evidence at staging `30c61f4c2524e2d99be62029313ee1ea1e4748df`. It does not authorize source edits or claim review approval. Its companion JSON is the exact path/hash, API, case, requirement and cell manifest proposal.

## Scope and direction

Eight production modules and their eight one-to-one emissions only. The worker owns five existing facades/mechanisms and three new modules. Shared `persisted-json-core.ts` owns generic traversal and options; shared `persistence-exception.ts` owns context policy/facts. Only `src/store/point-persistence.ts` selects trusted PythonText/PythonObject adapters. Existing facades may call generic mechanisms but must never import or re-export the point leaf, even type-only. Core must not import a facade or point leaf. Shared types live in core/exception; legacy options may re-export a compatibility alias.

No touched existing file is oversized. Every resulting source, test, support and runtime file remains at most500physical lines, without packing. The two named extraction targets are explicitly owned. Current private-filesystem buffering and writer state machines are parameterized, not copied into a parallel engine. Coordinator alone emits runtime and refreshes exact catalog06/newcatalog records. Review-lock and task metadata use normal coordinator validation, not worker ownership exemptions.

## Exact proposed allowed files

- `src/contracts/persisted-json.ts`
- `src/contracts/jsonl-json.ts`
- `src/store/private-filesystem.ts`
- `src/store/atomic-write-json.ts`
- `src/store/jsonl-history.ts`
- `src/contracts/persisted-json-core.ts`
- `src/contracts/persistence-exception.ts`
- `src/store/point-persistence.ts`
- `runtime/contracts/persisted-json.js`
- `runtime/contracts/jsonl-json.js`
- `runtime/store/private-filesystem.js`
- `runtime/store/atomic-write-json.js`
- `runtime/store/jsonl-history.js`
- `runtime/contracts/persisted-json-core.js`
- `runtime/contracts/persistence-exception.js`
- `runtime/store/point-persistence.js`
- `tests_js/persisted_json_ts.test.mjs`
- `tests_js/jsonl_json_ts.test.mjs`
- `tests_js/atomic_write_json_ts_support.mjs`
- `tests_js/jsonl_history_support.mjs`
- `docs/migration/python-point-persistence-port.md`
- `docs/migration/evidence/s04/implementation.md`
- `docs/migration/evidence/s04/implementation-audit.json`
- `docs/migration/evidence/s04/S04.I.json`
- `docs/migration/evidence/s04/S04.V.json`
- `config/migration/source-catalog-06.json`
- `config/migration/source-catalog-s04.json`

Raw capture paths are separately declared by the two cells, not arbitrary worker outputs. Frozen R vectors, original Python, matrix and accepted primitives are read-only. The JSON includes all immutable input hashes and detected prior ownership intersections. Actual freeze must check the live catalog again, with particular attention to accepted S08 ownership of the two serializer tests.

## Entry and exception contracts

- `iterPersistedPointJson(value: PythonPointJson, options: PersistedJsonOptions): Generator<PythonText>`
- `encodePersistedPointUtf8(text: PythonText): Buffer`
- `encodePointJsonlJson(value: PythonPointJson, options: PersistedJsonOptions): Buffer`
- `atomicWritePointJson(path: string, payload: PythonPointJson, options: PersistedJsonOptions, io?: PointAtomicWriteIO): Promise<void>`
- `appendPointHistoryEvent(path: string, event: PythonPointJson, options: PointAppendHistoryOptions): Promise<void>`
- `createNativePointAtomicWriteIO(profile: PythonPathProfile): PointAtomicWriteIO`
- `pointExceptionFacts(error: Error): PointExceptionFacts`
- `describePointException(error: Error, descriptor: ExceptionDescriptor): void`

PointAppendHistoryOptions has exact callback `isIdempotent(event: PythonPointJson): Promise<boolean>`, required serialization options `{pathProfile,intMaxStrDigits}`, and optional existing JsonlHistoryIO. Default IO is native for the explicit profile. The callback receives the original event identity. Generic TemporaryFileFor<T>/AtomicWriteIOFor<T> keep existing method shapes with only text parameter generalized. Legacy aliases/signatures/behavior stay unchanged.

The JSON embeds the proposed shared and point type declarations. Strict point UTF8 reads accepted captured point contents, never virtual getters. A newly created accepted UnicodeEncodeError retains its class and original caller object identity (`error.object === input`), with exact span/message from canonical contents. Only that newly owned error field may be assigned; supplied/reused errors never get rewritten. Atomic failure object is the actual failed chunk; JSONL object is the assembled complete LF-terminated line.

Implicit point context lives separately from Error.cause; facts preserve actual Error/text identities, full Unicode details, explicit cause and suppression. Context is attached only by actual failure handling; A/B/A reuse breaks a context back-edge without altering explicit causes. Descriptors are closed `{cause?,suppressContext?}`: provided cause including null defaults suppression true; absent cause preserves existing Error.cause (missing/undefined maps null), with suppression true only for non-null cause unless overridden. Non-Error cause values remain opaque; non-Error thrown values propagate, while facts require Error. Facts are fresh immutable records without freezing caller errors.

The point linker reaches temporary stat/close/unlink, buffered flush/close, outer atomic cleanup, JSONL rollback/close and directory sync/close. `fsyncDirectory` defaults to legacy linking and accepts explicit point policy. Swallowed OS sync errors stay swallowed and do not invent context. Regression includes installed bytes plus directory sync failure, subsequent close failure with explicit cause, exact identity/context/suppression, and legacy comparison.

## Exact coverage and domain

All36 frozen Python reference cases remain input-bound.35 are representable by PythonPointJson:17chunk,10atomic,8JSONL. `chunk-invalid-key` directly constructs mixed numeric/text Python dict keys and stays outside the text-key PythonObject domain. Separately test the legacy invalid Map prefix and unchanged TypeError, plus point rejection of foreign Map. Do not label either as36/36point parity. No public parser/value alias widening or S05 path widening occurs.

Atomic tests use real owned native IO with injected faults at frozen method boundaries, recording accepted writes, separate LF, post-close bytes, temp cleanup, installed bytes and mode/inode/ctime relationships. Verify private parent kind/inode/mode and unrelated sentinel mode0600/bytes/metadata. JSONL tests observe gate identity, no open before gate/serialization/encoding success, complete line encoding, real write suffixes and exact cleanup order. Expected values come solely from immutable R vector recipes/rows; no TS output regeneration. Whole graph constructors preserve cycles/sharing without JS-string round trips.

## Literal cells and requirements

### s04.implementation.persisted

`node --test tests_js/persisted_json_ts.test.mjs` —120seconds,1MiB,8literal names.

- persisted JSON chunks and strict UTF8 match Python: python3 → s04.i.legacy
- persisted JSON chunks and strict UTF8 match Python: python3.12 → s04.i.legacy
- persisted JSON chunks and strict UTF8 match Python: python3.13 → s04.i.legacy
- persisted JSON chunks and strict UTF8 match Python: python3.14 → s04.i.legacy
- S04 point persisted chunks preserve explicit codepoints and profile order → s04.i.chunks
- S04 point atomic writes preserve native chunk failures and cleanup context → s04.i.atomic
- S04 point persistence preserves explicit causes and reused exception identity → s04.i.exceptions
- S04 point persistence rejects forged inputs and preserves legacy mixed-key boundaries → s04.i.boundaries, s04.i.legacy

### s04.implementation.jsonl

`node --test tests_js/jsonl_json_ts.test.mjs` —120seconds,1MiB,8literal names.

- JSONL bytes match actual Python default spacing and strict UTF8: python3 → s04.i.legacy
- JSONL bytes match actual Python default spacing and strict UTF8: python3.12 → s04.i.legacy
- JSONL bytes match actual Python default spacing and strict UTF8: python3.13 → s04.i.legacy
- JSONL bytes match actual Python default spacing and strict UTF8: python3.14 → s04.i.legacy
- S04 point JSONL preserves complete serialization before strict encoding → s04.i.jsonl
- S04 point JSONL native append preserves gate identity and unopened failures → s04.i.jsonl
- S04 point JSONL preserves explicit causes through rollback and close → s04.i.rollback, s04.i.exceptions
- S04 point persistence entrypoints leave legacy values and public parser behavior unchanged → s04.i.legacy, s04.i.boundaries


All original eight callback bodies/corpora/skip behavior remain intact, but accepted capture requires aliases present and zero skips. New profiles/cases loop inside literal callbacks, without nested registration. New assertions also cover hostile branded text/object subclasses, forged prototypes, exact caller Unicode object identity, descriptor misuse, suppression defaults, cycle context, integer limits, scalar/literal-pair key ordering and unchanged public legacy Map/parser behavior.

The accepted R point cell took426.435833ms/565794bytes; baseline cell821.480875ms/3466bytes. Each proposed cell retains four10s-bounded Python children plus fixed native cases.120seconds matches the accepted reference ceiling while leaving bounded room beyond their40s child maxima; it is not an observed implementation timing claim. Output cap remains1MiB. Preserve full failed observations; do not drop cases, truncate evidence or raise budgets when a run fails.

## Prerequisites and completion

S04.I depends on S08.V and S04.R. S04.V depends on S04.I, P01.V and P05.V. V remains open pending P05.V host/native evidence; local I implementation and bounded checks may proceed independently. This is a prerequisite refinement for a never-frozen V contract, not a waiver. Author timestamp_tests; independent reviewer hooks_audit. Both roles share the proposed implementation audit; manifests and activation are created only after final independent review, from a real fresh base with exact dependency receipt hashes.

Before V acceptance require both exact flat cells (16tests, zero fail/skip/cancel/todo), typecheck, deterministic build check, size, original native atomic/history regressions and the ordinary affected workflow. Preserve complete nested regression TAP as separate evidence; never squeeze those generated/nested results into16flat names. Existing S08/PythonText checks stay required affected consumers. Tests run only against disposable owned files, never a live Store. Linux/Windows and existing rawfilename/durability gaps remain unaccepted.

This is ready for review, not approved freeze metadata. The implementation must still demonstrate every proposed witness under the fixed budgets. Any scope, new import, ownership, or unavailable-platform obstacle is resolved before activation/capture rather than silently removed.

## Recovery review corrections

The shared object adapter returns sorted key records with lazy readValue callbacks. Sorting must not snapshot legacy Map values: lookup remains after key and separator yields, preserving changes between iterator steps. Add this regression within the existing legacy-boundary callback. Point adapters may retain captured value snapshots where the frozen Python reference requires them. All prior callbacks and immutable reference expectations remain unchanged.

The array adapter retains the original array and indexed traversal, including a second element read after a non-scalar prefix yield. Boundary regressions cover replacement and later append/remove during iteration. Point object entries retain the values captured by trusted entries() at sort time.
