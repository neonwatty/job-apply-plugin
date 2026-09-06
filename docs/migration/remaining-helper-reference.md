# Remaining synchronous presentation helper reference

Date: 2026-09-06. Reference capture only; no TypeScript implementation or live
application routing is accepted by this document. Source is the unchanged
`workspace/lib/helpers.js`. All fixtures are synthetic and expected values are
hand-authored, not derived by a duplicate implementation.

Allowed files for this package:

- `tests_js/workspace_answer_helpers_reference.test.mjs`
- `tests_js/workspace_activity_helpers_reference.test.mjs`
- `tests_js/workspace_profile_helpers_reference.test.mjs`
- This document.

## API groups

Answer group, nine exports:
`answerNeedsFreshConsent`, `answerSummary`, `canRevealAnswer`,
`canRefreshAnswerDraft`, `canApplyAnswerReveal`, `canApplyAnswerDialogResponse`,
`canApplyAnswerDialogMutation`, `answerApiPath`, `sameAnswerScope`.

Activity group, twelve exports:
`filterJobs`, `transitionsFor`, `canMarkReadyFrom`, `shouldUseActivityResponse`,
`newestCanonicalJob`, `activitySignature`, `activityAnnouncement`,
`attentionMembershipSignature`, `attentionAnnouncement`,
`attentionMissingInformationText`, `attentionBlockerSummary`, `ownerBetaNextStep`.

Profile/form group, six exports:
`formPatch`, `pointerValue`, `patchForPaths`, `conflictingPaths`,
`summarizeProvenance`, `tagsFromInput`.

The 27 exports exclude the eight previously ported resume/trash helpers and
`fileToBase64`, whose FileReader IO needs a separate browser boundary package.
`FACT_SAVE_REVISION_RETRIES` belongs to another source module, not this family.
Implementation group placement can be reconciled without changing these export
identities or weakening their reference requirements.

## Fixed evidence

Seventeen tests cover each exported function, retaining:

- Answer consent/redaction precedence, missing values, strict key/sequence
  comparison, request short circuits and nonboolean falsy dialog results.
- UTF-8/base64url key encoding, lone-surrogate replacement, String coercion and
  the existing unescaped action suffix behavior.
- JavaScript scope canonicalization: sorted object keys, array order, dropped
  undefined values, NaN/null and signed-zero equivalence, sparse arrays,
  inherited-property exclusion and BigInt/cycle failures. This is explicitly
  not the Python matching scope contract.
- Job-filter reference/order preservation, status short circuit, ordinary
  locale-based query handling and invalid argument errors.
- Transition maps and exact onboarding copy, including their current inherited
  `toString`/`__proto__` lookup behavior and fresh array results.
- Integer revision policy, equal-revision tie behavior and original record
  identity; activity field selection and ordered announcement messages.
- Attention item ordering, missing/null behavior, negative counts, singular and
  plural copy, the exact two-blocker special case and malformed element errors.
- Form field order/defaults, numeric priority coercion and error behavior.
- Pointer escaping, own-property lookup and primitive boxing; patch overwrite
  order, safe own prototype-named fields and conflicting parent-value errors.
  Overlapping paths preserve caller aliasing: assigning a caller object at `/a`
  and then `/a/b` mutates that original object; frozen caller parents throw.
- Map baselines, structured conflicts, draft order and JSON comparison quirks.
- Longest provenance ancestor selection, original result identity, sorted
  descendant summaries and missing timestamps; duplicate-preserving tag coercion.

Frozen records and identity assertions cover nonmutation in relevant families,
but not the overlapping `patchForPaths` case described above. That existing
alias mutation is explicitly frozen behavior, not silently repaired by a port.
These fixtures are bounded reference examples, not exhaustive runtime-type or
browser integration coverage. Additional independent differential tests should
exercise the eventual TypeScript implementation, especially access order and
caller-defined coercion/getter errors.

## Applicability and limits

Filesystem, storage recovery, process interruption, native permissions and
concurrent writers are not operations performed by these helper bodies. Their
absence is suitable for an inert presentation package only. Arbitrary caller
getters, proxies and coercion hooks can execute effects; the helpers are not an
isolation or authority boundary. API paths and displayed messages are existing
presentation behavior, not a new encoding policy or privacy/redaction guarantee.

Locale-dependent case conversion remains the host JavaScript behavior; these
tests select no new locale/Unicode support profile. Browser globals used by
`answerApiPath` must remain available in the eventual caller environment.
Actual event wiring, HTTP/CLI parity, deletion authority, Python matching and
parent UI0 acceptance remain separate gates.

## Verification and integration

Run the three reference test files together with `node --test`.
Focused result after independent alias-mutation review: 17 passed, zero failed
or skipped. Integration owns test
registration, immutable hashes, environment receipts and independent acceptance.
No shared configuration or source files changed in this reference package.
