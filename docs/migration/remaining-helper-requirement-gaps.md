# Remaining helper requirement worklist

This is a proposed metadata and coverage worklist for the 27 inert answer,
activity and profile helpers. It grants no acceptance, platform support or live
application activation. Inspection date: 2026-09-06. The independent test owner
is addressing targeted stale-response and missing-input cases concurrently;
reconcile that work before writing final requirement records.

## Surface scope

The 27 functions have 54 inventory identities: each is exported by
`workspace/lib/helpers.js` and reexported by `workspace/app.js`.
The reference tests import the first module; differential tests compare it with
the emitted leaf modules. Neither executes the app barrel. Bind these behavior
records to the 27 origin surfaces, or first establish an explicit reviewed rule
for inheriting behavior evidence through a statically verified reexport chain.
Static export discovery alone does not prove app initialization or event wiring.

Use the existing requirement schema, exact test names, oracle hashes and
canonical argv. These files are registered by `node-workspace-other`:
`["node", "--test", "tests_js/<file>"]`. Requirement registration and passing
tests remain distinct from immutable evidence receipts and independent acceptance.

## Exact fixed-reference bindings

Each table row names the exports actually exercised. A row is not a claim that
every scenario category is covered. File names below are relative to `tests_js/`.

`workspace_answer_helpers_reference.test.mjs`:

| Exports | Literal testId |
| --- | --- |
| answerNeedsFreshConsent, answerSummary, canRevealAnswer | answer reference: consent and summary retain truthiness and precedence |
| canRefreshAnswerDraft, canApplyAnswerReveal, canApplyAnswerDialogResponse, canApplyAnswerDialogMutation | answer reference: identity and request gates preserve strict comparison and short circuits |
| answerApiPath | answer reference: API keys use UTF8 URL-safe base64 and unescaped action suffix |
| sameAnswerScope | answer reference: scope comparison preserves JSON coercions and never promises Python equivalence |

`workspace_activity_helpers_reference.test.mjs`:

| Exports | Literal testId |
| --- | --- |
| filterJobs | activity reference: job filter preserves identity/order and status short circuit |
| transitionsFor, canMarkReadyFrom | activity reference: transition and readiness maps preserve inherited lookup behavior |
| shouldUseActivityResponse, newestCanonicalJob | activity reference: revision policies retain integer checks, ties and reference returns |
| activitySignature, activityAnnouncement | activity reference: signatures and announcements preserve field selection and ordered copy |
| attentionMembershipSignature, attentionAnnouncement, attentionMissingInformationText, attentionBlockerSummary | activity reference: attention signatures preserve order and blocker special-case exactness |
| ownerBetaNextStep | activity reference: owner next-step copy and prototype lookups remain observable |

`workspace_profile_helpers_reference.test.mjs`:

| Exports | Literal testId |
| --- | --- |
| formPatch | profile reference: form patch fixes fields and preserves priority coercion |
| pointerValue | profile reference: pointers decode escapes, own keys and primitive boxing |
| patchForPaths | profile reference: patches safely retain prototype-named own fields and ordered collisions |
| patchForPaths | profile reference: overlapping patch paths mutate aliased caller parents and reject frozen parents |
| conflictingPaths | profile reference: conflicts preserve map baselines, structured conflicts and draft order |
| summarizeProvenance | profile reference: provenance selects longest ancestor or sorted descendant summary |
| tagsFromInput | profile reference: tags retain duplicates, order and String coercion |

## Differential bindings

Use these exact existing names in the corresponding `_ts.test.mjs` files.
Inspect each assertion before assigning its export/category set.

`workspace_answer_helpers_ts.test.mjs`:

- `answer TS covers all nine reference exports across ordinary and coercive inputs`
- `answer TS preserves getter access order, short circuits and coercion errors`
- `answer TS scope retains JS JSON semantics, getter order, toJSON and failures`

`workspace_activity_helpers_ts.test.mjs`:

- `activity TS covers twelve exports with ordinary, missing and invalid inputs`
- `activity TS preserves custom callbacks/returns, access order and thrown errors`
- `activity TS retains array/record identities and avoids mutating frozen inputs`

`workspace_profile_helpers_ts.test.mjs`:

- `profile TS covers six exports with fixed ordinary and coercive cases`
- `profile TS preserves getter/coercion and custom iteration behavior`
- `profile TS preserves patch alias mutation, failure boundaries and provenance identity`

For example, the activity identity test exercises only `filterJobs`,
`newestCanonicalJob`, `transitionsFor` and `ownerBetaNextStep`. Its name does not
justify assigning identity or nonmutation evidence to all twelve exports.

## Proposed category applicability

Create requirements per helper/category, or group helpers only when the binding
set collectively covers each helper. Do not copy a single test across 54 surfaces.

| Category | Proposed scope |
| --- | --- |
| valid | Required for all 27; bind the corresponding fixed and differential examples. |
| invalid | Required for all 27; preserve permissive results as well as coercion errors, exceptions and short circuits. |
| missing | Required for all 27; absent arguments and properties are observable even when rejected. Pending focused tests must be reconciled first. |
| noop | Required for refusal predicates, comparisons, retained selections and suppressed or empty outputs. Exclude the unconditional formatters listed below. |
| privacy | Required for answerNeedsFreshConsent, answerSummary, canRevealAnswer and canApplyAnswerReveal, limited to their consent/redaction/selection decisions. |
| conflict | Required for the six stale-result gates listed below, conflictingPaths and patchForPaths. |
| concurrency | Required for the six stale-result gates, limited to synchronous acceptance decisions. |
| interruption | Inapplicable to helper-owned interruption protocols for all 27; they initiate no async operations. |
| recovery | Inapplicable to helper-owned durable recovery for all 27; no storage recovery protocol exists here. |
| platform | Required for all 27; separate Node observations, browser loading and browser behavior. |

The six stale-result gates are `canRefreshAnswerDraft`, `canApplyAnswerReveal`,
`canApplyAnswerDialogResponse`, `canApplyAnswerDialogMutation`,
`shouldUseActivityResponse` and `newestCanonicalJob`. Their synchronous bodies
do not make stale-response behavior inapplicable. Actual asynchronous event
ordering and concurrent Store writers remain separate integration requirements.

`patchForPaths` conflict evidence concerns overlapping path order, retained caller
aliases and failures after earlier assignments. It does not implement concurrent
arbitration or rollback. Its existing caller mutation must remain observable.
`conflictingPaths` determines conflicts from snapshots; it does not schedule writes.

Treat noop as inapplicable as a distinct operation for `answerSummary`,
`answerApiPath`, `activitySignature`, `attentionMembershipSignature`,
`attentionBlockerSummary`, `ownerBetaNextStep` and `formPatch`. Their empty/default
representations still require valid and missing evidence. Other helpers have
observable refusal, equality, empty-result or unchanged-selection branches.

Other helpers can have reviewed privacy/conflict/concurrency inapplicability
where they own no such decision. Scope the rationale to these bodies, not their
callers. Arbitrary getters, proxies and coercion hooks can execute caller code.
Do not claim safe HTML, private logging, authorization, URL suffix sanitization,
transactional mutation or Python scope equivalence from these fixtures.

## Next coverage work

1. The coordinator reviewed and passed the independent test owner's additions:
   `answer request gates reject stale selections, keys, sequences and generations exactly`,
   `activity gates retain absent job results and suppress unchanged queue membership`,
   and `profile helpers preserve errors for absent patch entries and drafts`.
   They live in their respective group `_ts.test.mjs` files and run fixed
   expectations against both implementations. These close the identified local
   assertion gaps; individual requirement bindings and receipts still need work.
2. Bind the 27 origin exports to precise categories and assertion-bearing tests.
   Preserve any still-unexercised cells as work, rather than using another
   export's passing test to remove a gap.
3. Review the app reexport evidence rule or add a separate barrel integration
   package. Keep application activation and event wiring open.
4. Expand platform registration deliberately before claiming a browser cell.
   At inspection, `tools/migration/check.mjs` registers only `node-local`.
5. Capture scoped immutable receipts after the final test/configuration changes
   and independent review. No requirement status should infer acceptance from
   the presence of implementation files or this document.

## Browser evidence limit

The exact test in `workspace_helpers_browser_ts.test.mjs` is
`helper browser contract: emitted modules load and preserve browser-native behavior`.
It checks names for 35 emitted exports. Its 12 result fields exercise eleven
distinct helpers overall because answerApiPath is called twice; two are older
resume/trash helpers. Thus it behavior-exercises nine of these 27:
answerApiPath, answerSummary, canApplyAnswerDialogMutation, sameAnswerScope,
patchForPaths, tagsFromInput, transitionsFor, newestCanonicalJob and filterJobs.

For the other eighteen, the browser test supplies module-load/export evidence
only. Real Chromium runs synthetic routed modules; no application or Store is
launched. The original-only FileReader observation does not accept a TS IO port.
Other browser engines, host locale/Unicode profiles and actual app wiring remain
separate work. A Node runner executing Playwright does not itself turn
`node-local` into a reviewed browser platform contract.
