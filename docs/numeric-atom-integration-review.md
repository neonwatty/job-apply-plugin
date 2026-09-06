# Numeric atom integration receipt

Date: 2026-09-05. Implementation commit:
`871251225cd3a37642ca534b01902148dfc03f0a`.
Base: `b2d22412f0d1598059185fce802f7620ab76b5da`.

## Scope and ownership

Implementation worker owned `src/contracts/raw-json/**` and exact emitted
`runtime/contracts/raw-json/**` counterparts. Independent test worker owned
`tests_js/raw_json_numeric.test.mjs` and `tools/contracts/raw-json-numeric/**`.
Coordinator owned `config/test-matrix.json` and integration documentation.
No package/dependency/CI/runtime-floor or production-routing changes were made.

The existing raw matching contract was reviewed and registered alongside the
numeric test family in `node-workspace-other`. Matrix validation reports complete,
unique ownership. Original raw requests and frozen vectors remain unchanged.

## Implemented interface and algorithm

`parseNumericAtom(token, {intMaxStrDigits})` consumes one entire numeric token,
returning a tagged BigInt integer or binary64 float plus its Python scope spelling.
It accepts Python's NaN/Infinity spellings. Integer limit is explicit; zero disables
it. Syntax/digit-limit failures use value-free NumericAtomError reason codes;
invalid configuration raises RangeError. These are inert internal interfaces,
not replacements for public Store error envelopes.

Finite floats are decoded to exact BigInt rationals. At precisions 1 through 17,
the algorithm tests the two adjacent decimal grid points for roundtrip identity,
then chooses nearest and ties-to-even before applying Python formatting.
Exact comparisons correct the initial logarithmic exponent estimate. This uses
neither JavaScript float stringification as the result nor an approximate decimal
rounding shortcut. Decimal parsing still relies on the JS engine's binary64
conversion, which the differential tests check against Python.

Evidence supports this bounded codec; sampling is not exhaustive proof across
all floats or every future engine. No object parser, Unicode matching, caller
depth limits, production imports, Store access or live writer was introduced.

## Independent review and correction

A reviewer independent of implementation and tests inspected numeric arithmetic,
the Python oracle and the prior raw reference package. One actionable finding:
version-suffixed Python executables could all be absent, allowing the suite to
pass without finite-float differential verification.

Correction: require a platform-default Python oracle, retain optional alias
comparisons, report actual provenance/repeated profiles, and always run 12 fixed
finite/boundary cases. The reviewer confirmed the finding resolved by inspection.
No other concrete numerical/raw-reference safety defect was identified. This
does not establish Python 3.12 parity or full matching acceptance.

## Verification

- Combined focused suites: 23 tests, 20 passed, zero failures, three explicit
  Python 3.12 executable-unavailable skips. [Focused receipt](integration-evidence/numeric-focused.txt).
- Each available independent Python profile compared 5,788 raw numeric tokens:
  CPython 3.13.13/Unicode 15.1 and CPython 3.14.4/Unicode 16.0.
- Seed `1511506142`: 4,096 binary64 samples, 1,024 seventeen/eighteen-digit decimal
  variants, powers of ten and explicit boundary inputs. Compared kind, exact
  scope spelling, BigInt identity and binary64 bits; zero mismatches.
- Default `python3` and `python3.14` are the same 3.14.4 profile, not independent
  additional evidence. Repeated reference capture is byte-deterministic.
- Curated tests cover malformed grammar, 2^53 neighbors, halfway rounding,
  normal/subnormal boundaries, signed zero, overflow/underflow, non-finite values,
  4,300-digit boundaries, unlimited integer conversion and invalid configuration.
- The implementation worker additionally reported 10,000 binary64 samples with
  Python 3.14.4 and seed `504911`, zero spelling mismatches. This supplemental
  worker observation is separate from the committed independent test protocol.
- Type/build parity, source-size and matrix checks pass. Fast tier: six suites
  passed on the implementation commit; [receipt](integration-evidence/numeric-fast.json).

All implementation/test/emitted files are below 500 physical lines. No full,
browser, native-platform or package suite was required or run for this inert
package. Native platform and Node 20 execution remain unverified here.

## Remaining gates and next package

Python 3.12 numeric reference execution remains unverified locally. Numeric
agreement does not select the full matcher's interpreter/Unicode profile.
Full matching, fresh-host runtime distribution and all writer/cutover gates stay
open. PR49 was not inspected, changed or assumed merged by this package.

Next safe implementation: a bounded typed-JSON parser and Python-equivalent
scope serializer consuming this numeric interface, with independent duplicate-key,
escape, ordering and malformed-input contracts. Freeze its caller interface
before document-read workers consume it. Resolve actual Python 3.12 full-matching
semantics separately; do not adopt the diagnostic harness's limits in production.
