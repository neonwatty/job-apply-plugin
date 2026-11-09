# S03.R — typed parser and ASCII serializer readiness audit

Status: bounded reference/ownership audit, not S03 acceptance or implementation.
Only this documentation file is owned by this task. S03.I waits for S01.V and
S02.V, independently reviewed S03 reference evidence and the required P01 binding.
No type, parser, serializer, consumer or runtime entry point changes here.

The integrating owner adopted a dependency refinement after this audit: S08
prepares one shared point-aware parser core, S04/S05 prepare their distinct
consumers, and S03 activates the public parser/alias after both pass. The
[current DAG](plan.json) supersedes the preliminary subpackage names below;
it avoids making consumer preparation wait for the activation it must precede.
The [composed reference](../codepoint-json-reference.md) has now been captured
and independently reviewed, with five tests passing across Python 3.12–3.14.
Exact implementation ownership still requires a frozen task manifest.

## Existing evidence reused

| Evidence | What it establishes | Limit relevant to S03 |
| --- | --- | --- |
| `tools/contracts/typed-json/reference.py`, `tests_js/typed_json_oracle.test.mjs` | 712 fixed/seeded JSON inputs, numeric atoms through the existing parser, ASCII output, duplicate escaped keys and syntax rejection. The driver explicitly requires strict UTF-8-encodable raw text. | Literal raw surrogate codepoints are excluded. The JS oracle test checks syntax class/reason but does not compare every recorded Python error offset. ASCII output alone cannot distinguish every Python string or key identity. |
| `tests_js/typed_json_boundary.test.mjs` | Numeric identity, safe property names, scalar-versus-BMP sorting, selected codepoint offsets, cycle rejection, shared acyclic values and a 2000-level TS capability test. | Three offset examples are not full JSON error parity. The depth test explicitly does not prove Python recursion equivalence. |
| Frozen PythonText reference/leaf | Separate scalar and literal-surrogate content, point ordering/concatenation, content keys and strict UTF-8 failure positions. | No JSON escape scanning, dictionary integration or parser activation. |
| Frozen HTTP byte reference | Actual Python JSON byte input admits raw surrogate pairs, preserves mixed raw/escaped neighbors, and distinguishes raw-pair/scalar keys. | Extracted method/encoding expression, not complete HTTP route, caller mutation or framing acceptance. |
| S01.R `python-object` reference | Content-equal keys overwrite without moving the first insertion slot; literal-pair/scalar keys coexist; original key and shared value identity; ASCII round-trip collapse is observable. | Reference only; the future TS object implementation and legacy Map adapters require S01.V. |
| S02.R `python-json-bytes` reference | Fixed actual encoding detection and surrogatepass decoding before parsing; exact codepoints and UnicodeDecodeError byte windows. | Byte decoding deliberately does not interpret JSON escapes or create objects. S02.V is still required. |
| Frozen history reading/identity reference | Actual complete-history reading before canonical comparisons, physical line labels, UTF-8 read-ahead precedence and literal-pair/scalar canonical distinction. | Reader buffering and cleanup are separate from a parser operating on an already decoded document. |

The current `src/contracts/raw-json/parser.ts` takes a JavaScript string, scans
UTF-16 positions, appends escape units using `String.fromCharCode`, and joins
ordinary strings. Its object frames use `Map<string, PythonJson>`. This causes
adjacent raw surrogate codepoints and a scalar to share one representation.
`fail()` counts `Array.from(raw.slice(...))`, which likewise cannot recover a
literal Python pair already collapsed into JavaScript text.

`src/contracts/raw-json/serializer.ts` emits ensure-ASCII strings by UTF-16 unit
and sorts keys using JavaScript codepoint iteration. Its ASCII bytes may match
Python while concealing a wrong input key set or sort order. Native Map identity
for boxed keys cannot replace Python content equality. The serializer also
assumes every non-string/non-container object is numeric, requiring an explicit
string/object/numeric classification boundary before new values are admitted.

## Exact missing reference package

Before S03.I, freeze an actual-CPython composition reference with independent
fixed codepoint inputs and byte ingress fixtures. Proposed ownership is
`tools/contracts/codepoint-json/reference.py`, an optional bounded fixture support
file, `tests_js/codepoint_json_reference.test.mjs`, and its scope document.
No JSON implementation or golden auto-update belongs in this reference package.

Required closed scenario groups are:

1. Raw UTF-8 surrogatepass pair versus UTF-8 scalar versus ASCII escaped pair,
   with full parsed value codepoints. Adjacent **two JSON unicode escapes** may
   combine; a raw high followed by an escaped low, or an escaped high followed by
   a raw low, must remain separate. Cover lone, reversed, repeated-high and
   high/ASCII/low sequences in both keys and values.
2. Equal decoded keys, raw-pair/scalar keys in both insertion orders, escaped
   pair/scalar duplicate keys, and a later independently allocated equal key.
   Bind complete ordered entries, value numeric identity and final key counts;
   canonical/ASCII output by itself is insufficient evidence.
3. ASCII sorting around D7FF, D800, DC00, E000, 10000 and 10FFFF, with empty,
   NUL, ASCII, scalar and surrogate keys. Bind the codepoint key order before
   encoding and the exact ASCII JSON afterward. Python's lossy ASCII reload
   behavior remains valid; do not invent a universal lossless JSON round trip.
4. Every existing escape and malformed escape family, control characters,
   unterminated strings, missing separators/values, trailing data and BOM as
   decoded text. Bind actual JSONDecodeError message, `msg`, `pos`, `lineno`,
   `colno` and original document codepoints, or explicitly freeze a narrower
   approved public error projection. Do not silently replace an existing error
   API with a different class/message during representation work.
5. Syntax failures after a raw pair, after a scalar, after an escaped pair and
   after mixed neighbors; include preceding newlines. Raw document positions
   count Python codepoints; escape spelling remains multiple source characters.
   Byte decoder errors remain UnicodeDecodeError with S02's byte object/window,
   not parser character errors. UTF-8-SIG's BOM offset behavior belongs to S02.
6. Existing integer/float atoms, negative zero, non-finite spellings, digit limits,
   duplicate-key overwrite and nested containers composed with point-aware text.
   Numeric atom algorithms need no Unicode-driven replacement.
7. Cycles and shared values for serialization, plus an explicit caller recursion
   profile. Preserve the existing deep TS capability check without claiming it
   establishes a CPython recursion policy.

Use literal top-level `node:test` names for future P01 binding. The reference must
bind exact inputs/IDs/outcomes and interpreter/stdlib/native implementation
provenance as the reviewed S01/S02 references do. A local profile skip leaves
that profile open. Current evidence is sufficient to specify these cases, but
this audit has not captured or accepted the missing composed reference.

## Production ownership and practical split

A coordinated widening of the current `PythonJson` alias is larger than eight
modules. Do not hide the extra work behind casts, `any`, a test-only decoder,
implicit string conversion or an overload promising legacy values that the
actual input can exceed. Ordinary JavaScript string input is not proof that
unpaired raw surrogates are absent; that requires an enforced and evidenced
caller boundary.

The following proposed split keeps each implementation package bounded. It
requires integrating-owner DAG/manifest reconciliation before dispatch; these
names do not create accepted graph nodes by themselves.

| Proposed subpackage | Exact production ownership, at most eight modules | Completion boundary |
| --- | --- | --- |
| S03-core | New `src/contracts/raw-json/codepoint-value.ts`, `codepoint-parser.ts`, `json-string-reader.ts`, `codepoint-ascii.ts`, and `legacy-json.ts` (five modules) | Point-aware parser/ASCII serializer using accepted S01/S02 interfaces, with explicit legacy adapters. Existing public parser and shared alias stay unchanged. The adapter must report representability without silently merging distinct Python values. This is implementation progress, not full S03 activation. |
| S03-typed-boundary | `src/contracts/raw-json/value.ts`, `parser.ts`, `serializer.ts`, `src/store/validation.ts`, `read-json-object.ts`, `managed-resume-observation.ts`, `managed-resume-path.ts`, `src/contracts/persisted-json.ts` (eight modules) | Explicit guards/signatures and reviewed entry-point policy compile together. Preserve existing caller behavior. Do not expose widened values to an incapable persistence/path consumer merely because TypeScript compiles. |
| S03-path-bridge, if point-aware managed filenames become reachable | `src/contracts/posix-path.ts`, `posix-path-bytes.ts`, `src/store/managed-resume-path.ts`, `managed-resume-native.ts`, `private-file-digest.ts`, `managed-resume-observation.ts` (six modules) | Preserve text through lexical parent/path operations until the actual encoding boundary; native managed-path contract and error ordering remain intact. One sequential owner controls overlapping consumer files. |

The precise new core filenames are proposals, not authorization to duplicate the
existing algorithms wholesale. Prefer extracting reusable traversal and escape
logic when the reviewed reference supports it. S01 owns object equality and S02
owns byte decoding; neither should be reimplemented inside the parser.

The path bridge is a real dependency if `managedFile` can carry PythonText:
`managedResumePath` currently inspects a record string and validates the parent
before returning a candidate. Rejecting an unencodable final component as a
non-string at entry changes that order. `managedResumeObservation` also uses
record IDs as cache keys, so separately allocated equal text must share the
cache entry while scalar and literal-pair IDs remain distinct.

Persistence activation remains coordinated with S04 and its later writer nodes:
`iterPersistedJson` → `TemporaryTextFile.write` → `encodePersistedUtf8`, and the
JSONL chunk join/encoding path, must preserve point identity through the actual
write boundary. `src/contracts/jsonl-json.ts`, `src/store/private-filesystem.ts`
and `atomic-write-json.ts` therefore belong in that later writer ownership,
rather than being silently folded into S03. Upfront surrogate rejection would
change temporary-file creation, chunk writes and cleanup/error precedence.
If S03-typed-boundary cannot preserve legacy behavior while those nodes remain
pending, keep the new core unactivated and reconcile the dependency/activation
split explicitly. Do not mark S03 complete by narrowing its acceptance wording.

## Impacted regressions and verification boundary

Retain the existing typed boundary/oracle and raw numeric suites. Once the new
composed reference exists, require full ordered parsed-value and error receipts,
not just reserialized ASCII equality. Add mutation witnesses where merging raw
pairs, merging mixed neighbors, comparing boxed-key identity, using UTF-16 error
positions or discarding a duplicate key's original insertion slot causes failure.

Consumer gates include `tests_js/store_validation_ts.test.mjs`,
`store_raw_read_ts.test.mjs`, `managed_resume_path_ts.test.mjs`,
`managed_observation_ts.test.mjs`, `persisted_json_ts.test.mjs`, and the atomic/JSONL
suites when their corresponding activation interfaces change. Existing reference
files should remain frozen; new coverage supplements their stated scope.

Proposed independent commands, to be run after ownership registration and when
the heavy-run coordinator permits them:

```text
node --test --test-concurrency=1 tests_js/codepoint_json_reference.test.mjs
node --test --test-concurrency=1 tests_js/typed_json_boundary.test.mjs tests_js/typed_json_oracle.test.mjs
npm run typecheck
npm run build:check
npm run check:size
```

The integrating owner binds each package's full transitive regression set through
P01/P03; this short command list is not an exhaustive acceptance receipt. No test
was executed by this audit. S01.V, S02.V, the composed reference, representation
interfaces, exact public error projection and coordinated consumer activation
remain readiness conditions. S03 is not accepted.
