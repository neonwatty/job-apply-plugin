# Agent workflow implementation ledger

Started 2026-10-07 after owner authorization to begin the [implementation plan](agent-workflow-experiment-plan.md).

Integration branch: `codex/experimental-agent-workflows`, rooted at staging `f95b4947453ad6c6abc9cc0e81c3e443706d4714`. First implementation branch: `codex/agent-workflows-01-contracts`. All development and checks use the experiment worktree and disposable fixtures.

## Slice 1: typed workflow and proposal contracts

Merged in [PR #192](https://github.com/neonwatty/job-apply-plugin/pull/192) to the experimental integration branch at `3753b691`. Reviewed candidate: `def62a74e92f42bbe5d7f5ad9f4affeda6cd3030`.

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

Final slice 1 verification: 242 emitted modules, eleven focused contract tests, all eleven commit-hook suites, native Codex review and five independent review roles passed. The explicit exit-after-revocation policy was reviewed again after its regression test. Clean staging baseline and candidate each passed 28 deep suites with the Windows suite skipped; this includes deterministic, installed Codex/Claude package and native platform checks. Both real pre-push hooks passed. Local evidence is in `.workflows/local/agent-workflow-experiment/validation-summary.json` and the referenced logs. No owner-browser or live model UX comparison was performed.

## Slice 2: shared application policy

Implementation is on `codex/agent-workflows-02-application`, based on merged integration `3753b691`. See the [file map and contract](application-policy-slice.md). Existing command services and experimental workflow inspection now share the application guards. Preflight depends on a narrow observation port; claim/session/restart contracts remain canonical. No public prompt or command consumes the experimental context yet.

Verification checkpoint: the seven policy tests pass, including the exhaustive direct status matrix. Native lifecycle checks, independent branch review and broad publication gates are in progress. Final immutable receipts and results will accompany the slice PR.

## Next slices

1. Finish slice 2 verification and review shared policy/context against the experimental integration base.
2. Add Store-backed event/pause metadata and a gateway that rechecks the same guards inside mutation transactions.
3. Connect host prompts and public workflow commands; compare behavior against staging fixtures.
4. Demonstrate browser mediation where supported, then extend to extraction and campaigns and run cumulative acceptance.

There is no staging promotion, regular-plugin installation, live applicant Store mutation, or claim of improved application UX from slice 1 alone.
