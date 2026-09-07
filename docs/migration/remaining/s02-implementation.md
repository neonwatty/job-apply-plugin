# S02 implementation design: Python JSON byte decoding

Status: design only, pending bootstrap acceptance and frozen worker assignment.
No production decoder, new reference capture, runtime activation or Store access is
part of this document. S02 converts bytes into PythonText before JSON parsing. The
approved byte oracle is `tools/contracts/python-json-bytes/reference.py`, with the
independent closed 82-row expectations in
`tests_js/python_json_bytes_reference.test.mjs`: 55 successes and 27 failures.
Its observed profiles are CPython 3.12.13, 3.13.13 and 3.14.4 on macOS. Default
python3 may duplicate a profile; it is not additional independent evidence.

## Bounded worker package and dependency direction

Proposed implementation ownership, to freeze in the actual assignment:

- `src/contracts/python-json-bytes.ts`: public entry, detector and dispatch.
- `src/contracts/python-byte-errors.ts`: immutable decode-error data and rendering.
- `src/contracts/python-utf8-decode.ts`: UTF-8 plus surrogatepass compatibility.
- `src/contracts/python-utf16-decode.ts`: endian units and pair composition.
- `src/contracts/python-utf32-decode.ts`: unsigned units and range checks.
- `tests_js/python_json_bytes_ts.test.mjs`: literal top-level acceptance tests.
- `tests_js/python_json_bytes_ts_support.mjs`: fixed corpus assertions and receipts.
- `docs/migration/python-json-bytes-port.md`: final evidence and limitations.

This is five production modules, each at most 500 physical lines. The existing
`src/contracts/python-text.ts` is a read-only dependency; no facade, native adapter,
HTTP handler or JSON parser changes are allowed. Codec leaves may import PythonText
and the shared byte-error leaf. The public entry imports codecs. PythonText and
shared existing primitives must never import the new decoder. Root separately owns
emission paths, matrix registration, package metadata and frozen task manifests;
include exact emitted paths in the eventual package before making those edits.

The detector/error interface can be reviewed first. UTF-16 and UTF-32 implementations
can run in parallel with UTF-8 once those interfaces are frozen, with separate file
ownership. The integration owner alone edits the entry and aggregate tests. Avoid
three workers creating divergent corpus copies: one test owner binds the existing
closed oracle rows. Independent review follows integrated verification, not merely
each worker's report.

## Proposed frozen interfaces

The runtime accepts a Buffer, matching the owned JSON byte boundary. Reject an
unsupported JavaScript input with TypeError before decoding. Do not silently coerce
strings, arrays, floats, DataViews or arbitrary objects into bytes. This adapter
restriction is distinct from Python's bytes/bytearray API; it is not a restriction
on legal byte values. Buffer elements cover every integer 0..255. Buffer views must
respect their byteOffset/byteLength; decode only the supplied view. Take an owned
snapshot at the public boundary so later caller mutation cannot alter error data.

`detectPythonJsonEncoding(bytes: Buffer): PythonJsonEncoding` returns exactly one of
`utf-8`, `utf-8-sig`, `utf-16`, `utf-16-le`, `utf-16-be`, `utf-32`, `utf-32-le`,
`utf-32-be`. `decodePythonJsonBytes(bytes: Buffer): PythonText` performs detection
then surrogatepass decoding. Detection remains separately callable for testing and
for binding the detected encoding when decode throws. Do not return a JavaScript
string or round-trip through PythonText.fromJavaScript.

`PythonUnicodeDecodeError extends Error` has `name = 'UnicodeDecodeError'`, exact
`encoding`, `start`, `end`, `reason`, and immutable object bytes. Proposed storage is
a private owned Buffer with an `object` getter returning a copy; no caller can mutate
the retained error. Test serialization derives `objectHex` from those bytes. Byte
identity here means exact contents and offsets, not JS object reference equality.
Keep the Error instance extensible for contextual annotations and cause
composition, matching the existing encoding error. Declare scalar error fields
readonly in TypeScript; the retained private byte snapshot never escapes.
This type is distinct from PythonText's existing UnicodeEncodeError and from a
future JSON syntax error. Do not wrap it into a generic parser or HTTP exception.

Internal codec leaves receive the retained error object bytes plus decoding start
and explicit endianness. They return a number array for one final
`PythonText.fromCodePoints` call. Codepoints are finite integers 0..0x10ffff,
including 0xd800..0xdfff; no negative, fractional or above-maximum value can enter
PythonText. Byte indices are integers 0..buffer.length; failures have start < end.
UTF-32 uses multiplication/addition to assemble unsigned units up to 0xffffffff,
not signed 32-bit shifts that turn high values negative.

## Detection algorithm and BOM precedence

Test exact prefixes in this order: UTF-32 BE 00 00 FE FF or LE FF FE 00 00;
UTF-16 BE FE FF or LE FF FE; UTF-8 EF BB BF. Return the generic BOM-aware codec
name for UTF-16/32 and utf-8-sig for UTF-8. This ordering keeps the LE UTF-32 BOM
from being mistaken for UTF-16. Only complete prefixes count as BOMs.

Without a BOM, for length at least four:

1. If byte0 is zero: byte1 nonzero selects UTF-16 BE; otherwise UTF-32 BE.
2. Otherwise, if byte1 is zero: byte2 or byte3 nonzero selects UTF-16 LE;
   otherwise UTF-32 LE.
3. Otherwise select UTF-8.

For exactly two bytes, byte0 zero selects UTF-16 BE; otherwise byte1 zero selects
UTF-16 LE. Other lengths fall back to UTF-8. Thus three-byte zero-looking inputs
remain UTF-8, two zeros select UTF-16 BE, and four zeros select UTF-32 BE.

A selected BOM-aware codec consumes exactly its initial BOM. Interior U+FEFF stays
in the text. utf-8-sig decodes an owned suffix after the three-byte BOM, so its error
object excludes that BOM and its offsets restart at zero. UTF-16/32 decode errors
retain the original full byte object and count offsets including the BOM. The
error encoding is concrete endian form, even when detection returned generic
utf-16 or utf-32. No host-native endianness is needed for these detector-selected
inputs: generic names occur only after an explicit complete BOM.

## UTF-8 algorithm

Decode from left to right and stop at the first error. ASCII emits directly. Valid
lead ranges are C2..DF (two bytes), E0..EF (three), F0..F4 (four); continuation bytes
are 80..BF. C0/C1, continuation bytes used as leads, and F5..FF fail over the lead
byte with `invalid start byte`. Enforce E0 second-byte A0..BF, F0 second-byte
90..BF, F4 second-byte 80..8F, preventing overlong or above-maximum scalars.

Model the strict decoder followed by its surrogatepass handler, not a generic
permissive decoder. For ED A0..BF, accept exactly three available bytes only when
the third is a continuation; emit the surrogate point. The handler consumes that
one encoded point without joining the next surrogate. When the required third
byte is missing or invalid, retain the strict decoder's original failure over the
ED lead with `invalid continuation byte`. In particular ED A0 truncation differs
from E2 82 truncation, which reports `unexpected end of data` over both bytes.

For other sequences, validate each available byte and lead-specific range in order.
On an invalid continuation, the error span includes the valid sequence prefix and
excludes the offending byte. On exhausted input after an otherwise valid prefix,
report `unexpected end of data` across that prefix. Complete valid sequences emit
one point. After a valid surrogate/scalar, a later failure keeps its actual byte
position; do not report codepoint offsets. Full raw ED A0 80 ED B0 80 emits two
points D800, DC00; F0 90 80 80 emits one point 10000.

The frozen 27 failures are acceptance witnesses, not exhaustive proof of every
invalid UTF-8 prefix. Review the generalized prefix/span algorithm against the
inspected CPython codec semantics; do not claim additional differential evidence
without an explicitly approved reference expansion. Never replace errors with
U+FFFD or use Node TextDecoder/Buffer.toString as a parity shortcut.

## UTF-16 and UTF-32 algorithms

UTF-16 reads complete unsigned two-byte units in the selected order. A high
surrogate followed by a complete low surrogate emits
`0x10000 + (high - 0xd800) * 0x400 + (low - 0xdc00)`. A lone high or low surrogate
survives as its own point under surrogatepass. A high followed by an ordinary unit
or another high emits the first high and retries the next unit normally. A high
followed by one residual byte first emits that high, then fails over the residual
byte with `truncated data`. This preserves the frozen high-plus-odd offsets.

UTF-32 reads complete four-byte unsigned values. Values through 0x10ffff emit
unchanged, including lone or adjacent surrogate values; no pair combination is
performed. A value greater than 0x10ffff fails across all four bytes with
`code point not in range(0x110000)`. A residual one/two/three-byte tail fails across
that tail with `truncated data`. Stop at the first invalid complete unit before
considering later bytes. UTF-16 and UTF-32 both preserve interior BOM codepoints.

## Error text and outcome equality

For a one-byte failure use:
`'<encoding>' codec can't decode byte 0xhh in position <start>: <reason>`.
Use lowercase two-digit hexadecimal. For longer spans use:
`'<encoding>' codec can't decode bytes in position <start>-<end-1>: <reason>`.
The encoding, objectHex, start/end, reason, name and full message must all match the
frozen row. Do not normalize endian names, BOM offset conventions or error reasons.
Compare successful PythonText.codePoints and length exactly. In particular escaped
JSON sequences remain literal backslash/u text here; JSON escape parsing belongs
to a downstream package, and surrogate pair/scalar content keys must remain distinct.

## Literal test identities and acceptance gates

Freeze these proposed direct `node:test` names in the later task manifest:

- `S02.I decoder matches all 82 frozen byte outcomes`
- `S02.I detection preserves BOM precedence and zero-byte inference`
- `S02.I UTF-8 surrogatepass preserves Python codepoint identity`
- `S02.I UTF-16 combines only encoded adjacent surrogate pairs`
- `S02.I UTF-32 preserves surrogate units and unsigned range failures`
- `S02.I decoding errors preserve object bytes offsets reasons and messages`
- `S02.I Buffer views and owned error bytes resist caller mutation`
- `S02.I invalid JavaScript inputs fail before byte decoding`

One top-level corpus test can loop the 82 closed IDs internally; never replace
literal top-level names with generated names or count-only assertions. Bind the
independent existing expected rows unchanged, including exact inputHex and detected
encoding. A test-support extraction from the frozen reference test would require
explicit additional ownership and source-hash reconciliation; absent that approval,
write a deliberate fixed port-test copy and independently compare it row-for-row.
Do not auto-generate expectations from the implementation or capture a second oracle.

Required checks: typecheck, root-owned emission consistency, all eight literal port
tests, existing PythonText tests, the existing five reference tests with no required
profile skips, and source-size policy. Reuse the frozen reference runner, record
actual selected interpreter profiles, and do not call a repeated default interpreter
an extra platform. The final review must bind exact subject, command, environment,
all observed test names, zero skips/failures/timeouts and immutable evidence.

S02.I is implemented only when these bounded checks pass. S02.V additionally needs
independent source review of detector precedence, surrogate handler spans, endian
arithmetic and object ownership. JSON syntax/value semantics, HTTP framing,
resource-exhaustion limits, streaming chunk boundaries, custom Python codecs,
non-macOS native acceptance and live Store writes remain outside this leaf. S08
consumes the frozen PythonText result; downstream activation must wait for its own
approved integration and interface checks.

## Prepared audit contracts and registration handoff

`docs/migration/evidence/s02/reference-audit.json` binds S02.R to all five existing
literal reference tests, including the default interpreter, explicit CPython
3.12/3.13/3.14 profiles and input rejection. Every explicit profile is required;
any unavailable interpreter skip fails task acceptance. The reference executable
and expectations remain unchanged. Its manifest path is
`docs/migration/evidence/s02/S02.R.json`.

`docs/migration/evidence/s02/implementation-audit.json` binds S02.I/S02.V to the
eight proposed literal decoder tests above, the same five reference identities and
four existing PythonText tests. Both I/V manifests use the same immutable cells and
may share their captured logs at one tested subject, with independent V review.
Manifest paths are `docs/migration/evidence/s02/S02.I.json` and `S02.V.json`.
The implementation owns the five proposed sources, their corresponding
`runtime/contracts/<module>.js` emissions, new tests/support and port document.
Its production module count is five after declared emissions are excluded.

Root must register the future exact test path
`tests_js/python_json_bytes_ts.test.mjs`, its support ownership and all ten
source/emission paths before freezing activation. Root handles the explicitly owned source-catalog-s02.json shard in the isolated
implementation branch and coordinator review-lock reconciliation. The decoder
worker owns neither edit; both remain in the integrated package evidence. Existing reference and
PythonText tests used by the implementation cell are read-only manifest inputs,
as are PythonText source/emission, frozen oracle files, relevant build/runner
modules and configuration. They are not silently added to decoder ownership.

Each cell has a distinct exact path under `docs/migration/evidence/s02/logs/`.
Reference and decoder cells have a 120-second budget, PythonText has 60 seconds,
and all outputs are bounded to one MiB. Artifacts lists are empty: the required
TAP logs are bound by cells rather than duplicated as artifacts. Root separately
runs typecheck, emission consistency and size checks under the existing gates;
these audit cells do not invent unsupported command reporters to claim those checks.
No profile hashes, actors, subject/evidence commits or result placeholders are
included in these contracts. The current node-local environment record must bind
the actual runner; explicit CPython identities are additionally checked by the
frozen reference tests. Structural audit dependencies are empty, while manifest
receipts must satisfy every archived assignment DAG dependency, including P01.V
and S02.R before implementation. Success unlocks S02 task IDs only, never a product
surface or migration family. No decoder work starts until both gates are accepted.
