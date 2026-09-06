# Matching migration: raw input diagnostic

Date: 2026-09-05. The user asked to move on from PR49 CI work. PR49 remains
with its existing owner; this diagnostic does not depend on its merge or retire
any migration compatibility requirement.

Allowed files for this package: this document and
`docs/integration-evidence/matching-numeric-provenance.json` and
`docs/integration-evidence/matching-controls-provenance.json`.

## Executed evidence

Evaluated 18 raw synthetic JSON requests against both reference adapters from
exact held worker `28369466f45de7e0fa40a7beeeeab7f265521fb4`. The worker was
exported to a disposable temporary directory and removed after execution.
Python received the original request text; Node received the same text through
the worker's ordinary JSON decoding boundary. No Store was opened.

Local provenance: CPython 3.14.4, Unicode 16.0.0; Node 22.22.3, ICU 78.2,
host Unicode 17.0. No cross-version or cross-platform execution is claimed.
The exact requests and responses are preserved in the
[numeric receipt](integration-evidence/matching-numeric-provenance.json) and
[control receipt](integration-evidence/matching-controls-provenance.json).
These are diagnostic observations, not replacement golden contracts.

Ten cases agreed; eight differed:

| Input distinction | Observed difference |
| --- | --- |
| Scope `1` versus `1.0` or `1e0` | Python returns scope mismatch; TypeScript returns exact match |
| Scope `0` versus `-0.0` | Python returns scope mismatch; TypeScript returns exact match |
| Nested scope `[1]` versus `[1.0]` | Same false exact match after decoding |
| Adjacent integers above safe integer range | Python returns scope mismatch; TypeScript rejects unsupported semantics |
| Equal fractional scope values `1.5` | Python returns exact match; TypeScript rejects unsupported semantics |
| Limit `1.0` or `1e0` | Python rejects the limit; TypeScript accepts it |

Controls agree for integer scope, integer negative zero, integer limit,
boolean/string/null limit rejection, local unhashable-sensitivity error text,
sharp S, a Unicode 16 compatibility character and a Unicode 17 character.
Three Unicode samples do not validate the worker's full Unicode implementation.

## Next implementation boundary

The full matching port needs a lossless input boundary before ordinary
JavaScript decoding discards number type/precision information. Retaining the
original spelling alone is insufficient: Python treats `1e0` and `1.0` alike
but distinguishes them from integer `1`; integer `-0` and `0` agree. The next
design must reproduce Python's decoded numeric and scope serialization behavior,
including nested values and arbitrary-size integers, and preserve limit type
validation. Fixing only the scoring arithmetic cannot resolve these examples.

Before implementing that boundary, select the supported reference semantics
explicitly. The held worker targets Python 3.14/Unicode 16, while the existing
CI reference is Python 3.12. This diagnostic makes no runtime/version selection.
The diagnostic receipts can inform new tests once that decision is made; existing
goldens must not be regenerated merely to make comparisons pass.

A smaller TypeScript scoring kernel could accept prevalidated features and
scope identity from Python while this boundary is resolved. That would require
an explicit change to the full-port scope and would not complete matching.

Matching remains held. No parser implementation, production registration,
version bump, golden refresh or live-writer change was made. No browser/package
suite was rerun for this read-only diagnostic.
