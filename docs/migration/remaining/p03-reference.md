# P03 reference preparation — focused selection dependencies

Observed against baseline `adb9fb9`; implementation waits for P01.V.
This is a bounded source audit, not accepted affected-selection evidence.

`tools/local-checks/policy.mjs` has six exact focused rules. Its original
numeric, typed-JSON and Store-validation rules predate additional consumers.
The typed-JSON rule currently selects only typed-JSON and validation tests.
Current direct consumers include `src/store/read-json-object.ts`; parser imports
also occur in persisted-JSON, JSONL and atomic-write test/support modules.
Validation errors are imported by raw-read, managed-path, path-byte and native
observation tests. The current test asserts only one dependent test per rule;
it cannot detect omissions in the growing transitive dependency graph.

## Proposed implementation ownership

`allowed_files` for P03.I:

- `tools/local-checks/policy.mjs`
- `tools/local-checks/focused-dependencies.mjs` (new leaf, if needed)
- `tests_js/local_checks_policy.test.mjs`
- `tests_js/local_checks_dependencies.test.mjs` (new)
- `docs/local-testing-protocol.md`

Root owns any test-matrix registration separately. No source-size exception is
needed; production module count is at most two. No writer may overlap P04's
runner/process ownership. Final immutable inputs and hashes must be bound through
P01 before implementation readiness.

## Required scenarios and acceptance

1. Numeric, parser, serializer, typed-value and validation changes select every
   transitive regression consumer, including dependencies through test support.
2. Newly introduced consumers invalidate an incomplete focused mapping. A fixture
   mutation that adds a consumer must either include its test or escalate.
3. Shared contracts, new/unmapped paths, deletions, policy/matrix edits and native
   lock changes escalate conservatively. Renames account for both paths.
4. Mixed documentation and implementation edits cannot suppress escalation;
   unchanged documentation remains light. Tags select full release/platform work.
5. Missing selected tests and required internal skips cannot satisfy acceptance.
   P05 owns reporter interpretation; P03 must not claim it from suite exit codes.
6. Existing multi-ref, exact-index, outgoing-ref and receipt-identity behavior
   remains intact. No automatic heavy run is added to pre-push.

Independent verification should run the policy/dependency regression tests and
the existing hook tests, then the normal staged checks. The required mutation
tests must prove omitted consumers are rejected, rather than mirror a hand-written
list of expected suite IDs. Broad baseline execution is separate evidence and
does not repair this focused-selection gap by itself.

The implementation may conservatively remove an outdated focused exemption while
retaining safe ones. Optimization requires evidence of complete dependency coverage;
P03 does not need a new general-purpose build graph to fail closed.
