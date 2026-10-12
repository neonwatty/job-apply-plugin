# Minimum path to selected-job owner dogfood

Assessment date: 2026-10-12. Source baseline: PR #214,
`b7fb790129ab0086d78bd21a959208bdd05bc91a`. This scopes future work; it does
not authorize owner Store access or establish staging readiness. Actual expiry
and changed-input acceptance for the current fictional workstream remain pending
integration verification.

## Usable experiment versus owner application

Explicit fictional trials can use code-owned preparation, claims, durable
checkpoints, replay and guarded handoff through the installed plugin.
`src/app/preparation-workflow.ts`, `claim-workflow.ts` and
`src/workflows/applications/attempt.ts` implement those transitions. Existing
host browser tools operate controlled loopback forms. Reports remain
`agent_attested`; page interpretation, control choice and truthful current
observations remain host/model responsibilities.

Ordinary applications still take a separate route in `skills/job-apply/SKILL.md`.
`src/cli/experimental-workflow.ts` and `experimental-claim-workflow.ts` require
synthetic Store markers, an absolute root and native-lock artifact.
`apps/companion/command.mjs` dispatches `workflow` before ordinary Store
activation. Removing a fixture check alone does not provide an owner route.

## Finite remaining work

After verified expiry/drift acceptance, the minimum is **two implementation
slices, then release verification and a supervised pilot**. Additional fixes
should address observed failures, not a speculative architecture checklist.

| Slice | Deliverable | Acceptance boundary |
| --- | --- | --- |
| 1. Explicit owner opt-in | Installed route for one exact selected job in a current application run with a confirmed managed resume; deliberate Store activation, native lock and owned broker lifecycle; continuation and safe exit | Recheck run/resume/fact revisions. Reuse ordinary account, sensitive-answer and live-form consent rules. Keep fixture routing isolated and ordinary opt-out behavior available. Broker loss and changed inputs expose guarded recovery/handoff. |
| 2. Upload through manual review | Compose managed-resume resolution/upload guard, accepted-file observation, complete current-form readiness and existing guarded `awaiting_review` transition | Installed native host evidence shows accepted managed upload, complete required controls, recomputed current readiness, released claim, durable Companion handoff and preserved visible review page. Zero final-action attempts. |
| Release and pilot | Final-candidate checks, branch review and one explicitly authorized real selected-job application through visible manual review | Record installed revision, scoped consent, upload/readiness/handoff outcomes and blockers. Preserve unrelated facts and drafts. Owner submits manually; fix observed failures before expanding. |

The smallest pilot begins with an existing saved job, active run and confirmed
managed resume. Discovery, extraction onboarding, campaigns and broad ATS support
need not be added. Opt-in is not broader fill consent. Ordinary fallback is an
opt-out route, not permission to switch protocols while a workflow claim is active.

## Reuse the completion contract

`src/workflows/applications/attempt.ts` already accepts `handoff` with
`status: awaiting_review`; `attempt-session.ts` decodes its readiness packet.
`skills/job-apply/references/application.md` and `readiness.md` specify managed
resume identity, `apps/companion/resume-upload-guard.mjs`, complete live control
inventory, accepted upload and Store-recomputed current-attempt readiness.
Compose and verify these contracts rather than create a second readiness model.

`src/workflows/applications/host-browser-report.ts` exposes only progress and
Needs Info. `skills/job-apply/references/host-browser-workflow.md` directs final
review through the existing guarded handoff. A progress receipt, historical
checkpoint or report replay cannot replace current upload and review evidence.
Fictional trials ending at missing upload do not close this acceptance gap.

## Persistence and rollback choice

Choose the supported persistence horizon in slice 1. An initial bounded pilot
can retain v1 rather than automatically activate archival. Capacity exhaustion
must preserve history and provide safe handoff, not delete receipts to make room.
`src/contracts/workspace/workflow-tasks.ts` and `src/app/claim-workflow.ts` define
the finite ledger and acceptance reserves.

If enabling v2, provide explicit owner activation and declared reader
compatibility. `src/cli/experimental-archive.ts` currently restricts activation
to fixtures. [Durable archival](durable-workflow-archive.md) has at most 32
segments and a finite receipt horizon; older readers reject v2. Installing an
older runtime is not a rollback. Backup/restore must preserve jobs metadata and
every referenced archive segment together. Indefinite retention and a new
archive index are unnecessary for a bounded pilot.

## Evidence and stop point

The [PR #214 body](https://github.com/neonwatty/job-apply-plugin/pull/214), retrieved
for this assessment, reports six passing final-candidate native host trials:
three fresh no-history subagents, binding reset, tab reconstruction and broker
SIGKILL. It reports 34 integrated checks, the normal commit gate, branch review,
28 passing deep suites with Windows skipped, installed release checks and fresh
native pre-push checks. These are reported outcomes, not independently replayed
results here: the named private readiness receipt was unavailable.

Fresh subagents are not separate desktop conversations; existing draft transfer
between agents remains unverified. Binding reset is not browser-process failure.
Broker death with a live claim blocks safely rather than establishing expired
recovery. Trace indices are agent-authored and human UX metrics remain null.
Actual original-lease expiry and changed inputs are this workstream's pending
evidence, not completed pilot gates.

Before an owner pilot, satisfy the applicable [readiness checklist](agent-workflow-readiness.md)
against the final candidate: affected checks, source-size checks, installed
Codex/Claude release checks and required branch review. Declare the supported
host/platform and retain skipped-platform limits. The pilot needs explicit
owner authorization for the exact live application; this document grants none.

Once the two slices and bounded pilot pass, assess the observed result. A generic
recursive runner, authenticated stock-host approval channel, fully mediated live
ATS adapter, unlimited archival and replacement model runtime are separate
capabilities. They are unnecessary for an accurately labeled agent-attested
selected-job pilot and must not be implied by its success.
