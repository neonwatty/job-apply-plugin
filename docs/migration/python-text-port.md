# Inert Python codepoint text leaf

This leaf implements explicit Python string content against the frozen reference
at `13191ee`. It does not change existing PythonJson values, parsers, HTTP
handlers, canonical serialization or persisted writers. Consumer integration
and caller compatibility remain open.

Allowed files are `src/contracts/python-text.ts`,
`tests_js/python_text_ts.test.mjs`, and this document. Runtime emission and
inventory registration belong to the integrating owner.

## Representation and operations

`PythonText.fromCodePoints(points)` validates a number array, copies it and
freezes the copy and object. Integers from 0 through 0x10ffff are admitted,
including individual surrogate codepoints. Sparse arrays, nonnumeric values,
out-of-range values and nonintegral values fail without coercion. Negative zero
normalizes to zero. No caller-owned array remains as mutable backing storage.

`PythonText.fromJavaScript(text)` interprets valid JavaScript surrogate pairs as
Unicode scalars and retains lone surrogates. A literal Python surrogate pair
must be constructed from explicit codepoints; it cannot be inferred from an
ordinary JavaScript string. There is no implicit text or JSON conversion.

The frozen `codePoints` view and `length` expose content. `equals` and `compare`
operate on codepoints; compare returns -1, 0 or 1 using Python lexicographic
ordering. `concat` appends codepoints without merging neighbors. `contentKey`
provides a delimited hexadecimal content identity for explicit keyed lookup;
it is not an encoding of the text. Separately allocated equal values have equal
content keys. Native JavaScript Map object-key identity is not changed.

`encodeUtf8` emits exact scalar UTF-8 bytes. It rejects the first contiguous
surrogate run with `PythonUnicodeEncodeError`, whose name is UnicodeEncodeError
and whose encoding, start/end, reason and message match the frozen Python
reference. Positions count Python codepoints, not JavaScript UTF-16 units.
The error retains the original immutable PythonText in `object`. The exception
itself stays mutable so later cleanup can attach cause/context as elsewhere in
the runtime. Returned Buffers do not expose mutable text backing storage.

## Validation

Focused tests compare all 12 frozen text cases, 144 pairwise comparisons and
three joins against each available CPython 3.12/3.13/3.14 profile. The mandatory
default interpreter repeats a profile rather than supplying independent
coverage. Interpreter aliases are checked against actual versions and executable
path/hash. Missing aliases remain explicit skips.

Additional tests distinguish scalar and literal-pair identity, preserve
concatenated high/low surrogates, reject malformed inputs and forged instances,
verify defensive immutability and error context attachment, check explicit UTF-8
boundary bytes, and exercise 200000 codepoints without spreading them into a
function argument list. This is bounded implementation evidence, not exhaustive
Unicode or full consumer acceptance.

Run `node --test tests_js/python_text_ts.test.mjs` after the integrating owner
emits runtime, with the existing Python 3.12 alias on PATH. Source-size and
TypeScript checks apply. No live Store, server, data migration or dependency
installation is involved.
