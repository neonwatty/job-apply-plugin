# Shared point JSON engines

S08 adds an inert parser and compact ASCII serializer for Python codepoint text.
The existing `PythonJson` alias and Store consumers still receive ordinary
JavaScript strings, numeric atoms and `Map` objects. This package prepares the
shared engine for later consumer migration; it does not activate rich values in
persisted documents, HTTP handling or live Store writes.

## Entry points

`src/contracts/raw-json/point-value.ts` defines `PythonPointJson` using the accepted
`PythonText`, `PythonObject`, `NumericAtom`, arrays, booleans and null. A
`PythonObject` compares key content and retains insertion order, including the
first key object on overwrite. Literal adjacent surrogate points and a single
non-BMP scalar remain different keys.

`parsePythonPointJson(document, options)` accepts a `PythonText`.
`parsePythonPointJsonBytes(bytes, options)` composes the accepted byte decoder
without converting the intermediate text into a JavaScript string. Both are
synchronous and require `intMaxStrDigits` and an explicit `diagnosticProfile`
(`3.12`, `3.13` or `3.14`). The diagnostic profiles describe the independently
captured CPython 3.12.13, 3.13.13 and 3.14.4 behavior; they do not claim equivalence
to every historical or future patch.

Rich syntax errors are `PythonPointJsonDecodeError` instances named
`JSONDecodeError`, with `msg`, immutable `doc`, `pos`, `lineno`, `colno` and the
exact formatted message. Positions count codepoints. The error object remains
extensible for later exception-context composition. Integer-limit failures are
`PythonPointJsonValueError` instances named `ValueError`. Byte decoding retains
the accepted `PythonUnicodeDecodeError` identity, byte object and offsets.

`serializePythonPointScope(value)` produces compact, sorted, ensure-ASCII text.
`PythonPointJsonCircularError` is named `ValueError` and reports
`Circular reference detected`. Shared acyclic containers are allowed; only an
active traversal cycle fails. Unsupported runtime values fail without calling
`toString` or `toJSON`.

ASCII serialization is not an injective representation: a literal surrogate pair
and a scalar can both emit `"\ud800\udc00"`. Reloading combines adjacent escapes,
which can also collapse distinct object keys. Tests therefore compare full typed
values and ordered keys before serialization and separately check the frozen
ASCII reload result.

## Extraction and compatibility

There is one iterative grammar in `point-parser-core.ts`, with separate builders
for legacy and rich values. `point-text-codec.ts` scans strings over codepoints;
only adjacent high/low JSON escapes combine. Raw pairs and mixed raw/escaped
neighbors remain separate in the rich representation. The legacy builder
projects directly into JavaScript strings and Maps, preserving its previous
collapse behavior without misusing the lossless legacy-map adapter.

`json-serialization-core.ts` contains the shared iterative traversal. The legacy
and rich serializers supply their respective value adapters and cycle-error
projections. The engines do not import the legacy facade or its public error
class. The rich adapters use captured primitive accessors and dictionary entry
methods so branded subclasses cannot replace content, ordering or traversal with
virtual methods.

The existing `parsePythonJson` still exports the same `PythonJsonError` class,
`reason`, codepoint offset and message. Numeric-limit and invalid-option errors
retain their existing identities and ordering. `readJsonObject` continues to
catch `instanceof PythonJsonError` while allowing numeric/configuration errors
through. Legacy serialization still reports `TypeError("Circular JSON value")`.
No existing consumer signature or persisted-output iterator is widened.

Both engines use explicit stacks and retain the existing 2,000-level capability.
This is a TypeScript capability witness, not a claim of matching CPython's
caller recursion limit. Long text and keys avoid argument-spread limits.

## Verification contract

The frozen S08.I/V audit names 64 flat tests in ten cells. Seventeen new literal
tests are self-contained in the three `typed_json_points*.test.mjs` files. The
existing typed, numeric, validation, persisted-JSON and JSONL suites preserve
their callback bodies and observations; five suites replace generated profile
registrations with explicit literal declarations so actual test discovery can
bind their names. Platform-specific default executable names remain unchanged.

Two immutable JSON inputs contain independent expectations: 38 composed documents
for each profile plus three serializer graphs, and 48 supplemental diagnostic,
numeric and key cases for each profile. Their hashes were pinned before source
implementation. Tests verify typed values, numeric identity, exact diagnostic
fields, ASCII output/reload, raw byte composition and required runtime provenance.
Each actual-profile test re-observes the unchanged composed Python reference and
a bounded supplemental stdlib expression, comparing against the pinned data.
Missing aliases or unreviewed patches fail the new profile tests; acceptance
rejects skipped or cancelled results.

The final independent review and exact-subject capture remain the acceptance
gate. Normal coordinator integration also covers typecheck, emission/source
inventory, size and affected consumer checks. The nested `store_raw_read_ts`
suite belongs to that broader supported workflow; its output is not mislabeled
as a flat audit cell. Browser, account and live Store tests are not claimed by
this inert package.
