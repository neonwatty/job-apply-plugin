# S01 implementation proposal — inert codepoint-keyed object

Status: design only. No production changes are made or authorized by this
proposal. P01 bootstrap acceptance and the frozen S01.R binding precede S01.I;
independent review and implementation receipts precede S01.V. The integrating
owner controls catalog registration and final ownership.

## Inputs and exact boundary

Read inputs: `src/contracts/python-text.ts`,
`tools/contracts/python-object/reference.py`,
`tests_js/python_object_reference.test.mjs`, and
`docs/migration/python-object-reference.md`. The accepted text leaf provides
immutable codepoints, content identity, comparison and explicit JS ingress.
The eleven fixed dictionary scenarios establish content lookup, retained first
key identity, insertion order, deletion, shared/cyclic values and distinct
surrogate-pair/scalar keys. They do not establish live-iterator mutation behavior
or a general Python repr implementation.

Own at most two new production modules:

1. `src/contracts/python-object.ts` — generic content-keyed mutable container with
   boolean deletion and fallback lookup; depends only on PythonText.
2. `src/contracts/python-object-legacy.ts` — explicit, shallow legacy Map adapter;
   depends on PythonObject and PythonText. Neither primitive imports the adapter.

No changes to PythonJson, its Map union, parser, serializers, persisted writers,
validation or managed paths belong to S01. The leaf remains inactive until the
separately reviewed S03 preparation/consumer/activation sequence.

## Proposed public API

```ts
class PythonObject<V> {
  constructor();
  get size(): number;
  has(key: PythonText): boolean;
  get(key: PythonText): V | undefined;
  get<D>(key: PythonText, fallback: D): V | D;
  set(key: PythonText, value: V): this;
  delete(key: PythonText): boolean; // false if absent
  entries(): ReadonlyArray<readonly [PythonText, V]>;
}
function fromLegacyMap<V>(source: ReadonlyMap<string, V>): PythonObject<V>;
function toLegacyMap<V>(source: PythonObject<V>): Map<string, V>;
```

The default constructor is deliberately empty: bulk construction and iterable
failure/partial-mutation semantics are not needed for the frozen cases. `entries`
returns a new frozen snapshot array of new frozen tuples. Keys and values are the
original references; structural edits cannot mutate the container through that
snapshot. This is an explicit internal API choice, not a claim of Python's live
dict-view/iterator parity. A consumer requiring iteration concurrent with mutation
must obtain a separate reference and API review before relying on it.

`get` returns the supplied fallback only when the key is absent. Without a
fallback, absence returns undefined. A stored undefined is legal for generic V;
`has` distinguishes it from absence. Neither lookup inserts. Values are opaque:
no cloning, conversion, freezing, recursion, traversal or numeric validation.
Self cycles, shared values and mutations through aliases therefore retain their
identity naturally. JSON cycle detection belongs to the later serializer.

`delete` returns true for an existing key and false for an absent key, matching
legacy Map behavior. Absence leaves the container unchanged. This is an internal
container API, not a Python expression evaluator. Python `del` and its KeyError
formatting remain the responsibility of an explicit future caller boundary;
S01 does not claim that public error behavior from its boolean operation.

## Content identity, order and runtime checks

Use a private `Map<string, { key: PythonText; value: V }>` indexed by the leaf's
collision-free `contentKey()`. This string is internal identity only, never JSON,
UTF-8 or a pathname. A `Map<PythonText, V>` would incorrectly compare allocation
identity; `key.toString()` or joining codepoints into JS text would lose literal
paired surrogates. No property dictionary or prototype-visible key storage.

Every key operation validates a genuine leaf before mutation. The leaf rejects
prototype-forged receivers through its private field when contentKey is invoked;
do not accept instanceof alone. Use the trusted PythonText prototype method for
identity rather than a caller-overridden subclass method, or explicitly reject
subclasses and document that narrower runtime API. Prefer the former because it
preserves genuine branded text without overridable content-identity behavior.

Equal content replaces only the stored value, keeping the first key object and
Map position. Deletion removes the entry. Reinsertion appends at the end and
retains the newly supplied key. Pair D800/DC00, scalar 10000 and lone D800 keys
remain independent. `entries()` exposes insertion order only; sorting is explicit
via PythonText.compare in serializers, never a mutation of container order.
The container itself is mutable; private storage must not escape. Implicit JSON
serialization should throw a clear TypeError so an accidental JSON.stringify
cannot silently emit an empty object. No implicit text conversion is introduced.

## Legacy Map boundary

Adapters are shallow and return fresh containers; all values retain identity.
They do not convert a recursive PythonJson graph, rewire self references or claim
that a source self-cycle becomes a cycle through the returned container. Those
requirements belong to an explicitly graph-aware consumer adapter later.

Ingress accepts actual Map string keys and calls PythonText.fromJavaScript for
each. Supplementary JS characters become scalar points; lone surrogates remain
lone. JS cannot carry literal adjacent surrogate points distinctly, so this
adapter cannot recover information already lost before entry. Validate key types
without coercion; failure returns no partial result and leaves source unchanged.

Egress must be lossless for each key. Build JS UTF-16 in bounded chunks and verify
trusted contentKey values for PythonText.fromJavaScript(candidate) and the
original key; reject a key containing
adjacent literal high/low surrogate codepoints that collapse into a scalar. Do
not blanket-reject all surrogate points: isolated high or low points are exactly
representable. Never use strict UTF-8 encoding as the representability test.
Reject before returning a partial destination. All keys are prevalidated; fresh
Map creation cannot alter the source. This preserves pair/scalar coexistence by
refusing lossy egress rather than overwriting a collision. Invalid inputs and lossy egress throw TypeError. No tagged failure or implicit
fallback is part of this API. Adapters invoke trusted PythonText prototype
contentKey method and its codePoints getter so subclass overrides cannot forge
identity. Do not use equals or compare for adapter validation: those methods
currently read overridable methods or getters.

## Proposed test manifest

New ownership: `tests_js/python_object_ts.test.mjs` and, only if size requires,
`tests_js/python_object_ts_support.mjs`; this document can be updated with receipt
links. Root owns emitted runtime and matrix/catalog registrations. Production and
test modules stay at most 500 physical lines; no exceptions are proposed.

Literal test names to bind before implementation:

- `S01 content-equal keys retain first identity and insertion order`
- `S01 literal pair scalar lone empty and NUL keys remain distinct`
- `S01 deletion returns presence and reinsertion preserves dictionary order`
- `S01 missing lookup differs from present null and undefined`
- `S01 opaque values retain numeric shared and cyclic identity`
- `S01 entry snapshots protect structure while retaining value references`
- `S01 runtime key validation cannot forge content identity`
- `S01 legacy Map ingress preserves representable keys and value identity`
- `S01 legacy Map egress rejects lossy pairs without source mutation`
- `S01 large keys avoid argument-spread limits and retain exact lookup`

Use independently fixed codepoint arrays and actual reference scenarios; do not
normalize observed keys through JS strings. Reuse frozen profile receipts for
Python outcomes. Assert sorted codepoint order separately from insertion order,
key object identity after overwrite/reinsert, unchanged state on errors, alias
mutation, two references to a self-cycle and snapshot independence. Include
forged prototypes, subclass contentKey overrides, invalid primitive keys, long
keys and hidden internal storage. Adapter tests cover values that reference the
source and explicitly assert shallow identity rather than invented graph rewiring.

ASCII JSON reload collapse and cycle serialization errors are already frozen
reference inputs, but implementation parity belongs to the later serializer;
S01 must not add a test-only serializer to claim those cells implemented.

Proposed checks after implementation: focused new Node suite against root-emitted
runtime, existing PythonText suite, typecheck, build consistency and source-size.
The implementation freezes TypeError adapter failures and frozen snapshot entries
as described above. This design itself supplies no execution evidence; acceptance
requires the registered exact-subject tests and independent review. No consumer
activation or S01 acceptance is claimed.
