# Explicit point persistence

S04 adds inert persistence entrypoints for `PythonPointJson` in
`src/store/point-persistence.ts`. Existing Store callers continue to use the
legacy `PythonJson` APIs. This preparation neither activates public parser aliases
nor permits Python and TypeScript to write the same live Store.

## Entry points

`iterPersistedPointJson(value, options)` yields `PythonText` chunks matching the
explicit Python profile's indentation and sorting order.
`encodePersistedPointUtf8(text)` strictly encodes the captured codepoints.
`encodePointJsonlJson(value, options)` completes sorted serialization and appends
LF before one strict encoding operation. Options always specify `pathProfile`
and `intMaxStrDigits`; no serialization defaults are inferred.

`atomicWritePointJson(path, payload, options, io?)` uses the existing replacement
state machine with point text and exception policies.
`createNativePointAtomicWriteIO(profile)` constructs its native POSIX adapter.
`appendPointHistoryEvent(path, event, options)` passes the original event to
`isIdempotent`, completing that gate before serialization or IO selection.
Its `serialization` options are required and its `io` is optional.

Paths remain legacy strings. Raw filename compatibility and native Windows
support are outside these entrypoints' accepted scope.

## Shared implementation and legacy preservation

The shared `persisted-json-core.ts` owns traversal, validation, indentation,
cycle detection and layout. Adapters select text and value representations.
Legacy Map keys are sorted after the profile-specific opening prefix, but each
value is read only after yielding its key and separator. Arrays retain their
original identity and indexed reads, including the second read after a
non-scalar prefix yield. Point objects capture trusted entries at sorting time,
retaining their values and sorting text keys by captured codepoints.

The existing atomic, append and native buffering mechanisms are parameterized;
there is no separate point writer state machine. The point encoder runs before
bytes enter the temporary writer's pending buffers. Directory synchronization
keeps its existing swallowed-OS-error policy. JSONL rollback preserves truncate,
sync and close order; initial-stat failure still lies outside explicit cleanup.
Final target installation is not reversed when a later chmod or directory
operation fails.

Legacy entrypoints retain their original exports and their `Error.cause`
projection of cleanup context. Existing facades do not import or re-export the
point leaf. The point leaf alone selects trusted PythonText/PythonObject access.

## Exception facts

`pointExceptionFacts(error)` returns fresh frozen records containing name,
message, positive errno (or null), separate explicit cause and implicit context,
suppression, and registered Unicode facts. Referenced errors and text retain
identity and are not frozen. Reusing exceptions removes a context back-edge
without changing explicit causes.

`describePointException(error, descriptor)` accepts only own data fields named
`cause` and `suppressContext` on a plain or null-prototype object. A supplied cause,
including null, defaults suppression to true. Otherwise an existing non-null
`Error.cause` supplies that default. A boolean suppression override wins.
Descriptors never assign implicit context or mutate caller errors.

Strict encoding reads captured private text contents into a canonical base
PythonText, avoiding virtual subclass accessors. The resulting owned
PythonUnicodeEncodeError keeps its class, message and span while its `object`
refers to the original caller text. Atomic failures refer to the failed chunk;
JSONL failures refer to the assembled LF-terminated line. Foreign errors are
never rewritten to look like Unicode failures.

## Evidence and limits

The frozen [implementation specification](evidence/s04/implementation-spec.json)
and [coverage contract](evidence/s04/implementation.md) bind 17 representable
chunk cases, 10 atomic cases and 8 JSONL cases. The mixed numeric/text-key Python
dictionary remains outside PythonObject's text-key domain. Its legacy Map
boundary is tested separately; this is 35 representable cases, not 36-case point
parity. Expected outputs remain the immutable Python reference vectors.

Focused implementation witnesses, legacy regressions, reproducible emissions,
types, source size and affected suites require coordinator capture and review.
S04.V remains gated on P05.V and the required real host/native evidence. Local
Darwin observations cannot establish Linux, Windows or physical durability
acceptance. No live applicant data belongs in these tests.
