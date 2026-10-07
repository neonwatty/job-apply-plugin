# Agent workflow experiment

Status: implementation authorized on 2026-10-07. See the [implementation ledger](agent-workflow-progress.md) for completed work and outstanding gates.

Prepared 2026-10-07 from remote `staging` at `f95b4947453ad6c6abc9cc0e81c3e443706d4714`, verified against the remote on that date.

## Purpose and accompanying files

Make workflow state, permitted actions, pauses, and completion explicit in TypeScript so the host LLM can propose actions without owning durable transitions. Preserve Job Apply as an installable Codex/Claude plugin with Companion and the existing public command surfaces.

- [Current organization and responsibilities](current-plugin-layout.md)
- [Complete current product file inventory](current-plugin-files.tsv)
- [Supplied architectural reference](agent-system-reference.md)
- [Existing testing contract](../testing.md)
- [Repository instructions](../../AGENTS.md)

The experiment evaluates behavior as well as maintainability: fewer redundant questions, correct continuation after interruptions, rejection of stale actions, and truthful handoff status. Moving files alone does not establish these outcomes.

## Worktree and branch strategy

The experiment worktree is `/Users/neonwatty/.codex/worktrees/agent-workflow-experiment/job-apply-plugin` on local branch `codex/experimental-agent-workflows`. Its starting commit is the staging commit above. This checkout is the integration and acceptance-testing home for the experiment.

Publish that integration branch before opening implementation PRs. Each implementation branch starts from the current integration tip and targets `codex/experimental-agent-workflows`, not `staging`. Suggested names are `codex/agent-workflows-01-contracts`, `codex/agent-workflows-02-application`, and subsequent numbered slices. Review and test each slice before merging it into the integration branch. Rerun affected integration checks after each merge.

Use separate child worktrees only when needed to keep a PR diff isolated. They must use their own disposable fixtures; the integration worktree remains the place for cumulative installed-plugin and acceptance testing. Shared Git objects do not mean shared test Stores or running broker processes.

Record the integration commit, test receipt, and remaining limitation for every slice below. Bring staging changes into the integration branch at deliberate checkpoints; retest after reconciliation. Avoid rebasing a shared integration branch after PRs depend on it. A final promotion PR targets `staging` only after the acceptance gates pass and the experimental result is reviewed. Plugin publication and use of the owner's real Store are separate from this experiment.

The planning snapshot initially created a local integration branch and uncommitted documents. Implementation branch and publication status are recorded in the implementation ledger. The first implementation PR includes the plan together with the contracts; its integration base is the unchanged staging snapshot.

## Architectural decision

Keep Codex/Claude as the model host initially. Introduce a typed workflow protocol around the existing deterministic services. A host turn reads context and allowed actions, proposes a route or action, and invokes the plugin to validate and apply it. The TypeScript harness executes bounded deterministic work between host decisions and returns an explicit next decision or pause.

This provides useful separation without requiring an API key, a second model session, or a second browser owner. A self-contained TypeScript model/tool loop is a later option behind a host adapter; it is not required for the first experiment.

The enforcement claim is scoped: plugin commands enforce Store and workflow invariants. The host retains its own browser and shell tools. A plugin cannot claim to intercept all those tools simply by instructing the model to use a gateway. Browser execution must remain explicitly agent attested until an actual mediated adapter is demonstrated on the supported host.

## State ownership

| Concern | Authority | LLM role |
| --- | --- | --- |
| Canonical jobs, resume/fact revisions, answers | Existing Store services and transactions | Identify intended records and propose changes |
| Job status and active claim | Existing claim services, journals, detached broker | Request a permitted operation |
| Active workflow, pause reason, pending event, consumed event IDs | Versioned workflow metadata persisted through the Store | Propose route or interpret a reply |
| Allowed actions and completion | Workflow definition and guards | Choose from returned actions |
| Live application mode and consent scope | Existing authority plus new validated workflow events | Explain scope and request user input when required |
| Browser observation | Host browser adapter or explicitly labeled agent attestation | Interpret unfamiliar forms and supply observations |
| User-facing facts | Verified canonical projections and accepted observations | Phrase the explanation without upgrading evidence |

The workflow record references canonical entities; it must not duplicate job status, resume facts, answers, claim tokens, or browser contents. Persist a workflow ID/version, task revision, safe phase, pending question/event identity, referenced revisions, and value-free receipts only where existing records do not already represent them.

Never equate a parser-produced `ownerConfirmed: true` with proof of an actual user approval. Preserve the current host trust boundary and bind approval proposals to the exact pending request, scope, and revisions; a prompt-only claim remains host attestation unless a trusted approval channel supplies stronger evidence.

## Proposed source layout

These are proposed additions and extraction destinations. Introduce them in slices; keep compatibility facades while callers and emitted artifacts migrate.

```text
src/
  app/
    handle-message.ts          # Validate route/event against active task
    dispatch.ts                # Eligible workflows from host capabilities and authority
    present-result.ts          # Closed facts, reason codes, permitted outcome wording
  harness/
    contracts.ts               # RouteProposal, ActionProposal, WorkflowDefinition
    registry.ts                # Workflow lookup and version compatibility
    router.ts                  # Validate host-proposed continue/change/cancel/new/clarify
    planner.ts                 # Validate one host-proposed allowed action
    context.ts                 # Minimal versioned context, references, current capabilities
    run.ts                     # Bounded deterministic steps between host decisions
    tool-gateway.ts            # Schema, state, authority, dispatch, redacted receipt
    task-store.ts              # Port for workflow metadata, revisions, operation receipts
    profiles/
      job-apply.ts             # Workflow/tool registrations and bounded execution limits
      resume.ts                # Resume extraction capability registration
  workflows/
    applications/
      prepare.ts               # Exact job/run/resume selection and readiness
      fill.ts                  # Observe, consent, propose write, verify, handoff
      recover.ts               # Explicit blocked/reviewed/expired-claim routes
      events.ts                # Closed user/tool/observation events
      state.ts                 # Workflow phases and selectors over canonical state
      actions.ts               # Allowed action calculation
      policy.ts                # Shared guards used by transition and action exposure
    resumes/
      extract.ts               # Request -> proposal -> owner review boundary
    composites/
      campaign-to-review.ts    # Sequential next permitted job, one active attempt
  integrations/
    host/
      contract.ts              # Host decision and observation protocol
      codex.ts                 # Host-specific payload/presentation adaptation if needed
      claude.ts                # Same domain contract, host-specific adaptation if needed
    browser/
      contract.ts              # Operation, observation, form identity, evidence kind
      synthetic.ts             # Executable local adapter for deterministic tests
  store/
    native-workflow-tasks.ts   # Store-backed metadata/receipt adapter, if required
    ...                       # Existing file, lock, journal, resume and writer adapters
  workspace-core/             # Existing services; progressively extract workflow policy
  contracts/                  # Stable codecs and persisted/public data validation
  cli/                        # Parsing, composition, compatibility entry points
  native/                     # Existing platform integration
  package/                    # Artifact discovery and package support
  qa-replay/                  # Existing replay lifecycle and oracle
skills/                       # Host entry points and task-specific guidance
apps/companion/               # User UI and local process supervision
runtime/                      # Generated one-to-one JavaScript mirror of src/
tests_js/                     # Deterministic tests in existing test infrastructure
evals/                        # Proposed scenario definitions, reports, and graders
```

Execution profiles above are capability registrations. They are distinct from the applicant's stored `profile.json`. Capabilities declare what is installed and supported; current Store authority determines what is allowed now. Registration never grants consent.

Dependency direction: transport/composition -> app/harness -> workflow/domain interfaces. Workflow policy uses contracts and ports, not CLI parsers, Companion components, or concrete filesystem repositories. Store/integration adapters implement ports and are wired at composition. Shared primitives never import workflow leaves. Avoid moving low-level persistence or Python-compatible codecs during this experiment.

## Workflow contract and turn behavior

A workflow exposes `id`, `version`, `requiredProfiles`, `routeDescription`, validated start input and user events, `allowedActions(state)`, `transition(state,event)`, and terminal/completion classification. Use typed internal DTOs with codecs at the existing `Document`/`Value` boundary; preserve integer, Unicode, JSON, CLI and persisted-byte contracts.

A route proposal can continue, change, cancel, start a new task, or clarify. Code validates it against active claims and current revisions. Changing tasks while filling must first preserve a recoverable handoff and release the claim through existing services. A router cannot silently complete a run, adopt an expired claim, or reinterpret cancellation as deletion.

An action proposal is one of `callTool`, `invokeWorkflow`, `askUser`, or `finish`. The action ID must resolve to a registered handler and appear in the workflow's current allowed set. The handler rechecks preconditions under the transaction that performs the mutation; a prior allowed-actions response is not authorization for a later stale write.

For `askUser`, persist a bounded pending request, apply the required handoff/release first, and return the question. Consume a matching reply once. Changed revisions or a changed form invalidate only the affected scope, with a clear reason. Resume requires a fresh canonical snapshot and live form observation.

For `finish`, distinguish `awaiting_review`, `needs_info`, and genuinely completed owner actions. An application agent may finish its filling task at manual review; it may not mark the external application submitted. Resume extraction finishes its agent phase at a draft ready for owner review, not confirmed facts.

Use stable operation IDs for replayable Store mutations. Duplicate delivery must return the original accepted outcome without another write. Specify lookup/authorization/commit ordering and journal recovery before implementation. A browser timeout is an uncertain outcome: observe the form before considering a retry. Do not promise exactly-once execution on a third-party site.

## Code and prompt extraction map

| Current files | Planned responsibility and destination | Treatment |
| --- | --- | --- |
| `src/cli/task-command.ts`, `task-runner.ts`, `task-protocol.ts` | Transport stays in CLI; orchestration goes through app/gateway | Preserve existing command names and envelopes; add an experimental workflow entry point |
| `src/cli/attempt-authority.ts`, `attempt-broker.ts`, `attempt-protocol.ts` | Attempt capability lifetime and OS socket ownership | Keep private bearer in broker; extract workflow decisions without moving capability ownership |
| `src/workspace-core/claims.ts`, `job-preflight.ts`, `job-transitions.ts` | Application guards and canonical transition operations | Extract shared policy to `workflows/applications/`; services remain transaction entry points |
| `src/workspace-core/application-runs.ts`, `application-authority.ts` | Input selection, live authority, campaign scope | Reuse services; expose explicit workflow actions and composite rules |
| `src/contracts/workspace/claim-session*.ts`, `handoff-checklist.ts` | Observation/readiness contracts and handoff guards | Preserve public codecs; extract pure policy only where it improves ownership |
| `src/workspace-core/workspace-projections.ts`, `task-job-projection.ts` | Context and presentation inputs | Reuse redacted projections; do not create a second UI truth |
| `src/workspace-core/extraction*.ts`, `resume-facts.ts` | Resume extraction workflow and owner review | Wrap existing request/proposal/fact lifecycle after application vertical slice |
| `src/store/native-jobs.ts`, journals and state repositories | Persistence and transaction composition | Add a narrow task metadata port only after defining crash/revision behavior |
| `skills/job-apply/SKILL.md`, `references/intake.md`, `application.md`, `recovery.md` | Host routing instructions and workflow interactions | Replace duplicated transition instructions with calls to the explicit protocol |
| `references/browser.md`, `readiness.md`, `consent-intents.md`, `application-automation.md` | Browser judgment, consent explanation, evidence collection | Move enforceable rules to code; retain live observation and host-specific instructions |
| `references/field-mapping.md` and ATS references | Semantic interpretation and platform guidance | Keep concise and task-loaded; no synthetic selectors presented as live observations |
| `skills/answer-memory/references/workflow-map.md` | Human-readable cross-skill map | Update alongside contracts; link to one authoritative executable workflow definition |
| `skills/job-apply/references/worker-delegation.md` | Supported host launch/handoff rules | Preserve one browser owner and current host constraints |
| `config/core-workflows.json`, `.workflows/`, `qa/`, `tests_js/` | Evidence inventory, fixtures, deterministic checks | Reuse current test infrastructure; add model scenario metadata without confusing evidence with runtime dispatch |

Keep skill entry point names and package discovery paths. State exactly which rules code enforces and which observations the host supplies. Prompts explain the available context, decision schema, observation discipline, and communication style. They should not reproduce the full transition table.

## Implementation slices and PRs

Each slice gets a PR against the experimental integration branch. Record exact commits and evidence in the [implementation ledger](agent-workflow-progress.md); the rows below define the planned scope and exit criteria.

| Slice | Changes and principal files | Required exit evidence |
| --- | --- | --- |
| 0. Baseline | This plan; isolated fixture setup; characterize current scenarios before behavior changes | Staging baseline receipts and measured failure/clarification counts; label existing red gates |
| 1. Contracts | `harness/contracts.ts`, `registry.ts`, profiles, action/route codecs, tests | Invalid/unknown actions, incompatible versions, unregistered workflows and unauthorized capabilities rejected; no product behavior changed |
| 2. Application policy | `workflows/applications/*`; focused extractions from claims, preflight and session rules | Existing behavior parity plus invariant tests; allowed actions and transitions share guards; no double authority |
| 3. Durable protocol | `app/*`, `harness/{context,run,tool-gateway,task-store}.ts`, Store metadata adapter, experimental CLI composition | Replayed events, stale revisions, crash windows, broker loss, pause/restart and cancellation tested on isolated Stores |
| 4. Host and prompts | Host protocol adapters; Job Apply references; shared workflow map; Companion context/status where needed | Installed host uses workflow context and explicit proposals; fewer redundant prompts on fixed scenarios; existing entry points and UI agree |
| 5. Browser boundary | Browser contract and synthetic adapter; demonstrated supported-host adapter where feasible | Denied writes execute zero adapter calls; accepted writes require readback; form changes invalidate scope; evidence classification is accurate |
| 6. Extension proof | `workflows/resumes/extract.ts`, `workflows/composites/campaign-to-review.ts`; registrations and refs | Second workflow added without changing generic harness; sequential campaign respects queue, grants, interrupts and one active claim |
| 7. Acceptance | Evals, test/packaging inventories, experiment report and selective cleanup | Cumulative deterministic/platform/release gates and repeated host evals pass; remaining host limits explicitly assessed before staging promotion |

Slice 5 has a concrete decision gate: demonstrate that the supported host can route browser writes and readbacks through the adapter. If it cannot, deliver the useful Store/state improvements and label browser execution as host mediated and agent attested. Do not add unsupported browser access or claim universal enforcement. Promotion scope must reflect that result.

Prefer small extractions and compatibility facades over a single tree-wide rename. Regenerate `runtime/` in every source change. Review and explicitly remove stale emitted modules when a source moves; the build rejects stale output. Update package manifests, link reachability, migration inventories, test ownership, and source-size exceptions when affected. Every scoped source file must stay within the repository's 500-line policy.

## Testing entirely within the experiment

Use `.workflows/local/agent-workflow-experiment/` for ignored fixtures, logs, and receipts. Each scenario/trial gets its own Store, broker socket namespace, resume copy, and process cleanup. Pass an explicit absent legacy-profile path during fixture bootstrap to prevent importing owner data. Never let an experimental command default to `~/.job-apply` during testing.

Compare the baseline commit and candidate using identical committed fictional inputs, model configuration, scenario definitions, and grading. Build/install each snapshot into separate temporary plugin homes. Keep source fingerprints and reject unexpected repository changes during host evals. Do not install this branch into the owner's regular plugin home for acceptance testing.

| Test layer | Required coverage |
| --- | --- |
| Pure policy | Every phase/event pair; rejected actions; stale form/input/answer revisions; completion guards; consent invalidation; retry limits |
| Store and concurrency | Concurrent proposals, duplicate delivery, journal recovery, selective writes, unrelated-data preservation, task versioning, child outcomes and parent revisions |
| Broker/protocol | Private capability stays in memory; claim exclusivity; detached lifecycle; heartbeat failure; no silent adoption/recovery; pause releases claim before waiting |
| Integration/UI | Public commands and Companion agree on state/reason codes; preserve draft edits; browser-action-required differs from missing information; compatible old clients |
| Browser synthetic | Write rejected, write accepted but value absent, upload stuck, rerender clears field, new form instance, uncertain timeout, final-action attempt denied |
| Installed artifacts | Codex and Claude packages, generated runtime parity, reachable skill refs, native lock, startup and handoff |
| Model evals | Route interpretation, user corrections, question count, tool choice, evidence claims, latency and action count, final stored outcome |

Required scenario set: exact-job happy path; ambiguous resume choice; repeated user reply; stale fact revision mid-attempt; authority revoked while paused; known answer with inaccessible control; failed upload; form replacement; missing answer then resume; sensitive-answer revision change; explicit task switch/cancel; expired claim/broker loss; review restart; forbidden final action; extraction draft review; two-job campaign interrupted between jobs.

For acceptance, repeat each model scenario three times using the same recorded available model and reasoning configuration on baseline and candidate. Use separate equivalent stores and report counts and distributions; never substitute a single successful transcript for a repeatability claim. Synthetic browser results establish local protocol behavior. A supervised visible-browser test is a distinct evidence lane and requires the repository's explicit opt-in if it affects the owner's browser.

Must-pass conditions: zero forbidden final actions, zero stale/unauthorized accepted transitions, no secret/applicant-value leakage in receipts, correct stored outcome, no duplicate writes on replay, no abandoned live claim when asking for input, and no stronger user-facing success claim than the evidence supports. Questions must correspond to unresolved information or newly required scope; unchanged approved scope should not trigger another approval request. Report latency and tool-count differences without assuming they improve.

Run the existing gates from this worktree:

```bash
npm ci
npm run build:runtime
npm run test:affected -- --base origin/staging
npm run build:check
npm run audit:core-workflows
npm run test:release
```

For slice PRs, also select tests against their actual integration base. Current test-matrix global paths include `src/**` and `runtime/**`, so source changes currently select the full deterministic tier even through `test:affected`; do not promise cheap narrow gates or weaken that policy as part of this experiment. Run applicable platform checks for native/broker changes and final acceptance. Release checks are mandatory for skill/runtime/packaging changes. Keep the existing commit/push hooks.

`npm run test:agent-local` is the existing synthetic installed-host test and requires a usable authenticated host. Extend it or add scenario drivers under the same isolation contract; do not treat a docs/static check as an executed agent trial. Respect that this consumes model capacity and record skipped/blocked lanes accurately.

Before every PR, run the repository-required `codex-pr-review-toolkit:review-pull-request` branch review against the intended base, resolve validated findings, and repeat affected checks after fixes. Record baseline failures as red until resolved; do not relax checks or rewrite historical evidence to obtain a pass.

## Promotion and rollback

The final experiment report must answer: did redundant clarification decrease, did continuation improve, did state violations stay at zero, can the same invariants be exercised without an LLM, can a second workflow be added through registration, and which browser guarantees remain host dependent?

Promote only the proven scope through a reviewed PR from the experiment to staging. Remove temporary facades only when all public callers and installed-package checks cover their replacements. Version any new task metadata and define unsupported-version behavior before shipping. A rollback must stop experiment processes, retain any required redacted evidence, and return to the prior package without a mixed writer or live incompatible task; test this with disposable stores before promotion.

This planning pass verifies the branch, file inventory, and documentation. The runtime baseline, model comparisons, browser experiments, and release acceptance above are planned work, not completed evidence.

## Planning verification receipt

On 2026-10-07, `npm ci` completed in the experiment worktree. All 380 cataloged source paths and 236 emitted counterparts exist; the new Markdown links, fences and whitespace checks passed.

The required affected run selected ten suites. Nine passed: Companion TypeScript, runtime TypeScript, runtime foundation, test-matrix policy, core-workflow audit, source size, Python fast tests, Node runner fast tests, and documentation links. `migration-inventory` rejected the uncommitted plan files with `Historical audit requires a clean current snapshot`, so the aggregate affected gate remains red for this draft.

To check the cause, the plan files were temporarily held in the ignored experiment directory and restored afterward. The unchanged, clean staging base passed `npm run check:migration` with `inventory-consistent` and no errors. This confirms the clean-snapshot requirement; it does not turn the draft's aggregate gate green. Recheck the committed plan through the existing commit/push workflow before an implementation PR.

Local receipts/logs are under `.workflows/local/agent-workflow-experiment/`: `planning-checks-with-dependencies.json`, `planning-checks-with-dependencies.log`, and `clean-base-migration.log`. No product code, skills, installed plugin, or canonical applicant Store was changed.
