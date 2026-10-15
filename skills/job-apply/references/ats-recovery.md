# ATS recovery and page question batching

The broker route below applies only to an explicitly activated experimental owner
workflow. Ordinary attempts retain their existing bounded recovery and manual
handoff; this reference does not authorize activation or switching brokers.
Page batching and progress labels apply to both routes. Host observations
remain agent-attested. Recovery reservations do not grant browser authority,
consent, readiness, or final-action authority.

## Page intake

Inventory the whole visible page before asking questions. The installed
`apps/companion/ats-recovery.mjs` exports `questionBatch(fields, ownsClaim)`;
pass one `{required: boolean, state}` per control with state `approved`,
`missing`, `consent`, or `unsupported`. `approved` requires a supported fact or
answer and current-use authority. Present all unresolved decisions together,
keeping each question and approval separate. A broad yes does not answer
unrelated factual questions. Optional blanks do not block review; report them.

For `guarded_needs_info_then_ask_batch`, persist existing typed blockers and
release the claim before waiting. If no claim exists, ask before acquiring.
New conditional pages require a fresh inventory; do not pre-answer them.

## Durable owner recovery

Read `owner-workflow host-browser-context` using the current owner broker.
`result.recovery` contains the broker-managed draft identity, recovery revision,
ATS and counters, or null when history is unknown. Paused jobs expose the same
state through read-only `owner-workflow recovery-context`; that read grants no
claim or browser authority. Resolve canonical blockers and reacquire normally.

With an owned current claim, use the descriptor at
`result.hostBrowser.recovery.input`. Copy its task/job revisions, draft identity
and recovery revision exactly. Supply a new opaque `operationId`, `mode`, and
`evidence`, then call:

```bash
node "<plugin-root>/apps/companion/command.mjs" owner-workflow recovery \
  --root <resolved-root> --input <private-json>
```

`mode: "decide"` asks the broker to compute the next recovery action from its
persisted counters. Never send counter values. Exact evidence fields:

- `ats`: `workday` or `other`
- `draft`: `present`, `missing`, `unknown`
- `observation`: `current`, `stale`, `unknown`
- `session`: `unknown`, `authenticated`, `signed_out`, `reauthenticated`
- `failure`: `none`, `field_validation`, `unsupported_control`, `generic_save`, `page_load`
- `refreshApproved`: boolean, current approval for this exact draft only

A header email does not establish an authenticated session. Inspect the same
tenant's account health in a separate tab. Only completed user sign-in and a
fresh health inspection establish `reauthenticated`. Never read credentials or
use hidden endpoints. Opaque error IDs are not diagnoses and are not accepted
by the protocol.

For an explicitly owner-approved **fresh draft**, use `mode: "fresh_draft"`,
Workday/current/present evidence with `failure: "none"` and
`refreshApproved: false`, and add `--host-user-event`. The broker generates the
new identity and zero counters. Use existing current fresh-form approval when
it already applies; do not ask again solely to initialize this record. An old
surviving draft with unknown retry history is not fresh. Null history pauses;
never initialize it merely because a claim or chat restarted. Replacing an
existing recovery record requires the exact displayed recovery revision and
explicit fresh-draft approval. Preserve every previous browser draft.

A refresh decision with `refreshApproved: true` also requires
`--host-user-event` and exact current owner approval. Claims, task/job/input
revisions and profile access are rechecked at reservation time. Sign-in,
claim reacquisition and broker replacement never reset counters.

The broker atomically records the budget and receipt before returning. A new
`actionReserved: true` result reserves at most one indicated retry; perform it
only under ordinary current-form authority. A replay returns `replayed: true`
and `actionReserved: false`: never repeat the browser action from that receipt.
After an ambiguous response or interruption, re-observe the draft and read the
current context. A published reservation stays consumed even if the action's
execution cannot be confirmed. Stale or conflicting requests require new
context, not revision substitution and blind retry.

Workday permits one authenticated Save retry, one post-sign-in retry, and one
explicitly approved refresh per registered draft. Unsupported controls use the
existing bounded field-verification fallback and manual assistance. Field
validation requires targeted inspection, not repeated Save. Missing drafts
require an explicit fresh-attempt decision; never silently reconstruct them.
Unknown ATSs pause for diagnosis. Exhausted history or budget pauses without
clearing records. Use guarded Needs Info and release the claim before waiting.
Never click a final action.

The exported `atsRecovery(evidence, budget)` remains a pure preview for tests
and explanations. Its caller-supplied budget is not a reservation. All owner
retry actions must use the broker route above.

## Honest progress

Use `applicationProgress` with booleans `entered`, `verified`, `pageAdvanced`,
`persistenceConfirmed`. Say “entered”, “verified on the visible page”, or
“advanced to the next page” according to evidence. Confirm persistence only
from an explicit portal save receipt or a recovered draft showing the data.
Neither page advancement nor an empty Candidate Home proves persistence or
loss. Never refresh just to test saving. The helper never declares manual
review ready; use the complete current readiness envelope and review inventory.
