# Shared S08/S03 composed codepoint JSON reference

Status: independent review accepted the bounded reference for freezing; formal
P01-bound acceptance remains with the integrating owner. No TypeScript parser or
consumer activation is included. S01.V and S02.V remain prerequisites for S08
implementation. The [approved DAG](remaining/plan.json) now separates shared core
preparation (S08), parallel persistence/path preparation (S04/S05), and final public
activation (S03), following the [consumer audit](remaining/s03-reference.md).
Existing literal S03.R test names remain stable for binding this shared evidence.

## Fixed scope

`tools/contracts/codepoint-json/reference.py` constructs 32 fixed codepoint-array
documents and six fixed byte documents. Actual CPython `json.detect_encoding` and
`bytes.decode(..., 'surrogatepass')` decode the byte documents; actual `json.loads`
parses the resulting text. Python strings are observed as explicit integer
codepoints, never converted to JavaScript strings for identity assertions.

All 38 cases bind the input points, optional input bytes, detected encoding and
complete outcome independently in `tests_js/codepoint_json_reference.test.mjs`.
There are 23 successful documents and 15 failures. The closed case IDs cover:

- Literal adjacent surrogates, one supplementary scalar, adjacent escaped
  surrogates, mixed raw/escaped neighbors, separated escapes, escaped backslashes,
  lone/reversed surrogates and the maximum supplementary scalar.
- Distinct literal-pair/scalar dictionary keys; escaped-key and mixed-key
  overwrites without insertion-position changes; numeric value type retention.
- Deliberately reversed key insertion across D7FF, D800, DC00, E000, 10000 and
  10FFFF, followed by exact Python codepoint sorting and compact ASCII output.
- An unsafe-for-JavaScript integer, integral float, negative zero, overflow to
  positive/negative infinity, NaN, booleans and null alongside literal pairs.
- An explicit integer-string limit of 640 with exactly 640 accepted digits and
  641 rejected digits. This is a controlled reference setting, not a claim that
  the production default limit is 640.
- Syntax failures after literal pairs, scalars and escaped pairs; multiline
  positions, missing colon/value, invalid escape/unicode escape/control character,
  unterminated string, extra data, text BOM, trailing comma and empty document.
- Fixed UTF-8/surrogatepass, UTF-8 BOM, UTF-16 and UTF-32 composition. UTF-16 merges
  the encoded surrogate pair; UTF-8 and UTF-32 preserve the two literal points.

Successes include a typed recursive value (ordered dictionary entries, decimal
integers, exact `float.hex()` values, boolean/null and point arrays), exact compact
`ensure_ascii=True, sort_keys=True` output, and typed ASCII reload. The reload is
observed separately: Python's own ASCII serialization can make distinct pair and
scalar keys collapse on reload. Equality of ASCII output is therefore never
used as proof of equality of the original parsed values.

JSON errors bind the full `JSONDecodeError` document points, `msg`, `pos`,
`lineno`, `colno` and formatted message. The integer-limit failure binds exact
exception type and message. The installed Python 3.12.13 reports `[1,]` as
`Expecting value` at position 3; installed 3.13.13 and 3.14.4 report
`Illegal trailing comma before end of array` at position 2. Tests retain this
profile distinction; they do not claim every historical patch version is known.

Three separately constructed serializer graphs observe repeated shared-array
identity, an array containing itself and an object containing itself. Shared
identity serializes twice successfully; both cycles raise `ValueError` with
`Circular reference detected`. These are actual Python graphs, not JSON inputs
that merely resemble references. They do not establish a general recursion
limit, arbitrary cyclic graph coverage or stack-limit parity.

## Provenance and isolation

Each run reports the actual CPython patch version, platform, byte order,
configured digit limit, resolved executable path and executable SHA-256. Node
independently probes that executable and hashes its bytes. The reference and
independent probe bind the exact source path/hash set for `json`, its decoder,
encoder and scanner, `codecs`, `encodings`, and the UTF-8/SIG/16/32 codec modules.
They also bind actual `_json` and `_codecs` origins and extension hashes; a builtin
origin has no separate file hash and is tied to the hashed executable.

The driver rejects command-line arguments and nonempty stdin before fixtures run.
Tests use isolated mode and disable bytecode writes, with ten-second subprocess
limits and bounded captured output. There is no random corpus, caller-selected
fixture, Store access, network, HTTP handler, browser or output regeneration.
Missing explicit interpreter aliases produce visible skips and unobserved
profile cells, not passing evidence. The default interpreter may duplicate an
explicit profile.

## Verification and limits

Five literal top-level Node tests are stable future binding targets: default
CPython, explicit 3.12, 3.13, 3.14, and caller-input rejection. With the existing
3.12 alias directory prepended to PATH, the focused command was:

```text
node --test tests_js/codepoint_json_reference.test.mjs
npm run check:size
```

Observed locally: five tests passed, zero failures, zero skips on CPython
3.12.13, 3.13.13 and 3.14.4; source-size check passed. These checks remain subject
to independent integration review and do not constitute S03.V.

This is a composed JSON boundary reference. Exact byte-decoder failures remain in
S02.R; streamed reader chunk/read-ahead behavior, physical JSONL line labels and
exception context composition remain in the history references. HTTP transport,
route response encoding, persisted writes, managed path encoding, arbitrary depth
and final Python-free runtime acceptance are not claimed here.
