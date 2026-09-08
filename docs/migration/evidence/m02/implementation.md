# Small next S05 core package

Prepare filesystemEncodePoint and filesystemDecodePoint as one inert leaf,
src/contracts/point-filesystem.ts, plus its direct runtime emission. Append two
flat codec witnesses to the existing309-line point_paths_reference.test.mjs,
preserving all five original callbacks and their full Python diagnostics. No
reference drivers, vectors, old ports, matrix, path resolvers or cache modules
need edits. Everything remains below500lines.

S05.R already accepts24 complete codec observations across its supported
CPython profiles:12encode and12decode, including NUL, scalar versus literal
pair, raw escape bytes and malformedUTF8. Reuse those inputs/expectations. The
new leaf can consume accepted trusted point contents and legacy byte mechanics
without making shared modules depend on it. Arbitrary caller text must never
roundtrip through UTF16. Decoded legacy output can be projected losslessly only
under the documented scalar-or-low-escape output invariant.

Important boundary: encode-high-escape fails over both points of D800/DC80.
A naive per-point Unicode diagnostic is wrong. Freeze exact error object
identity and span/message behavior before implementation;24cases remain bounded
observations, not an exhaustive generalization to every surrogate run.

Proposed split: M02.I depends on S08.V/S05.R; its V depends on I/P01.V.
Append M02.V to unfrozen S05.I retaining existing dependencies. The only
frozen owner of the chosen test is the audit reference S05.R, so ordinary
accepted-successor continuity permits appending tests when prior bytes/ancestry
and direct dependency are bound. No new matrix registration is needed.

The32-case domain supplement remains necessary for broad managedFile/cache
inputs, including NaN identity and delayed unhashable-id errors. It is not a
codec prerequisite. The16parent and8cache reference rows, five native filename
gaps and fullS05 acceptance remain explicitly open. This small localMac byte
transformation package does not widen other-host/native support claims.

The existing accepted command used716014bytes; retain its1MiB ceiling and
120second bound with seven exact names. No source or tests were run in this
read-only preparation. The JSON records exact paths, pins, coverage, ownership
and the proposed split; a reviewed full manifest is still required.

Concrete freeze supplement: IDs M02.I/M02.V are unused at86d688d. Author
jsonl_review; reviewer hooks_audit. JSON includes complete current input closure,
exact24 input recipes, acceptedS05.R subject/log/old-test pins and typed error
policy. Root owns source-catalog-m02 and docs/m02.

The spec uses the M01 structural fields, parent SEM, one cells entry and an
array of61immutable inputClosure bindings. No P05 manifest owns or binds any
of the three proposed worker paths at the frozen preparation base.
