# Raw matching contracts and implementation decision

Date: 2026-09-05. Package base: `5349cb5eb5d7d38f95a5c535fdd2565326813422`.
Status: reference contracts only; full matching port remains held.

## Ownership and boundaries

Allowed files:

- `tools/contracts/answer-matching-raw/**`
- `contracts/cli/python-answer-matching-raw.schema.json`
- `test/contract/vectors/python-answer-matching-raw-v1.json`
- `tests_js/python-answer-matching-raw.test.mjs`
- `docs/matching-input-boundary-plan.md`

No production source/runtime, existing diagnostics/goldens, runtime versions,
package files, workflows or shared test matrix changed. Python remains the only
live writer. No Store is opened; no held TypeScript matcher is imported.
PR49 remains with its source owner. No merge or CI-equivalence claim is made.

## Executable reference

The Python driver imports the current authoritative Python matcher directly.
Its only requests are the checked-in synthetic fixtures; arguments and nonempty
stdin are rejected before capture. Each raw request string reaches `json.loads`
without an intervening JavaScript decode/re-encode. The first 18 strings are
checked byte-for-byte against the unchanged diagnostic receipts.

The 42 cases cover those 18 plus nested numeric objects, exponent variants,
signed floating zero, large exact integers, NaN/Infinity and exponent overflow,
underflow, escaped keys/strings, duplicate keys, malformed JSON, a secret-value
projection canary, integer digit limits and harness resource limits.

Each vector stores exact raw request text and exact serialized response text.
Those strings are wire evidence, not compressed object representations used to
evade the line limit. All files use conventional formatting and remain below
500 physical lines. The schema closes corpus, provenance, case, override and
decoded response envelopes. Capture additionally checks the exact fixture list,
order and strings, permitted interpreter overrides, and output privacy.

Candidate capture accepts only an absolute, nonexistent output filename outside
this repository, with an existing parent. Canonical parent resolution rejects
aliases into the repository; Git inspection also rejects other working trees
and Git metadata directories. Exclusive creation refuses existing files and
final symlinks. Candidate mode is 0600 on POSIX. The CLI has no input/root option
and supports only the named Python executables. Caller-controlled directories
must remain stable during capture; this is not a hostile multi-user filesystem
service. Committed vectors are never a capture destination.

```sh
node --test tests_js/python-answer-matching-raw.test.mjs
node tools/contracts/answer-matching-raw/capture.mjs --output /tmp/new-raw-candidate.json --python python3.13
```

Provenance is separate from responses: implementation, exact interpreter and
Unicode versions, integer conversion digit limit and recursion limit. Alternate
reference outputs retain the differing bytes; they do not rewrite or normalize
the primary reference.

| Interpreter | Unicode | Observation |
| --- | --- | --- |
| CPython 3.14.4 | 16.0.0 | All 42 cases captured; primary observed reference |
| CPython 3.13.13 | 15.1.0 | Same application/harness responses; two interpreter differences |
| Python 3.12 | Unverified | Not available on current PATH; no installation or parity claim |

Both observed interpreters report a 4300-digit integer conversion limit and
recursion limit 1000. Python 3.13 reports `unhashable type: 'list'`; 3.14 uses
the longer set-element wording. U+1CCD6 normalizes to `a` under the observed
Unicode 16 profile but produces no token under the observed Unicode 15.1 profile.
The vector records both exact responses. Other interpreter profiles are reported
as unfrozen; tests do not label their interpreter-sensitive cases verified.

## Implementation decision: retain typed numbers at every JSON ingress

Proceed with a lossless typed JSON representation, not a string comparison of
numeric lexemes and not ordinary JavaScript numbers alone. Keep integer and
float identity through parsing, validation and scope serialization. Integer
`1`, float `1.0` and float `1e0` require two semantic identities, not three.
Integer `-0` becomes integer zero; floating `-0.0` retains its sign.

The current production matcher receives Python objects, not a raw HTTP packet.
`scripts/job_apply_store/domains/answers/read.py` passes both a parsed request
scope and candidates loaded from the answer document into `rank_candidates`.
The sessions domain calls the same matcher. A future TS boundary must therefore
preserve numeric identity in request payloads, CLI scope arguments AND stored
candidate documents. Applying a lossless parser only to the corpus adapter
would leave the production bug unresolved.

Proposed interfaces (design only):

```ts
type PyNumber =
  | { kind: 'int'; value: bigint }
  | { kind: 'float'; value: number };
type PyJson = null | boolean | string | PyNumber | PyJson[] | PyObject;
type PyObject = Map<string, PyJson>;
type ParseResult = { ok: true; value: PyJson } | { ok: false; error: ParseFailure };
parsePythonJson(raw: string, profile: VerifiedProfile): ParseResult;
serializePythonScope(scope: PyObject, profile: VerifiedProfile): string;
validateCandidateLimit(value: PyJson): number;
```

Use an explicit object representation to avoid JavaScript property-order and
prototype-key traps. Duplicate decoded keys use the last value, including escaped
spellings of the same key. Sort scope object keys by Python string/code-point
order at every depth; retain array order. Escape strings with Python's
`ensure_ascii=True` behavior, including control characters, astral characters
and lone surrogates. Serialization uses compact separators and sorted keys.

Integer atoms use BigInt, never an intermediate Number. Float atoms preserve
IEEE-754 binary64 rounding, negative zero, overflow and underflow. Python's
default JSON decoder also accepts NaN, Infinity and -Infinity; these cannot be
rejected merely to satisfy strict JSON if the full existing contract is retained.
Their scope spellings must match Python's default JSON serializer.

Finite float serialization needs a Python-compatible shortest-roundtrip
algorithm and formatting policy: `.0` for integral floats, lowercase exponent,
Python exponent signs/zero padding and fixed/scientific thresholds. JavaScript
`JSON.stringify` is insufficient, and adding `.0` to `Number.toString()` is not
a demonstrated solution. Differential tests must include rounding boundaries,
subnormals, powers of ten, values around 2^53 and randomly sampled binary64 bits.

Limits must check the numeric tag: a boolean or integral float is not a valid
candidate limit. Only integer values in [1,100] pass. Scope serialization failures
must retain the matcher error contract; syntax failures belong to the caller's
existing error boundary. The raw harness exposes JSONDecodeError as reference
evidence, whereas current Store CLI parsing translates syntax errors to a
value-free StoreError. Do not expose raw input, stack traces or paths in new errors.

## Precision and resource bounds

The harness's 8192-byte input, depth-64 and 4096-byte output caps protect this
synthetic diagnostic only. Their HarnessLimitError responses are tagged
separately. They are not approved production limits and prove nothing beyond
the bounded corpus.

For production compatibility, integer decimal conversion must follow the
verified interpreter's digit-limit configuration, including its disabled mode.
An arbitrary 53-bit or fixed decimal-digit cutoff would narrow accepted inputs.
Exponent length must be scanned without constructing a huge exponent BigInt or
allocating powers of ten; the observed decoder accepts overflow to infinity
and underflow to signed zero. A fixed new exponent cutoff also narrows inputs.

An iterative parser can avoid JavaScript call-stack limits, but exact Python
decode/encode recursion failures depend on the reference interpreter and call
context. The observed recursion setting 1000 is not a demonstrated universal
JSON nesting threshold. Establish the relevant caller's boundary empirically
before reproducing or deliberately changing it. Do not carry depth 64 into
production. Similarly, the current matcher imposes no 4096-byte result cap.

Full-port compatibility remains feasible in principle, but is NOT established
by this design or corpus. Shipping a codec with the harness bounds, ignoring
non-finite values or using a different Unicode profile would narrow/change the
contract and requires a separate scope decision.

## One recommended next package

Implement an inert numeric-atom codec and focused differential tests only:
`src/contracts/raw-json/numeric-atom.ts`, `src/contracts/raw-json/python-float.ts`,
their one-to-one emitted modules and a dedicated numeric test/support family.
Its interface consumes one numeric token and emits a typed atom plus the Python
scope spelling; it does not parse whole documents or route production traffic.
Separate lexical validation, integer conversion and float formatting into
readable modules below 500 lines. This resolves the precision/formatting risk
before building the full object parser. Keep nonnumeric matching and Unicode
tables out of that package. Integration owns future registration/build changes.

No user decision is needed to build that inert numeric package against both
observed references. Before accepting the FULL matcher, one semantic decision
remains: preserve the existing CI Python 3.12 behavior (recommended; first obtain
its actual reference capture), or explicitly adopt Python 3.14/Unicode 16
behavior as a compatibility change. The latter changes at least observed Unicode
recognition and error text relative to 3.13; 3.12 differences still need evidence.
This package selects neither supported version. Avoid choosing compatibility
profiles by accident through whichever `python3` happens to run the tests.

## Verification and integration request

Focused Node run: 11 tests, 10 passed, 0 failed, 1 skipped (Python 3.12 absent).
Both installed version-specific reference comparisons passed, with the two
3.13 differences explicitly recorded. Candidate safety tests cover overwrite,
file symlinks, directory aliases, relative paths, external input/root flags,
unapproved executables, schema extensions and secret/path output rejection.
The first focused run caught a malformed underflow fixture construction; the
new draft fixture was corrected and recaptured from Python before freezing.
Existing committed diagnostic receipts and goldens were never modified.

Exact registration request for the integration owner: append
`tests_js/python-answer-matching-raw.test.mjs` to the `node-workspace-other`
suite's `include` array in `config/test-matrix.json`. Existing
`tools/contracts/**` ownership and `contracts/**` / `test/contract/**` global
rules already cover the new helpers and vectors. No other registration change
is requested. Matrix failure until that one test is registered is expected;
this package must not be treated as fully wired into CI yet.
