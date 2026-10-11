# Agent workflow readiness audit

Audit date: 2026-10-11. Baseline: PR #213,
`fd5b18146ccf2a08a52ec7c346ba4e5654e0ca22`. This is a cumulative source and
evidence audit, not a review or acceptance result for unfinished slice 23 work.
No browser, applicant Store, live model, or test suite was exercised for this audit.

The original `/Users/neonwatty/Desktop/extensible-agent-system-plan.md` was
unavailable at audit time. Its checked-in copy,
`docs/architecture/agent-system-reference.md`, is the design reference. The
adaptation to this plugin is `docs/architecture/agent-workflow-experiment-plan.md`;
prior slice outcomes and qualifications are in
`docs/architecture/agent-workflow-progress.md`.

## Assessment against the design

The experiment implements substantial code-owned application lifecycle, durable
pause/reply, revision, claim, replay, extraction, and campaign policy. It preserves
the installed plugin rather than replacing Codex/Claude with a new model runtime.
It has not implemented the reference's complete generic model/tool/child loop.
That loop is explicitly optional in the plugin experiment plan, so its absence
is an architectural limit rather than a prerequisite for bounded plugin trials.

The installed host-browser path uses the host's existing browser tools. Code
validates recorded workflow effects; prompts still govern browser interpretation,
control choice, fresh observation, and truthful reporting. Its evidence kind is
`agent_attested`. The separately mediated synthetic browser API provides stronger
operation ordering inside its adapter boundary; it does not confer those guarantees
on arbitrary Codex host-tool actions.

## File-level responsibility map

Paths below are repository-relative source evidence. Generated `runtime/` modules
mirror source; their existence alone is not installed-package acceptance.

| Concern | Code-owned state or decision | Remaining host/model responsibility |
| --- | --- | --- |
| Closed proposals and access | `src/harness/proposals.ts`, `validation.ts`, `registry.ts`, `router.ts`, `planner.ts`: exact shape/revisions, workflow/profile eligibility, permitted action and child-depth validation | Interpret user intent and propose a valid route/action; a registered capability does not establish consent |
| Execution and persistence | `src/harness/run.ts`, `tool-gateway.ts`, `task-store.ts`: authorization before replay, operation collision checks, atomic task/domain commit, terminal active-task retirement | Decide the next host invocation; `runDurableOperation` is a transaction runner, not a general inference loop; gateway executes one `callTool` and does not run arbitrary child workflows |
| Preparation and selection | `src/app/preparation-workflow.ts`, `preparation-selection.ts`, `preparation-guidance.ts`; `src/workflows/applications/prepare.ts`, `prepare-scope.ts`: exact selection, pending reply, input scope, guarded readiness and advisory command descriptors | Resolve ambiguous job/resume choice and supply the actual user reply; fixture `--host-user-event` is attestation |
| Attempt lifecycle | `src/app/claim-workflow.ts`, `attempt-guidance.ts`; `src/workflows/applications/attempt.ts`, `attempt-session.ts`: current task/job/input binding, private capability, approval recheck at commit, checkpoint, safe exit and explicit recovery | Request recovery only when authorized; provide current observations and distinguish historical receipts from current readiness |
| Claim transport | `src/integrations/host/claim-broker.ts`, `src/cli/experimental-claim-workflow.ts`: context/event/report dispatch, broker lifetime and private claim ownership | Keep the owned process available; inspect current context on replacement; an old receipt does not restore capability |
| Host-browser reports | `src/workflows/applications/host-browser-report.ts`, `src/app/host-browser-guidance.ts`: closed `agent_attested` progress/Needs Info reports, exact canonical binding, saved checkpoint restrictions and report-only replay | Choose and operate actual controls using fresh DOM; preserve unrelated drafts; do not repeat a browser mutation just because its response was lost |
| Extraction | `src/workflows/resumes/extract.ts`, `src/app/resume-extraction-workflow.ts`, `resume-extraction-state.ts`, `src/store/native-resume-workflow-tasks.ts`: managed source/request/draft/review identity, exact confirmation and durable receipts | Extract accurate proposed facts and obtain the matching owner review; inspection explicitly labels approval as host attestation |
| Campaign | `src/app/sequential-campaign-workflow.ts`, `src/contracts/workspace/sequential-campaign.ts`, `src/store/native-campaign-workflow-tasks.ts`: queue derived from canonical run/status, one attempt, pause/resume/stop guards and safe exit | Interpret scoped owner controls; campaign fixture attestation does not authenticate a person |
| Protected approval embedding | `src/harness/user-events.ts`, `src/integrations/host/trusted-attempt.ts`, `approval-session.ts`, `terminal-approval.ts`: separate approval port, event/input binding, expiry, revocation and exact review | Deploy and protect the human channel; synthetic private IPC and terminal declaration are not proof of human identity in the stock plugin |
| Mediated browser boundary | `src/integrations/browser/boundary.ts`, `durable-boundary.ts`, `src/integrations/host/browser-authority.ts`, `workflow-browser-host.ts`, `browser-workflow-broker.ts`: intent before mutation, scope checks, uncertain-result barrier, original-operation reconciliation | Supply trustworthy adapter/control/source mapping; `synthetic.ts` and `local-fixture-adapter.ts` do not implement a general live ATS adapter |
| Durable storage and retention | `src/store/native-workflow-tasks.ts`, `native-claim-workflow-tasks.ts`, `native-workflow-recovery.ts`, `native-workflow-archive.ts`, `native-browser-archive.ts`: journal recovery, historical replay across hot/archive tiers, validation before publication | Respond to finite capacity handoff; do not delete receipts or unresolved operations to force progress |
| Companion presentation | `src/app/browser-recovery-guidance.ts`, `docs/architecture/browser-recovery-companion.md`: read-only committed recovery status and next steps | Explain unavailable/uncertain status without implying the browser draft or human approval is verified |
| Installed skill behavior | `skills/job-apply/SKILL.md`, `references/experimental-workflow.md`, `references/host-browser-workflow.md`, `references/browser.md`, `references/application.md` | Host follows fixture routing, browser consent, field mapping, bounded recovery and manual submission rules; these instructions do not intercept arbitrary browser or shell calls |

## Evidence classes and their limits

| Evidence | What it can support | What it cannot support |
| --- | --- | --- |
| Deterministic contracts and isolated Store tests | Rejection, durability, exact replay, revisions, preservation under enumerated faults | Real model compliance, human decisions or external browser behavior |
| Copied installed runtime acceptance (`docs/architecture/installed-workflow-acceptance.md`; `tests_js/workspace_installed_workflows*.mjs`) | Public command composition, synthetic protected IPC and Store outcomes | Full package/platform gate by itself, actual host-browser use or conversational quality |
| Controlled Chromium and killed Node host (`docs/architecture/local-browser-fixture.md`, `browser-process-recovery.md`; `tests_js/workspace_browser_process_recovery.test.mjs`) | Actual process death and DOM effects on fictional controlled forms; surviving-draft readback without duplicate fill | Live ATS, browser draft reconstruction after reload/closure, owner-session recovery; evidence remains `synthetic_adapter` |
| Restricted Codex controller (`docs/architecture/codex-model-evaluation.md`; `evals/workflows/codex-model-transport.mjs`) | Pinned tool-free proposal transport, independently dispatched/graded scenarios when actual trial traces are supplied | Stock skill/browser UX, authenticated owner input, provider wire equivalence beyond the documented inference |
| Existing host browser acceptance (`docs/architecture/host-browser-acceptance.md`; `evals/workflows/host-browser-fixture.mjs`, `host-browser-grade.mjs`) | Independent page counters and Store receipts when actual native host tool traces accompany a trial | Harness unit tests alone cannot establish native host execution; same-session interruption cannot establish fresh-session continuation |
| Earlier paired model reports (`docs/architecture/preparation-guidance-model-eval.md`, `attempt-guidance-model-eval.md`, `pending-checkpoint-model-eval.md`) | Measured outcomes for the exact pinned products/scenarios, including documented failures | Automatic transfer of UX results to the cumulative candidate, campaign/extraction generality or current host-browser recovery |

A native host tool touching a fictional loopback page is actual host-browser
execution on a synthetic application. Both facts must be retained in the label.
A page counter and accepted report together support the observed outcome; the
report itself still has agent-attested provenance. Nine sequential trials in one
agent conversation would not be nine independent model conversations.

The checked-in slice 22 acceptance document specifies trial receipt requirements,
not a measured ledger. The retained coordination summary at
`/Users/neonwatty/.codex/worktrees/agent-workflow-experiment/job-apply-plugin/.workflows/local/agent-workflow-experiment/parallel-workstreams.json`
was inspected. It identifies PR #213 and the exact baseline above, and reports
nine passing host trials: three each of controls/handoff, uncertain reply/resume,
and stale report/replay, plus one prior failed attempt. It explicitly records one
Codex conversation, null human UX metrics, checkpoint/reobservation rather than
process crash, and 28 passing deep suites with Windows skipped. These are retained
summary claims, consistent with the integration owner's account of
[PR #213](https://github.com/neonwatty/job-apply-plugin/pull/213), not independently
re-inspected live traces or newly executed gates.

The summary points to `.workflows/local/agent-workflow-experiment/slice22-host-trials.json`
in the prior integration checkout. Raw evidence was not reconstructed for this
audit. Link retained exact-revision trial receipts before relying on their detailed
observations for promotion. Slice 23 fresh-session and broker/browser-loss results
must be added only after those packages finish and are verified.

## Finite promotion checklist

Current decision: this audit does not establish staging readiness. Complete the
following evidence checklist against one identified final candidate; record a
pass/fail/deferred outcome and receipt for each item. A deferred requirement needs
an explicit narrower promotion scope rather than an implied success.

- [ ] **Reconcile the candidate and scope.** Identify final integration commit,
  intended staging base, stacked PR status and changed entry points. State whether
  staging merely carries an opt-in fictional experiment or changes ordinary
  applications. Keep fixture-only entry restrictions explicit for the former.
- [ ] **Complete cumulative local gates.** Run affected checks against the intended
  base, source-size checks, required installed Codex/Claude release checks and
  branch review under `AGENTS.md`. Preserve red and baseline receipts separately;
  earlier slice passes are historical evidence, not final-candidate passes.
- [ ] **Establish native host continuation.** Retain actual native browser tool
  traces, installed revision, initial/final page and Store observations for fresh
  session continuation, stale report/exact replay, missing-input safe handoff and
  uncertain browser reply. Verify current context/DOM rediscovery, unrelated draft
  preservation, zero final-action attempts and no duplicate control writes.
- [ ] **Establish loss boundaries.** Test broker replacement while claim is live,
  explicitly authorized expired recovery, source drift and browser reload/loss.
  Verify live unowned claims block progress, recovery retains original inputs,
  source drift permits safe exit only, and lost observation stays uncertain.
  Separate real host cases from controlled driver/process tests in the receipt.
- [ ] **Close evidence and wording gaps.** Keep `agent_attested`, report replay,
  historical checkpoint, current readiness, and browser uncertainty distinct in
  context, skill guidance, final replies and evaluation grades. Record actual
  independent-session counts; leave human UX metrics null unless reviewed.
- [ ] **Validate bounded persistence and compatibility.** Verify pending tasks and
  unresolved browser operations survive archive pressure, historical replay still
  resolves, capacity exhaustion provides safe handoff, and the declared installed
  versions handle the chosen storage format. V2 activation is not reversible by
  merely installing a v1 reader. Define the supported workload horizon without
  requiring unbounded retention.
- [ ] **Decide the ordinary-route boundary explicitly.** If ordinary applications
  are to adopt this workflow, demonstrate scoped consent, resume/fact selection,
  accepted upload/current readiness and manual handoff through that installed
  route. Fictional host-browser trials ending at missing upload do not establish
  a complete live application. If staging only retains the opt-in experiment,
  keep ordinary-route replacement out of its readiness claim.

Protected stock-host approval and a fully mediated live ATS browser are required
only for claims of authenticated approval or enforced host-browser effects.
They are not prerequisites for accurately labeled agent-attested fixture support.
Improved UX requires a repeated comparable baseline/candidate evaluation; merely
shipping an opt-in experiment need not claim improvement.

## Prioritized next work and stop point

1. Finish the already scoped slice 23 fresh-session and recovery packages, then
   integrate their exact receipts and limitations. Fix observed failures; do not
   expand to additional ATS families as a substitute for closing these cases.
2. Assemble one final candidate receipt satisfying the checklist: cumulative
   gates, actual host evidence, preservation/recovery outcomes and scope decision.
   Reuse valid historical evidence for unchanged boundaries while running the
   required final gates; do not rerun all old model experiments without a specific
   unresolved risk.
3. Make the bounded promotion decision. Once the agreed checklist passes, the
   next action is review/promotion under repository policy. A generic recursive
   workflow runner, authenticated stock-host channel, unlimited archival, broad
   ATS support and redesigned model runtime remain separate feature proposals.

Known finite limits are explicit contracts: `src/contracts/workspace/workflow-archive.ts`
and `browser-operation-archive.ts` each cap archive segments at 32; browser hot
operations are bounded under `src/contracts/workspace/browser-operations.ts`.
Capacity handling and accurate unsupported-state reporting are acceptance criteria;
removing every limit is not.
