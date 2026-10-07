# Agent workflow implementation ledger

Started 2026-10-07 after owner authorization to begin the [implementation plan](agent-workflow-experiment-plan.md).

Integration branch: `codex/experimental-agent-workflows`, rooted at staging `f95b4947453ad6c6abc9cc0e81c3e443706d4714`. First implementation branch: `codex/agent-workflows-01-contracts`. All development and checks use the experiment worktree and disposable fixtures.

## Slice 1: typed workflow and proposal contracts

Implementation is present; review, broad validation, and PR publication are pending.

| File | Implemented responsibility |
| --- | --- |
| `src/harness/contracts.ts` | Typed workflow definition, code-owned context, action/event/route contracts, execution profiles and redacted error codes |
| `src/harness/validation.ts` | Closed records, exact decimal revisions, bounded immutable proposal snapshots, schema-error redaction |
| `src/harness/proposals.ts` | Decode one route or action proposal; reject supplied state, authority, tool IDs, results and extra fields |
| `src/harness/registry.ts` | Exact workflow/version lookup, registered input schemas, enabled/authorized profile intersection, scoped tool lookup, strictest profile limits |
| `src/harness/router.ts` | Validate new/continue/change/cancel/clarify against current task, revision, capability access, safe-handoff flag and user-event schema |
| `src/harness/planner.ts` | Match a proposed action to code-provided allowed actions; check tool scope, child access/depth and terminal-state completion |
| `tests_js/workspace_harness_contracts.test.mjs` | Adversarial protocol and permission tests, stale revisions, route/handoff behavior, child scope, completion and mutation resistance |
| `tests_js/workspace_harness_support.mjs` | Fictional registry and context fixtures; no Store, host browser or model calls |

The six TypeScript modules have generated `runtime/harness/` counterparts. No installed skill or public command imports the new library yet. Tool registrations contain input schemas; execution handlers and mutation-time rechecks belong to slice 3. Operation IDs are validated references in this slice, not implemented deduplication. `maxSteps` and `maxToolCalls` are exposed configuration for the future run loop; child depth is already checked against the parent and child profiles' absolute nesting limits.

The new protocol uses decimal strings for exact revisions. It accepts bounded JSON-shaped proposal data and takes workflow context exclusively from the caller's canonical projection. Registrations and schema parsers are trusted program code. Parsers may decode arguments into internal types, and schema exceptions are replaced by fixed error codes. A successful validation does not grant execution authority, attest user approval, persist a pause, or prove browser state.

Focused verification: runtime compilation passed (242 modules); all ten contract tests passed. The plan commit passed all eleven commit-hook suites. Broad source/runtime/release gates and independent review remain pending at this checkpoint.

## Next slices

1. Extract application policy and generate canonical workflow context using existing claim/preflight/session guards.
2. Add Store-backed event/pause metadata and a gateway that rechecks the same guards inside mutation transactions.
3. Connect host prompts and public workflow commands; compare behavior against staging fixtures.
4. Demonstrate browser mediation where supported, then extend to extraction and campaigns and run cumulative acceptance.

There is no staging promotion, regular-plugin installation, live applicant Store mutation, or claim of improved application UX from slice 1 alone.
