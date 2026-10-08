# Experimental host command and prompts (slice 4a)

Branch: `codex/agent-workflows-05-host`, stacked on PR #195 at `f541095294b4bdffb7027a2abb2dda90908ed5be`. This delivers the installed command/prompt boundary of slice 4. Repeated model comparisons and any resulting prompt simplification remain a separate acceptance step.

## File organization

| File | Responsibility |
| --- | --- |
| `apps/companion/command.mjs` | Route explicit `workflow` invocations before ordinary Store activation; preserve foreground process ownership |
| `src/cli/experimental-host.ts` | Compose preparation/attempt protocols behind one fixed success/error envelope and exit-status contract |
| `src/cli/experimental-workflow.ts` | Existing explicit-path, fixture-only preparation parser and composition |
| `src/cli/experimental-claim-workflow.ts` | Existing fixture-only broker server/client composition |
| `src/app/preparation-workflow.ts` | Existing code-owned task context, allowed actions, pending request and scoped reply validation |
| `src/app/claim-workflow.ts` | Existing private capability and mutation-time event guards |
| `skills/job-apply/SKILL.md` | Discover the explicit fixture route before ordinary intake |
| `skills/job-apply/references/experimental-workflow.md` | Host invocation, proposal/replay discipline, attestation boundary and outcome wording |
| `skills/answer-memory/references/workflow-map.md` | Link the experimental route without replacing ordinary workflows |
| `tests_js/workspace_host_commands.test.mjs` | Execute copied package commands across processes, verify fixture isolation and canonical outcomes |
| `tests_js/workspace_host_support.mjs` | Disposable installed-layout package, private inputs and owned broker lifecycle |

TypeScript CLI changes have generated `runtime/cli/` counterparts. The route is part of the same plugin: existing skill names, manifests, Codex/Claude discovery paths and ordinary command surfaces remain intact. Both hosts use this shared protocol; no host-specific API or second model session is introduced.

## Boundary and guarantees

`command.mjs workflow prepare <command>` and `workflow attempt <command>` require the explicit absolute fixture root and native-lock artifact already required by the underlying CLIs. No environment/default root resolution, initialization, canonical clone or automatic broker launch occurs on this route. Fixture validation remains inside the existing composition. The foreground broker runs in the command process, so its PID and SIGTERM/SIGINT cleanup refer to the actual owned broker.

The new public route standardizes responses as `{ok:true,result}` or `{ok:false,error:<fixed-code>}` and returns exit status 2 on rejection, including broker rejection. Existing direct experimental and ordinary CLI response contracts are unchanged. Errors do not include input content or filesystem diagnostics.

Preparation context returns canonical task identity and a guarded allowed-action set. The attempt context exposes the active task and live broker capability; it does **not** claim to enumerate payload-dependent allowed actions. Each proposed attempt event still executes through the existing revision, session, readiness and private-capability guards. Prompts explain how to read this state and interpret accepted outcomes. They cannot authorize browser actions, forge human provenance, or substitute prose for a successful durable handoff.

Pending request IDs and replay receipts permit the host to resume the same question and avoid duplicate mutations. The model still decides how to phrase a question and whether it already asked it in conversation. This slice therefore establishes a testable protocol, not a measured reduction in user questions. The current preparation protocol requires an explicit reply even when ordinary intake could infer selection from an exact-job request; model acceptance must assess that tradeoff.

Companion and the ordinary task command keep their existing canonical projections. Tests compare job status/revision and Needs Information reason codes after workflow mutations through `task snapshot`, which uses the same service as Companion. No separate workflow status UI or browser-draft lifecycle is introduced.

## Verification scope

Focused package-layout tests cover missing/relative/aliased/duplicate paths, invalid fixture markers, malformed/oversized input, unsupported commands, no owner-default Store activation, scoped pending reply/replay, stale replies, broker event rejection/exit status, progress, cancellation, canonical projection agreement, PID ownership and graceful termination. Existing broker/crash tests continue to exercise the underlying services.

The release gate verifies both host packages and reachable references. It is distinct from running a model through the new prompt. No live host trial, owner Store/browser use, or baseline/candidate UX comparison is implied by deterministic or package verification. Final receipts belong in the implementation ledger and PR.
