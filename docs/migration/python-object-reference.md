# Python dictionary/codepoint-key reference

S01.R captures actual CPython dictionary behavior for the future inert
codepoint-keyed object leaf. It does not implement S01.I, modify PythonJson,
activate a parser or writer, or use a Store. The existing reviewed PythonText
leaf supplies the future representation; this reference does not import it.

The allowed files are this document,
`tools/contracts/python-object/reference.py`, and
`tests_js/python_object_reference.test.mjs`. Root owns matrix registration,
the immutable reference checkpoint, combined tests and independent review.

## Closed fixtures

Eleven named fixtures exercise:

- Separately allocated equal keys overwrite their value, retain the original
  key object and keep its first insertion position.
- Literal surrogate-pair, Unicode-scalar and lone-surrogate keys coexist;
  independently constructed keys retrieve the correct values.
- Deletion and reinsertion move a key to the end; ordinary overwrite does not.
- Missing deletion raises the exact KeyError without changing contents.
- Mixed empty, NUL, ASCII, surrogate and scalar keys retain insertion order and
  have independently fixed lexicographic codepoint order when sorted.
- Null, booleans, integer/float identity, negative zero, a beyond-JavaScript-safe
  integer and empty text/list/object values survive the observation format.
- Shared list values retain identity and expose mutation through both aliases.
- A self-referential dictionary retains both aliases. Identity is observed before
  encoding; actual JSON encoding rejects the cycle with its exact exception.
- Two ASCII JSON round trips use opposite pair/scalar insertion orders. Python
  serializes both keys to the same escapes and reloads one scalar key carrying
  the last value. No invented lossless round-trip requirement is imposed.
- Missing lookup differs from a present null value and does not insert a key.

The wire observation uses explicit codepoint arrays, typed numeric values and
ordered entry arrays. It never passes dictionary keys through ordinary JavaScript
string normalization. Shared/cyclic identity is observed directly rather than
inferred from a JSON copy; the recursive wire helper is used only on acyclic
fixtures. JSON is applied to object content only in the explicitly named cycle
and round-trip observations.

## Evidence and limits

The driver accepts no arguments or stdin data. It creates no application files,
starts no server and uses only fixed in-memory fixtures. Interpreter and stdlib
files are read solely for provenance. Tests independently probe the actual
interpreter path/version and hash its bytes, JSON module sources and the loaded
native JSON extension (or record a builtin origin). Fixtures have exact closed
IDs and independently written expected results, including full exception details.

Five literal top-level test identities cover default Python, 3.12, 3.13, 3.14
and input rejection. Missing nondefault aliases are explicit skips and cannot
close their required profile cells. Default Python repeats 3.14 on this host.
The focused run passed five tests, zero failures/skips on CPython 3.12.13,
3.13.13 and 3.14.4 on macOS arm64. This is builtin/reference evidence, not native
filesystem, complete Unicode, JavaScript Map adaptation or parser acceptance.

Run `node --test tests_js/python_object_reference.test.mjs` with the verified
3.12 alias directory on PATH. Reference acceptance still requires independent
review and immutable checkpoint binding; no downstream implementation is unlocked
by this document alone.
