# TypeScript dogfood Phase D: owner control plane

Date: 2026-09-17  
Base: `ce151e567cee00974d7e36d2bc9742793c1000dc`  
Branch: `codex/ts-job-apply-dogfood-phase-d-controls`

## Scope and safety

Phase D exercised the remaining connected owner-control-plane surfaces: Overview, Needs Attention, browser-held claims, Pending Questions, grouped approvals, and Answer Cleanup. All records and files were synthetic and confined to fresh disposable Stores. No external portal was visited, no real credential or account was used, and no final application action was authorized or performed.

The trusted Agent Workflows runner was unavailable in this environment. No Workflows execution or evidence is claimed, and no separate dirty checkout was accessed.

## Connected journey evidence

| Journey | Evidence |
| --- | --- |
| Overview | The production browser journey exercised empty/setup, ready-handoff, needs-attention, and restored projections. It verified canonical counts and next-action routing, retained the last good projection during a synthetic service outage, and recovered through explicit retry. |
| Needs Attention | Fresh synthetic records covered `needs_information`, `interrupted_agent_attempt`, `expired_agent_attempt`, and `awaiting_human_review`. Reason filtering, canonical ordering, refresh convergence, keyboard focus, job opening, activity readback, and removal after resolution were verified without exposing claim or answer secrets. |
| Claims | Exact job selection and acquisition were revision-bound. A fresh browser did not inherit the bearer credential. Expiry required explicit status refresh and same-job recovery, which rotated authority. Owner-input handoff released the claim. Concurrent acquisition had one winner, and stale/mismatched authority did not clear or replace the live claim. |
| Fail-closed visible check | A separate visible production Companion was opened on an empty fresh Store. One synthetic saved job was created. Attempting to start it before readiness produced `Action was not confirmed. Refresh status and the selected job before retrying; your job draft is preserved.` No claim was created and the selected revision-1 job remained intact. |
| Pending Questions | The browser flow listed value-free pending questions, opened the saved answer, preserved dirty-navigation protection, disabled resolution for a sensitive/ineligible field, rejected stale revisions without retry, and persisted an explicitly confirmed eligible resolution across refresh. Declined confirmation left canonical bytes unchanged. |
| Sensitive answers | Sensitive values remained hidden until explicit reveal. Editing required fresh remember consent; an unconsented save failed without changing the stored value. Accepted observed-answer review and ordinary edits survived reload. |
| Grouped approvals | Preview was deterministic and read-only. Approval stored only explicitly selected field decisions, supported partial approval, removed obsolete decisions, rejected malformed/stale/unconfirmed input without mutation, preserved an active coordinator claim, and allowed only one competing revision writer. No field was implicitly approved. |
| Answer Cleanup | Empty preview was non-mutating. Duplicate candidates were projected without answer values. Editing a candidate invalidated the preview. Merge required explicit confirmation and exact answer revisions; dismissing confirmation performed no merge. Successful merge retained the selected winner, redirected the retired identity, and left no further clear duplicate. Protected/session references and stale revisions blocked destructive mutation. |
| Restart and durability | The packaged owner journey stopped and reopened the workspace, retained managed identity and canonical state, and failed closed for recovery. The production React journey also reloaded accepted answers, pending resolution state, activity history, and owner-control projections. |
| Mobile | The Answers, Pending Questions, Cleanup, Claims, Overview, Needs Attention, and activity paths were exercised at `390×844`; page-level horizontal overflow checks passed. |
| Privacy | Public projections and browser assertions excluded stored answer values, claim tokens and hashes, owner labels, private answer keys, operation IDs, browser state, private file paths, and synthetic sensitive markers. |

## Validation

- `npm ci`: passed with zero reported vulnerabilities.
- `npm run build:runtime`: passed; 223 runtime modules emitted.
- `npm run companion:build`: passed; production standalone assets assembled.
- Focused owner-control native/model suites: 57 tests passed, 0 failed. The exact files are recorded in the receipt.
- Legacy packaged Python workspace browser suite (`node --test tests_js/workspace.test.mjs`): 3 journeys passed, 0 failed. These covered restart/recovery, every canonical attention reason, and the browser/CLI compatibility journey.
- Native TypeScript/Next production suite (`node --test tests_js/workspace_information_architecture.test.mjs`): 9 tests passed, 0 failed. Its production-standalone journey exercised the native React control plane and shared TypeScript CLI, including projections, claims, Pending Questions, grouped approvals, Answer Cleanup, restart/reload, privacy, and the 390-pixel layout.
- Phase C merge SHA post-merge Release Validation: passed on attempt 2 after an initial isolated 30-second UI timing failure.
- Phase C merge SHA post-merge Validate Plugin workflow and PR gate: passed.

No independently reviewable product defect was reproduced in Phase D, so no product-code change was manufactured. The evidence-only change records the successful tranche and its safety boundaries.

## Cleanup

The visible exploratory Store, native lock artifact, and synthetic resume were contained under `/private/tmp/job-apply-ts-phase-d.f8CXN0`. After the Companion stopped and both in-app browser tabs closed, that directory was moved intact to macOS Trash. It is recoverable; the original temporary path is absent. The production browser test fixtures performed their own isolated cleanup.

No external application was submitted and no real-site final action occurred. The automated disposable fixtures exercised synthetic local lifecycle transitions only; final-action authority remained false throughout.
