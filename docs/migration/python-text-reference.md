# Codepoint text foundation reference

This fixed reference precedes the inert TypeScript text leaf. It uses actual
builtin Python string construction, comparison, concatenation and UTF-8 encoding
on twelve explicitly enumerated codepoint arrays. The initial checkpoint is
`8e95a9f`; the commit containing this reference freezes its fixture and test code.

Cases include an empty string, ASCII/control bytes, a Unicode scalar, literal
adjacent surrogates, lone surrogates, a scalar before an encoding error, contiguous
and separated invalid runs, and codepoints on both sides of the surrogate range.
Tests bind every input point, length, UTF-8 byte or complete encoding error,
all 144 pairwise comparisons and three concatenations. Joining two literal
surrogates must retain two Python codepoints and fail strict UTF-8 encoding.
Encoding error positions count Python codepoints, not JavaScript code units.

No input arguments or stdin are accepted. Each run records the actual CPython
version, platform and resolved executable hash, independently checked by the
test process. Builtin semantics are exercised directly; this does not attest
all dynamic operating-system libraries or constitute a reproducible-host claim.
Default Python repeats 3.14.4; explicit aliases also cover 3.12.13 and 3.13.13.

Independent review found the behavior assertions sound and requested stronger
executable provenance, which is now verified against the invoked interpreter.
The scoped files are the Python reference, its Node test and this document.

## Integration boundary

The next leaf will represent immutable explicit codepoints, concatenate and
compare without UTF-16 collapse, expose content-based identity and encode UTF-8
at the caller's existing boundary. It will remain inert until downstream changes
are independently verified. Ordinary JavaScript input has explicit JavaScript
codepoint interpretation; original Python codepoints require explicit input.

Changing values alone is insufficient. Object keys require content equality
and insertion-order behavior; canonical and persisted output must retain point
information until encoding; error timing must match existing writes. Numeric
atoms remain separate. A future hybrid string/text representation needs coherent
changes to parser/object access, validation, path handling, cache keys and output
chunks. No hidden string metadata, global interning or test-only override is
approved. Python's own ASCII JSON round-trip may combine surrogates and must not
be replaced with an invented lossless-JSON contract.
