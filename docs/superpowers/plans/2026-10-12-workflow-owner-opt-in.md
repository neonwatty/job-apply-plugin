# Selected-job owner workflow opt-in

> Execute with superpowers:subagent-driven-development. User approved three parallel workstreams; parent owns shared contracts, integration and testing.

**Goal:** Expose the existing code-controlled attempt workflow through an explicit installed owner route for one selected job.

**Architecture:** A separate `owner-workflow` surface deliberately activates the native Store only on an explicitly attested foreground `serve` command. A scoped transaction adapter binds the broker to one job and canonical input identity. Existing claim, checkpoint, recovery and Needs Info rules remain authoritative. Host tools operate the browser; reports remain agent-attested.

**Spec:** Approved in-chat owner activation, lifecycle/recovery and plugin-experience scope; `docs/architecture/agent-workflow-dogfood-readiness.md`, implementation slice 1.

## Constraints

- Base PR #215, commit `4cffe7aa9ee48b948dd8ffe8b074c10cda9a5fcb`; experimental stacked branch only.
- No actual owner Store activation or live application during implementation. Use private fictional native clones for installed tests.
- Explicit absolute root and selected job required. Invalid invocations must fail before Store activation.
- Existing fixture route and ordinary opt-out route stay distinct. No automatic protocol fallback while claimed.
- New acquisition requires a current run queue entry, confirmed managed resume and unchanged revision/input scope in the commit transaction.
- Existing task recovery preserves original task/input identity; safe exit stays possible after drift.
- Use the v1 finite workflow ledger. Do not activate v2 archival or add persisted schema.
- No restart from manual review or final-review completion in this slice. No final submission.
- Each scoped source file <=500 lines; no new dependencies.

## Interfaces and ownership

| Task | Allowed files | Interface |
| --- | --- | --- |
| 1 Activation policy | `src/app/owner-workflow-policy.ts`, `tests_js/workspace_owner_workflow_policy.test.mjs` | `createOwnerWorkflowStore(repository, jobId)` returns `{store,scope}`; transaction guards bind new acquisition and existing task recovery |
| 2 Lifecycle | `src/integrations/host/owner-claim-broker.ts`, `src/cli/owner-claim-workflow.ts`, `src/app/owner-workflow-receipt.ts`, new owner broker/CLI tests | strict `parseOwnerClaimOptions`; foreground `ownerClaimWorkflow`; scoped broker closes on terminal receipt; exact historical receipt lookup needs no broker or activation |
| 3 Experience | `skills/job-apply/SKILL.md`, owner reference, Companion OwnerWorkflow component and Jobs integration, targeted guidance tests | mutation-free selected-job guidance, explicit consent and code-provided commands |
| 4 Integration (parent) | shared `src/contracts/workspace/owner-workflow.ts`, installed command composition helper/dispatch, installed integration tests, plan | validate before activation; resolve packaged lock; run full installed route and regressions |

`OwnerWorkflowScope` contains jobId, jobRevision, inputRevision, nullable taskId and taskRevision. It is an immutable broker-process scope, not a grant for arbitrary browser actions. No grant file is introduced.

## Implementation and verification

- [x] Task 1: failing scope tests; implement locked preflight and domain guard; pass tests and independent review.
- [x] Task 2: failing broker/parser tests; implement foreground lifecycle with no automatic startup fallback; pass tests and independent review.
- [x] Task 3: add route/reference and selected-job guidance; verify rendered content and installed skill contracts; independent review.
- [ ] Task 4: test malformed/missing-consent calls produce no activation, clone/fixture separation, installed acquire/progress/Needs Info, released claim and owned shutdown, wrong-job denial, drift and broker-loss recovery.
- [ ] Run affected selection against staging and intended base, source-size/type checks, required branch review, full deep/release and normal hooks.
- [ ] Publish stacked PR; retain worktree. No merge or owner pilot.

## Review focus

Wrong-job requests and old receipts must not close an unrelated active scope. Check authorization before activation and every canonical write. Input drift must deny progress without trapping safe exit. Existing native writer ownership and lock exclusion must survive broker loss. UI copy must not imply opt-in, fixture evidence or a historical checkpoint supplies current form consent or readiness.

## Integration findings resolved

Independent review identified an uncertain acquisition commit that left process-local ownership behind recovered durable state. Reconcile only the exact attempted task identity; replay does not restore the claim capability. Terminal response loss uses exact-payload `receipt` lookup without restarting or activating a Store. Owner contexts now generate valid report templates, and command examples match the strict parser.
