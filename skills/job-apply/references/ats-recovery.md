# ATS recovery and page question batching

The installed `apps/companion/ats-recovery.mjs` exports `atsRecovery`,
`questionBatch`, and `applicationProgress`. These are deterministic advisory
helpers. They do not operate the browser or grant consent, claims, readiness,
or final-action authority. Use current canonical owner descriptors for every
mutation; retain same-chat recovery and managed-resume checks.

## Page intake

Inventory the entire currently visible page before asking questions. Call
`questionBatch(fields, ownsClaim)` with one `{required: boolean, state}` per
control; state is `approved`, `missing`, `consent`, or `unsupported`.
Only use `approved` for a supported fact/answer with current-use authority.
Present all unresolved decisions together, keeping each question and approval
separate. Do not treat a broad yes as a factual answer to unrelated questions.
Optional blanks do not block review; report them to the owner. If the result is
`guarded_needs_info_then_ask_batch`, persist the existing typed blockers and
release the claim before waiting. If no claim exists, ask before acquiring.
A newly revealed conditional page needs a new inventory; do not pre-answer it.

## Workday decision helper

Call `atsRecovery(evidence, budget)`. Exact evidence keys:
- `ats`: `workday` or `other`
- `draft`: `present`, `missing`, `unknown`
- `observation`: `current`, `stale`, `unknown`
- `session`: `unknown`, `authenticated`, `signed_out`, `reauthenticated`
- `failure`: `none`, `field_validation`, `unsupported_control`, `generic_save`, `page_load`
- `refreshApproved`: boolean, current owner approval for this exact draft only

Use only fresh visible observations. A header email does not establish
`authenticated`; inspect the same tenant's account health in a separate tab.
Only a completed user sign-in and fresh health inspection establish
`reauthenticated`. Do not read credentials or use hidden endpoints.

The budget is `{save:0, afterSignIn:0, refresh:0}` ONLY for a newly observed
draft with no prior retries. Keep the returned `nextBudget` before attempting
the proposed action, including when the tool outcome is ambiguous. Carry it
across sign-in, claims and page failures for that same draft. Never reset it
because an error ID, page or claim changed. If history is unavailable, pass
`null`: the policy pauses. This budget is caller-held, not a durable Store
counter; do not add it to canonical session payloads. Loss of context must fail
closed rather than reconstruct a zero budget.

A generic save failure requests a separate session inspection, permits at most
one authenticated retry and one post-sign-in retry. An unsupported control
requests manual help after the ordinary bounded control attempts. Field errors
require inspection, not blind Save retries; use existing field-verification
limits. A page-load failure requires explicit approval before one refresh.
Missing drafts require an explicit fresh-attempt decision; never silently
reconstruct or overwrite. Sign-in requires the user. A pause preserves the
checkpoint and uses guarded Needs Info before waiting.
Never click a final action. Unknown ATS policies pause for supervised diagnosis.

## Honest progress

Call `applicationProgress` with booleans `entered`, `verified`, `pageAdvanced`,
`persistenceConfirmed`. These are separate observations. Say “entered”,
“verified on the visible page”, or “advanced to the next page” as appropriate.
Only set persistence confirmed from explicit portal save evidence or a
recovered draft showing the data. Neither a page transition nor an empty
Candidate Home proves persistence or loss. Never refresh merely to test saving.
The helper never declares manual review ready; use the existing complete
readiness envelope and current final-review inventory.
