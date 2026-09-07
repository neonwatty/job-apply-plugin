# Wave one: first parallel foundation batch

Date: 2026-09-06. Integration base:
`6100b1d133063db13a642ff918d6b5498dc812ad`, which reconciles staging PR50
(`f18fcda0fdd68c69bc9f0f787f9864060deb33bb`).
Scope: inert JSON and document-validation primitives and pure resume-view helpers.
No live application imports, Store writers, bootstrap or launchers change.
This is the first batch of wave one, not completion of every read/security gate.

## Parallel execution and ownership

Four slots are available, including the coordinator. Three workers ran together:
JSON implementation, an independent Python oracle, and UI implementation. As they
finished, slots rotated to Store validation and independent review. The coordinator
reconciled staging, prepared Python 3.12 reference evidence, registered tests,
managed shared build emission, and authored the independent Store oracle.
No additional worker task was created to circumvent the concurrency limit.

| Package | Exact owned files | Evidence |
| --- | --- | --- |
| Typed JSON | `src/contracts/raw-json/{value,parser,serializer}.ts` and exact emitted counterparts | Independent Python oracle plus boundary tests |
| JSON oracle | `tools/contracts/typed-json/reference.py`, `tests_js/typed_json_boundary.test.mjs`, `tests_js/typed_json_oracle.test.mjs` | Fixed synthetic cases, independent Python parsing/serialization |
| Resume UI helpers | `src/workspace-ui/lib/resume-view.ts`, exact emitted counterpart, `tests_js/workspace_resume_view_ts.test.mjs` | Original JS imported as differential oracle plus fixed expectations |
| Store validation | `src/store/validation.ts` and exact emitted counterpart | Coordinator's `tools/contracts/store-validation/reference.py` and `tests_js/store_validation_ts.test.mjs` |

Only the coordinator changed shared schemas, corpus provenance, matrix, local
test selection and this documentation. No oversized existing source file changed.
All new leaves remain below 500 physical lines. Store facade and workspace
bootstrap were not assigned to multiple workers.

## Frozen inert interfaces

`PythonJson` is null, boolean, string, an existing tagged numeric atom, an array,
or `Map<string, PythonJson>`. Maps preserve duplicate decoded key replacement
without prototype-property behavior. `parsePythonJson` takes raw text and an
explicit integer digit limit; it retains integer/float identity and signed zero.
`serializePythonScope` emits compact, sorted, ASCII-escaped Python JSON spelling.
Traversal uses explicit stacks rather than a new arbitrary nesting limit.

`requireObject` returns the original Map or raises the existing Python message.
`validateVersion` accepts exactly integer schema version 1; missing, boolean,
floating, legacy and future versions preserve the Python validation messages.
These functions perform no filesystem access or repair.

Four UI exports preserve the unchanged JS behavior: `resumeAssignmentText`,
`extractionRequestView`, `proposalGroupForPath`, and `shouldUseResumeResponse`.
They retain current coercions and displayed text; no feature is routed through
the new module yet.

## Independent evidence and review

The JSON oracle compares fixed and seeded raw inputs with Python's own
`json.loads` and sorted compact `json.dumps`. Expected output never comes from
the TypeScript implementation. Tests cover numeric identity, duplicate decoded
keys, prototype-like keys, Unicode ordering, escapes, invalid grammar, cycles
and a separately labeled 2,000-level TypeScript nesting capability check.

An existing managed CPython 3.12.13 installation was discovered outside PATH.
A temporary alias exposed only `python3.12`; the default remained CPython 3.14.4.
No interpreter was installed or default changed. The three observed profiles are
3.12.13/Unicode 15.0.0, 3.13.13/15.1.0 and 3.14.4/16.0.0.
Future checks must discover the existing interpreter rather than infer absence
from a missing command alias.

The earlier 42-case matching corpus initially rejected Python 3.12's exact
trailing-comma diagnostic. The schema now permits that one observed message,
and a separate 3.12 provenance record preserves its three interpreter overrides:
error wording, U+1CCD6 normalization, and trailing-comma wording/position.
No primary response or raw request string was changed. The numeric/raw-reference
suite then passed all 23 tests with no skips across the three profiles.
After the oracle transport correction, the typed boundary passed all 16 tests
without skips: 712 raw cases per distinct profile, 680 accepted and 32 invalid.

Store validation compares 78 fixed cases per profile against the original Python
functions, including arbitrary-size integers and exact error messages. The six
tests passed without skips. UI tests compare unchanged helpers and fixed expected
copy, stale-response behavior, coercions and nonmutation; all 20 new/existing
helper tests passed without skips.

Independent reviews covered JSON implementation/oracle, UI behavior and Store
validation. Review found a real oracle transport limitation: literal adjacent
Python surrogate code points cannot be faithfully distinguished in a JavaScript
string and are not valid UTF-8 raw ingress. The oracle now declares Unicode-scalar
raw text, checks strict UTF-8 encoding, and represents lone surrogates with ASCII
JSON escapes. It does not claim universal Python `str` compatibility.

## Remaining gates and next packages

- Full matching is still held: exact caller diagnostic translation, reference
  recursion/depth behavior and Unicode matching semantics need acceptance.
  Finding Python 3.12 closes availability only, not those behavior decisions.
- Byte ingress still needs its own strict UTF-8/BOM/error contract. The inert
  parser consumes an already-decoded string; this is not a filesystem/HTTP port.
- Next Store package: path/permission and raw-read adapters, with synthetic
  corruption, symlink, legacy/future-version and byte/mtime preservation tests.
  JSON document decoding must consume this typed interface, never `JSON.parse`
  that loses integer/float identity. Startup/recovery mutation stays separate.
- Native clean-host runtime acceptance remains open. Existing local package
  smoke success is not evidence of a fresh host or every supported platform.
- Local selection now covers dependent tests: numeric changes also select the
  typed-JSON and Store validation suites; typed-JSON changes select Store tests.
  New production callers still trigger broader selection until independently
  reviewed ownership is added.

Worker-focused evidence is followed by the integrated staged fast gate. Broad
browser/package/native suites are not repeated per worker for inert leaves.
The final combined focused run passed 73 tests with zero failures or skips,
including all three Python reference profiles and test-selection regression tests.
Before publishing the integrated branch, the push hook requires current deep
evidence because shared matrix/schema/tooling changes invalidate earlier receipts.
PR50's successful deep run is historical evidence, not reused for this new tree.
