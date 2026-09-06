# Text integration prerequisites within SEM, READ and TX

This refines implementation ownership inside the approved end-to-end map; it
does not change its dependencies or acceptance criteria. The inert PythonText
leaf precedes these packages. Python remains the sole live Store writer.

## Prepare independently

An object owner can prepare an inert `src/contracts/raw-json/python-object.ts`
and focused tests. Keys need codepoint content equality, retained insertion
position on overwrite, and distinct literal-pair/scalar identity. Existing
`Map<string, PythonJson>` inputs keep their current behavior through explicit
object-access helpers. Neither object identity nor ensure-ASCII key spelling
is a valid content identity. Legacy strings have JavaScript scalar semantics.

A decoder owner can separately prepare a byte-decoding leaf and tests against
the frozen HTTP raw-byte reference. Python's encoding detection and surrogatepass
behavior must preserve raw codepoints. JSON escape-pair combination belongs in
the parser; raw/escaped neighboring surrogates must not be silently merged.
Transport status, body limits and read behavior belong to the later HTTP adapter.

Both packages require exact `allowed_files` before dispatch, independent review,
and their own focused tests. They can run in parallel while remaining inert.

## Integrate with one coordinated owner

Expanding the PythonJson union alone can break every consumer. A coordinated
package must own the necessary changes to raw-json value/parser/serializer,
persisted-json and jsonl-json, plus typed object and string consumers. The
current consumer audit includes Store validation/read-json-object, managed
resume path/observation/native handling, private-file-digest, private-filesystem,
atomic-write-json, and POSIX path/byte helpers. Recheck actual references before
dispatch; do not assume this list replaces compiler and caller analysis.

Tests must preserve legacy typed JSON behavior, content-based object access,
numeric atoms, duplicate-key position, canonical ordering and point-based error
offsets. ASCII scope serialization can remain ASCII and may retain Python's
own lossy surrogate round-trip. Non-ASCII output must preserve explicit points.

Atomic JSON encodes each yielded chunk at its existing temporary-file write.
Keep profile-dependent chunks, prior buffered output, the exact failing chunk,
and cleanup/error order. JSONL assembles the complete document plus newline and
encodes once before opening the append descriptor. Do not join explicit points
through ordinary JavaScript strings or pre-encode the whole atomic document.

Paths and cache keys also need content semantics. Rejecting explicit text early
as a type error can change the existing path-validation and encoding order;
test invalid final components after valid parent checks. Equal separately
allocated texts must share cache identity while literal pairs and scalars differ.

Use the frozen text, HTTP, typed-JSON, atomic and JSONL references together with
caller and path tests. A complete node still requires the acceptance contract's
full coverage; acceptance of these leaves is not acceptance of SEM, READ or TX.
