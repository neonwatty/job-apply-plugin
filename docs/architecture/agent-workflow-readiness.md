# Agent workflow readiness audit

## Workday control hardening — 2026-10-15

Implemented a value-free `performVerifiedFieldEntry` helper that separates
write exceptions from readback exceptions. Observation failure never triggers
another write; only a current, same-scope mismatch can use a remaining alternate.
The worker had invoked unsupported Codex locator `inputValue()` inside the same
try/catch as writing, conflating verification failure with entry failure. The
updated references require documented host APIs, per-field verification, and
preservation of consumed retry budgets.

The Codex in-app browser exercised `evals/workflows/workday-controls-page.mjs`,
a fictional loopback form with numeric month/year steppers replaced on blur,
a removable incorrect selection pill, a searchable replacement option, an
unrelated draft note, and a submission-attempt counter. AX `setValue` followed
by Tab and fresh observation corrected the invalid year, changed month while
preserving year, and filled the education year. The incorrect pill was removed
through its visible button and the intended option selected. The new helper
verified the role description. Save and Continue reached fictional manual review;
the unrelated note stayed intact and the submission counter remained zero.
This is host-browser fixture evidence, not a replica of Workday internals or
proof that the live tenant accepts the same technique.

Ten focused verification tests passed, including the requirement that every
date segment and its associated validation state must agree. Candidate
`5223737f` passed 11 commit-hook suites and both final release suites. The
migration audit initially rejected the dirty snapshot and passed after commit.
All 882 installed package files matched the candidate (550 critical files).
The serialized affected run completed with 25 of 26 suites passing; its sole
failure was the pre-commit dirty-snapshot migration audit, resolved by the clean
post-commit rerun. The workspace suite passed 2,421 tests, skipped 27, and failed
none. The original affected receipt remains marked failed rather than rewritten;
the separate successful migration rerun supplies the resolved gate evidence.
The owner-authorized live retry used the existing draft and owner-workflow
broker. Fresh AX indices, setValue, Tab, and immediate readback verified Work
Experience 2 From and To date groups, Role Description, and Education To year.
The incorrect Field of Study selection was removed; no exact supported option
was visible, so this optional field was left blank under the owner's authority.
One Save and Continue attempt remained on My Experience and returned generic
Workday page errors. Owner recovery returned `pause_preserve_draft` with no retry
reserved. The worker did not refresh or click Save again. The guarded Needs Info
handoff succeeded at job revision 46 and released the claim.

This validates live date/control correction and conservative verification, not
Workday save completion. Manual review remains unvalidated. The next separate
issue is the opaque save/session failure, subject to existing durable recovery
budgets and preserved-draft rules. All drafts remain preserved; final submission
was untouched. No budget was reset to obtain another attempt.

## Dedicated application pilot follow-up — 2026-10-15

Candidate `7cd56196` was installed and enabled; the coordinator compared all 881
packaged files with the installed copy and found no mismatches. A dedicated
`gpt-6-luna` desktop chat was launched with the saved application-model choice.
Chrome discovery failed before tab access while browser feature-gate loading
received a Cloudflare response. The owner switched this pilot to the Codex
in-app browser. The dedicated chat could use that browser but had no original
chat tabs; it subsequently observed a Not Submitted application in Candidate
Home after owner sign-in. This does not establish cross-chat draft transfer.

The worker reached My Experience and reported an accepted resume widget and
completed My Information. These are host observations, not proof of current
full-form readiness or complete server persistence. The worker used ordinary
`attempt start/progress/handoff` for that filling pass despite the intended
experimental owner route. The pass therefore does **not** validate the new
owner broker or durable retry reservations. Its Needs Info handoff succeeded
and released the claim. No final submission was performed.

### Improvement backlog from supervised inspection

- **Route consistency:** preserve the explicit experimental route through
  preparation and reacquisition; detect or prevent silent fallback to ordinary
  attempt commands. Acceptance should verify the actual broker used.
- **Partial continuation:** distinguish generic read-only Needs Info guidance
  from an actual preparation rejection. Permit supported independent work
  while preserving unresolved manual controls; never claim they were resolved
  just to reselect a job. This pilot exercised guarded selection and owner-broker
  reacquisition while retaining the unresolved manual-control checkpoint.
- **Workday dates:** a split start-year control lost focus during normal fill
  and the bounded alternate. Test segment-specific entry and immediate readback
  in a fictional fixture; keep consumed retries consumed on the live draft.
- **Verification discipline:** avoid batching writes across rerendering controls.
  A current Field of Study selection was reported inconsistent with confirmed
  facts. Correct only from fresh same-control evidence and approved facts.
- **Consolidated handoff:** inventory all unresolved fields and their requiredness
  before pausing. Optional unknowns may remain blank; mandatory unknowns or
  unsupported controls must remain explicit blockers, never invented values.
- **Protocol usability:** the worker misdiagnosed unsupported top-level `--help`
  as Store initialization failure and initially used incorrect AX click argument
  shapes. Improve route-specific command guidance and error attribution.

### Bounded continuation outcome

Guarded exact-revision selection succeeded at revision 41, followed by owner
broker reacquisition for the same draft. The worker could not verify any new
entries during this continuation. Workday displayed Invalid Date for Work
Experience 2 → From; Save and Continue was left untouched. The owner workflow
recorded six browser-control items, returned Needs Info at revision 43, and
released the claim. This validates preparation and a bounded owner handoff in
this case, not successful field recovery or end-to-end owner-only execution.

Remaining controls from the worker's handoff:

- Work Experience 2 → From year: visible validation blocker.
- Work Experience 2 → To month/year: entry failed; requiredness unresolved.
- Work Experience 2 → Role Description: entry not verified; page marks optional.
- Education → Field of Study: existing selection conflicts with confirmed facts;
  replacement failed; page marks optional. Optionality does not make a wrong
  existing value acceptable for final review.
- Education → To year: entry failed; requiredness unresolved.

Unknown optional GPA, Skills, and Twitter were left blank. Known facts need not
be requested again: these failures concern browser interaction and verification.
The next engineering target is a fictional Workday fixture covering split-date
steppers and selection pills, with immediate readback and durable retry limits.
The live draft needs a consolidated manual correction before continuation.

Workday manual-review completion remains unvalidated; no unsupported field is
counted as complete. Applicant values and browser identifiers are excluded from
this report. Existing drafts and manual final submission remain preserved.

## Prior acceptance assessment — 2026-10-15: Workday hardening

**Continue supervised experimental dogfooding; Workday manual-review completion
remains unvalidated.** The Capital One pilot advanced through questionnaires but
encountered a next-page failure. One owner-approved refresh returned to sign-in;
retained draft data was not confirmed. Do not count this as a completed pilot.
All final submission remains manual. No live drafts were changed by this pass.

### What this round established

- Workday automatic Primary attachment succeeded in this pilot.
- Custom date controls needed manual correction after bounded entry attempts.
- Opaque save errors gave no actionable field diagnosis. A separate-tab sign-in
  followed by retry advanced the original page; a header email was insufficient
  evidence of session health.
- Repeated single-question pauses created avoidable interaction overhead.
- Page advancement did not prove server persistence. Empty Candidate Home did
  not establish draft loss; refresh did not establish successful recovery.

### Durable recovery implementation

Workday policy lives in `src/workflows/applications/workday-recovery.ts`, behind
shared typed recovery contracts. `owner-workflow recovery` computes decisions
inside the claim-owning broker. The canonical `jobs.json` metadata now holds a
value-free `atsRecovery` ledger: broker-generated draft identities, independent
recovery revisions, three retry counters, and bounded idempotency receipts.
Counters and receipts commit together through one atomic Store write.

- One authenticated Save retry, one post-sign-in retry and one approved refresh
  are available per registered draft. Callers cannot supply counter values.
- Sign-in, claim handoff/reacquisition and broker restart preserve counters.
  Missing history pauses; initialization/reset requires exact current state and
  explicit fresh-draft approval. Fresh draft identity is generated by the broker.
- Reservation checks include live claim ownership, task/job/recovery revisions,
  canonical input scope, profile access and managed-resume preflight.
- Published reservations remain consumed after response loss or process death.
  Receipt replay returns `actionReserved: false`; it cannot reserve another retry.
- Paused-job recovery context exposes counters read-only. Session checkpoints,
  applicant facts, resumes and unrelated jobs are preserved.
- The ledger fails closed on corruption/capacity (32 receipts per job, 256 jobs)
  rather than evicting history or silently resetting counters.

Page intake still batches unresolved questions without inferring consent or
answers. Progress labels distinguish entered, verified, page-advanced and
persistence-confirmed observations. The Companion preview delegates to the same
typed policy; it is not a durable reservation. Other ATSs pause until a specific
policy is implemented.

**Enforcement limit:** counters and reservation decisions are now code-managed
and durable. Browser observations, draft identity correspondence and owner-event
attestations still come from the host agent. The plugin does not intercept every
host browser tool call or independently authenticate the human reply. Ordinary
consent, current-form verification and manual final submission remain required.
No live follow-up or installed-owner activation was performed in this pass.

### Acceptance evidence

- The earlier hardening candidate's serialized workspace suite passed: 2,402
  passed, 27 skipped, zero failures, 735 seconds (below its 900-second limit).
- Its aggregate run exposed the historical audit's clean-checkout requirement.
  Local checkpoint `28c90412` passed all 11 commit-hook suites; the clean migration
  audit then passed. No timeout or assertion defect reproduced in that run.
- Durable recovery focused acceptance: 34 tests passed, including native
  reservation/replay, concurrent/stale rejection, input and file drift, explicit
  fresh-draft approval, installed owner CLI, paused context, broker replacement,
  and SIGKILL before/after publication. No live Store or browser draft was used.
- Updated `npm run test:release`: both suites passed, including isolated
  Codex/Claude installation, upgrade parity and packaged browser/CLI journeys.
- Final clean serialized candidate gate passed: all 26 suites, including the
  historical migration audit, on `b9d4fe991bbcc1ade9709f6a35bc8780ebd298a2`
  against `origin/staging` (`f95b4947453ad6c6abc9cc0e81c3e443706d4714`).
  Command: `npm run test:affected -- --base origin/staging --concurrency 1`.
  Workspace results: 2,415 passed, 27 skipped, zero failures in 666 seconds.
  Visible-owner-browser checks retain their explicit opt-in and were not run.
- Source-size, test-matrix and whitespace checks passed. Both implementation
  checkpoints passed the normal commit hooks. This report update records the
  completed candidate gates; activation and a live Workday completion pilot
  remain separate follow-up work.

The next product validation remains a supervised Workday completion pilot.
Synthetic acceptance does not establish live Workday manual-review completion.


## Prior supervised dogfood assessment — 2026-10-14

**Decision: ready to begin regular, supervised selected-job dogfooding in one
owning Codex desktop chat per application.** This is an experimental opt-in
scope, with manual attachment when necessary and owner-only final submission.
It is not staging promotion, ordinary-route replacement, unattended operation,
or a claim of general ATS reliability.

Runtime candidate: `a8adbb19f513838a9598ac47e65efaf080e8044c` on
`codex/experimental-agent-workflows`, installed as the paused-recovery candidate.
The earlier PR #222 baseline below is historical. Subsequent changes added
same-chat recovery guidance, Companion guidance, and read-only recovery context
for paused jobs. This report update changes documentation only.

### What the continuation pilots validated

| Boundary | Observed result | Evidence limit |
| --- | --- | --- |
| Partial draft pause | Fictional and live forms retained entered fields across a durable Needs Info handoff; the claim was released and the owned broker exited | Controlled pause, not browser-process death |
| Recovery before acquisition | Read-only recovery context exposed the paused checkpoint without acquiring; the helper required canonical preparation; exact-revision selection and a fresh owner attempt succeeded | Same owning chat and surviving form only; fresh-chat browser transfer remains unsupported |
| No duplicate entry | Previously entered contact fields were inspected and reused without retyping, navigation or reload | Host-tool trace and agent observation; no independent live page write counter |
| Manual attachment | Embedded SentinelOne upload produced no chooser event. The ATS then showed an accepted attachment; code required exact-draft Primary confirmation, saved Needs Info and released the claim before waiting | Automatic embedded upload remains unreliable; filename or chooser timeout alone did not establish identity |
| Current field verification | Current visual comparisons verified masked contact fields and approved saved-answer selections; masking did not trigger repair | Agent-attested comparisons, not independently authenticated browser evidence |
| Review completion | Fresh current-attempt inventory covered 17 logical controls, including 12 required controls. All seven readiness assertions passed; durable awaiting_review accepted and claim absent afterward | One live SentinelOne form; optional preferred name, cover letter and voluntary demographics stayed blank |
| Submission and preservation | No final-action activation; original Reddit and older SentinelOne drafts were not edited, navigated or reloaded and were marked for handoff | Live preservation is scoped host evidence, not a durable browser backup |

The fictional Codex-host pilot reached review with one upload attempt, one
accepted upload and **zero submission attempts** measured by its local server.
Its email value was host-masked: nonempty validity, server validation and no
re-entry were observed, but exact-text comparison was not established. The live
pilot used fresh visual comparisons instead. Neither trial exercised browser
reload/loss or a separate chat resuming the browser draft.

The live sequence was: partial entry → Needs Info → read-only recovery →
canonical selection → fresh owner attempt → remaining fields → attachment
identity pause → owner confirmation → canonical selection → fresh observation
and readiness → awaiting_review. Final review used attempt revision 27 and
committed job revision 28; the broker exited successfully and read-only context
confirmed no claim. The final action stayed manual throughout.

### Evidence retained locally

The private receipt directory is
`~/.codex/dogfood-packages/same-chat-continuation-pilot/`:

- `receipt.json`: fictional readiness, terminal report and server counters.
- `notes.md`: fixture setup, limitations and live approval scope.
- `live-receipt.json`: live attachment-identity pause and its code decision.
- `live-review-receipt.json`: accepted final live report and readiness assertions.

These are local evidence references, not portable checked-in fixtures. This
report intentionally omits applicant values, resume paths and browser identities.
Prior candidate gate receipts remain historical; this documentation update does
not claim a new release run. The host/model still interprets pages, selects tools,
and supplies honest observations and consent attestations. Code owns canonical
state, input/revision binding, claims, allowed recorded transitions and readiness
recomputation; it does not intercept every arbitrary host browser action.

### What remains and what to tackle next

1. **Repeat the supported workflow in normal use.** Run a small series of
   separately approved selected-job applications in their owning chats. Record
   pauses, owner interventions, upload failures, stale-form cases and review
   outcomes. One successful live continuation closes this specific acceptance
   gap, but does not establish repeatability or improved everyday UX.
2. **Reduce observed integration friction.** The pilot's temporary command client
   initially put `--root` in the wrong position for different command families;
   calls were rejected and corrected. One readiness packet used an unsupported
   capability enum and was rejected before handoff. Prefer documented shared
   command/packet construction over rebuilding these adapters in each chat.
   Treat these as agent-side composition friction, not demonstrated Store defects.
3. **Keep manual attachment a supported stop.** No automatic retry or permission
   workaround is justified by a missing chooser event. Preserve the draft,
   release the claim, obtain selected-resume confirmation and reobserve acceptance.
   Automatic cross-origin chooser reliability is desirable, not a prerequisite
   for accurately labeled supervised dogfooding.
4. **Keep recovery limits explicit.** Same-chat continuation is the supported
   path. Missing or lost browser drafts require a separately approved fresh
   attempt; durable Store recovery does not recreate the browser. Prior isolated
   expiry/crash evidence is separate from this controlled continuation pilot.
5. **Make promotion a separate decision.** Before wider rollout or ordinary-route
   adoption, identify the exact candidate, run applicable integration/release and
   review gates, retain receipts, and declare supported hosts and finite-ledger
   limits. Cross-platform live coverage, broad ATS coverage, archival pressure
   and authenticated host approval are not established by this pilot.

No further generic state-machine redesign is required before the next bounded
supervised run. The next practical step is repeated use with recorded friction;
fix observed blockers before expanding the supported scope. All drafts remain
preserved and final submission remains with the owner.

## Historical consolidation baseline — 2026-10-13

Integration target: `codex/experimental-agent-workflows`. The cumulative runtime
candidate is PR #222, commit `5d8c5df40a742f2511092016454ea1967eae24b2`.
The integration branch advances from `3753b6912f64755b6233469f10d467993ad4a34b`
by fast-forward, retaining the original commits for PRs #193–#222. No squash,
rebase, runtime change, Store migration, or staging promotion is part of this
consolidation. Future fixes should target this experimental branch directly.

### Implemented and supported scope

Code owns proposal validation, canonical task and input bindings, exclusive
claims, revision conflicts, durable checkpoints, receipt replay, pause/recovery,
and guarded handoff. The installed owner opt-in route now supports selected-job
applications through manual review. PRs #216–#222 add owner activation, upload
composition, pinned packaging, bounded upload attempts, manual attachment,
reviewed-job restart, picker guidance and masked-field verification.

The host agent still interprets pages, chooses controls, invokes existing browser
tools and attests observations and user input. Accepted reports are
`agent_attested`; they do not independently prove browser state or enforce policy
over arbitrary host tools. Masked readback cannot establish a mismatch or justify
retyping. Current scoped evidence is required for readiness. Final submission
remains manual. Extraction, campaigns, protected approval embedding and archival
have narrower fixture/contract evidence; live selected-job pilots do not validate
all those capabilities or replace the ordinary application route.

### Evidence and limitations

- Reddit and SentinelOne supervised pilots reached recorded manual-review
  handoffs. SentinelOne exercised guarded owner restart and manual attachment.
- PR #222 recorded 29 passing deep suites, both release suites, normal hooks and
  native plus independent reviews. These are historical candidate results;
  consolidation gates are recorded separately in the integration receipt.
- A fresh desktop chat discovered the exact candidate: all 864 installed files
  matched. It recovered SentinelOne at `awaiting_review` revision 17 without a
  claim and verified the selected run/resume binding.
- Exact unchanged original-report lookup returned a finished historical owner
  task (revision 2), `replayed: true`, `replayScope: report_recording_only`.
  This establishes historical completion, not current ledger/browser inspection.
- The fresh chat exposed no prior browser tabs. Original-draft visibility and
  current browser readiness were not verified. Interrupted live-claim recovery
  was not exercised in that real pilot; isolated recovery tests are separate.
- Improved everyday UX, general ATS coverage and cross-platform live acceptance
  are not established. Earlier paired evaluations had mixed outcomes.

### Remaining acceptance work

1. Retain a cumulative integration-gate receipt for the consolidated candidate.
2. Establish an explicit fresh-chat browser handoff with current observations;
   stored state recovery alone does not recover a browser draft.
3. Exercise interrupted live-claim recovery under a separately authorized,
   isolated pilot, preserving unrelated drafts and distinguishing lost drafts
   from recoverable checkpoints.
4. Repeat bounded supervised applications and fix observed failures. Record
   friction and unsupported cases before claiming improved UX.
5. Decide ordinary-route adoption and staging promotion separately. Preserve
   finite-ledger capacity and compatibility limits; installing an older reader
   is not a Store-format rollback.

All existing application drafts remain untouched during consolidation. No live
browser, applicant Store mutation, new application or final submission is needed
for the integration gates.

## Historical audit at PR #214

The remainder records the earlier baseline. Its future-tense owner-route and
pilot requirements are superseded by the current status above; its architecture
map and evidence distinctions remain useful historical context.

Audit updated: 2026-10-12. Source baseline: PR #214,
`b7fb790129ab0086d78bd21a959208bdd05bc91a`. This is a cumulative source and
evidence audit, not a review or acceptance result for unfinished expiry/drift work.
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
was inspected. It identifies PR #213 at `fd5b18146ccf2a08a52ec7c346ba4e5654e0ca22`, and reports
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
observations for promotion.

The [PR #214 body](https://github.com/neonwatty/job-apply-plugin/pull/214), retrieved
on 2026-10-12, identifies the baseline above and reports six passing final-candidate
native host trials: three fresh no-history subagents, coordinator binding reset,
tab reconstruction and broker SIGKILL. It reports 34 integrated checks, the commit
gate, branch review, 28 passing deep suites with Windows skipped, installed release
checks and fresh native pre-push checks. The named private slice 23 readiness
receipt was unavailable; these are reported outcomes, not independently replayed
evidence in this audit. Fresh subagents are not separate desktop conversations;
cross-agent draft transfer remains unverified. Binding reset is not browser-process
failure. A live unowned claim blocked safely; actual expired recovery was not
established. Trace indices remain agent-authored and human UX metrics null.

Actual original-lease expiry recovery and changed-input safe-exit evidence for
the current workstream remain pending integration verification. Do not mark the
loss-boundary checklist complete from the PR #214 broker-loss result alone.

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

1. Finish the scoped actual-expiry and changed-input packages, then integrate
   their exact receipts and limitations. Fix observed failures; do not expand
   to additional ATS families as a substitute for closing these cases.
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

For real selected-job owner dogfood after these recovery gates, the
[minimum dogfood assessment](agent-workflow-dogfood-readiness.md) scopes two
implementation slices: explicit installed owner opt-in, then complete managed
upload/current-readiness/manual-review composition. Release verification and an
explicitly authorized supervised pilot follow. The present fictional route does
not satisfy those owner-route gates. Further fixes depend on observed failures;
a generic runner or authenticated host channel is not a prerequisite for the
declared agent-attested pilot.
