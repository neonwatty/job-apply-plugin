# S02.R Python JSON byte-decoding reference

This reference freezes the byte-to-text stage used before Python JSON parsing:
actual `json.detect_encoding(data)` followed by actual
`data.decode(detected_encoding, 'surrogatepass')`. It calls neither `json.loads`
nor any HTTP handler. It initializes no Store, accepts no caller bytes or paths,
and rejects arguments or nonempty stdin before producing a receipt.

Allowed files are `tools/contracts/python-json-bytes/reference.py`,
`tests_js/python_json_bytes_reference.test.mjs`, and this document. Production
code, runtime emission, inventory and migration state remain outside this package.
S02 implementation remains gated by the separate approved verification phase.

## Fixed corpus and exact results

The 82 fixed inputs comprise 55 successful decodes and 27 decoding failures.
They cover every branch of the inspected encoding detector: empty inputs,
one/two/three/four-byte distinctions, ASCII, zero-byte endian inference, and
UTF-8/16/32 BOM precedence. BOM-only inputs, interior BOMs, both byte orders,
scalar width boundaries and maximum scalars, lone surrogates, adjacent surrogate pairs, partial sequences, odd UTF-16
units, truncated UTF-32 units, out-of-range codepoints and invalid UTF-8 are
explicitly bound. JSON-shaped cases reuse the raw/escaped/scalar payload patterns
from the frozen HTTP reference as independent local fixtures.

Successful values are integer codepoint arrays and Python lengths. No JavaScript
string normalization chooses the observed value. In particular:

- UTF-8 surrogatepass preserves raw ED A0 80 ED B0 80 as D800, DC00.
- UTF-16 decoding combines encoded D800, DC00 into scalar 10000; isolated
  surrogate units survive under surrogatepass.
- UTF-32 surrogatepass preserves separate D800 and DC00 units.
- ASCII JSON escape text remains literal backslash/u characters at this stage;
  combining escaped pairs belongs to the later JSON parser.
- Interior BOMs remain codepoints rather than being removed as leading markers.

Each failure binds the detected encoding separately from the exception's encoding,
the complete exception object bytes, start/end byte offsets, reason and exact
message. UTF-8-SIG removes its BOM before the underlying UTF-8 decoder reports an
error, so the exception object and offsets refer to the suffix. UTF-16/32 failure
objects retain their BOM bytes. A truncated ED A0 surrogate prefix reports
`invalid continuation byte` over byte 0, while E2 82 reports an incomplete
sequence over both bytes. A port must preserve these distinctions.

The JavaScript test independently specifies every input byte, expected encoding
and complete outcome. It compares the closed ID set and full rows, not merely
counts, types or self-reported hashes. No golden generation or update operation
is provided. The five literal top-level test names are stable targets for later
migration evidence binding.

## Provenance and verification

Receipts identify CPython version, platform, byte order and resolved interpreter
path/hash. A separate interpreter probe independently resolves those executable
and stdlib paths; JavaScript reads and hashes the actual files. Provenance includes
`json`, `codecs`, `encodings`, all eight selected UTF codec modules, and the
`_codecs` native origin. Built-in codec code is identified by interpreter bytes;
this does not attest every loaded operating-system library or a reproducible host.

Run `node --test tests_js/python_json_bytes_reference.test.mjs` with the existing
Python 3.12 alias on PATH. Local macOS result: five tests passed, zero failures or
skips, covering CPython 3.12.13, 3.13.13 and 3.14.4. Default python3 repeats 3.14.4
and supplies no independent profile. Each reference/probe process has a ten-second
timeout and one-MiB output limit; isolated mode excludes caller Python environment
configuration, and bytecode writes are disabled.

This is finite decoder evidence. It establishes no JSON object semantics,
HTTP framing, content-length behavior, authorization, downstream validation,
canonical comparison, persistence, native Windows/Linux acceptance, arbitrary
stream chunking, codec customization or resource-exhaustion behavior. Independent
review, immutable freeze and the required verification phase must precede a
production byte-decoder port. No scalar-only ingress restriction is inferred.
