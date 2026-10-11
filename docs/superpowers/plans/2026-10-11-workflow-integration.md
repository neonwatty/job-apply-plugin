# Browser-Capable Host Integration Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development with isolated worktrees. Steps use checkbox tracking.

**Goal:** Deliver an experimental Codex workflow that uses existing host browser tools and code-managed checkpoints.

**Architecture:** Extend the current attempt broker with explicitly attested context/report operations, teach the experimental skill route to use them, and verify actual host-tool execution on instrumented fictional pages. No new persistence engine, browser runtime, or private operator launcher.

**Tech Stack:** TypeScript/ESM, existing attempt broker/native Store, Node test runner, Codex host browser tools.

**Spec:** [Browser-capable host design](../specs/2026-10-11-workflow-browser-capable-host-design.md).

## Global Constraints

- Use Codex's existing browser tools. No restricted CLI transport or replacement browser tool is the product host.
- Fictional explicit Store, native-lock paths and controlled loopback pages only; no owner browser/Store, ATS, final submission or staging promotion.
- Report evidence is `agent_attested`; it never creates trusted adapter verification or authenticated human approval.
- Keep existing exact-revision, source, claim, replay and safe-handoff guards. Code owns durable state, not arbitrary host browser actions.
- Source/test/runtime files stay within 500 physical lines; generated runtime matches TypeScript.
- Workers are not alone, may edit only allowed_files and must not revert others. Parent owns integration, registry changes, review and publication.

## Review Focus

- Report replay must not imply a second browser write (H1/E1).
- Current claim/input state, not historical receipts, gates continued work (H1).
- Browser uncertainty must survive handoff without fabricated readiness (H1/S1/E1).
- No fallback from trusted-host rejection to legacy attestation (S1).
- Agent assertions cannot serve as the independent page oracle (E1/I2).

## Parallel packages

| Lane | Plan | Ownership |
| --- | --- | --- |
| Host protocol | [H1](2026-10-11-workflow-host-protocol.md) | New report/guidance helpers; existing attempt CLI/broker; dedicated tests |
| Browser-aware skills | [S1](2026-10-11-workflow-browser-controls.md) | Experimental entry/ref, host-browser guide and routing docs |
| Host acceptance | [E1](2026-10-11-workflow-evaluation.md) | Instrumented page fixture, installed workflow harness and grading tests |

All three start in managed worktrees from f9c8958a; use these updated plan files
from the integration worktree as authoritative briefs. Protocol command names and
report shape below are frozen before dispatch. Parent integrates explicit owned
files and builds runtime; workers do not push or publish independently.

## Shared contract

Commands: `workflow attempt host-browser-context [--job-id ID]` and
`workflow attempt host-browser-report --input /absolute/report.json`, using
existing required `--root` and `--native-lock` and existing attempt server.

Report: `{operationId,taskId,expectedRevision,jobId,jobRevision,
evidenceKind:'agent_attested',outcome:'progress'|'needs_info',session}`.
Needs Info may use `savedSessionFingerprint` instead of session. Revisions are
canonical decimal strings. All variable fields must affect the normalized
existing claim event fingerprint. No acquire/recover/approval/final-review action
is exposed by report. Existing attempt event descriptors govern those workflows.

Result: `{evidenceKind:'agent_attested',persistenceScope:'attempt_checkpoint',
replayScope:'report_recording_only',receipt,replayed}`. Provenance refers to the
submitted report, not historical session content or independently verified DOM.

Context retains canonical task/broker/guidance and adds `hostBrowser`:
`{toolSource:'host_existing',evidenceKind:'agent_attested',
nextStep:'observe_and_act'|'inspect_and_handoff'|'resolve_workflow',
reportOutcomes:('progress'|'needs_info')[],replayScope:'report_recording_only'}`.
Only current owned claim plus allowed progress yields observe_and_act. Safe-exit
only yields inspect_and_handoff; all other cases resolve_workflow. Expose no
browser selectors/values or fabricated observations. Templates remain advisory.

## I1: Plan and contract checkpoint

- [ ] Record user correction and replace all active lane plans; retain prior terminal plan as superseded history.
- [ ] Dispatch three workers with exact allowed_files and these contracts; record their worktrees and decisions in the local ledger.
- [ ] Integrate each result only after focused checks and independent task review; resolve findings with its owner. Parent updates matrix/package inventories only when needed.

## I2: Combined acceptance and evidence

- [ ] Build runtime and run host protocol, installed harness and existing attempt-guidance/recovery tests. Verify size, matrix, types and generated parity.
- [ ] Run nine actual host-browser trials: three each of controls-handoff, uncertain-resume, stale-report. Use a fresh fictional Store/page per trial; keep one live browser owner and perform trials serially.
- [ ] In this Codex session, use only exposed host browser tools for page interaction. Inspect visible UI before acting, execute canonical commands through the installed plugin, and record actual tool identifiers and outcomes. Do not use a Node/Playwright script to substitute for host-browser evidence.
- [ ] Compare independently captured page values/write counts/final-submit count with canonical Store state. Keep all failures and unavailable outcomes; no relabeling fixture-only tests as real host evidence. Do not assign human UX scores or claim nine independent model conversations.
- [ ] For uncertain-resume, reread canonical context and current DOM after interruption between a write and its report; no blind repeat. For stale-report, reject a new-ID old-revision report and exact-replay the original report without another browser action.
- [ ] Preserve traces under ignored private evidence directories with exact candidate revision. Actual browser actions occur only on this task's newly created loopback tabs.

## I3: Final verification and publication

- [ ] Review against `origin/codex/agent-workflows-21-process-approval-model` with the repository review toolkit; validate/fix findings and rerun affected checks.
- [ ] Run affected selection against staging and actual PR base, normal deep/release gates under qaHostEnvironment, and ordinary commit/push hooks. Preserve red evidence and compare unexpected failures against clean base.
- [ ] Update experimental progress and reports to distinguish deterministic checks, actual host-browser trials, agent attestation and unverified other-host support.
- [ ] Create one experimental PR stacked on #212 after required gates pass; attach it to the chat. No merge/staging promotion.

## Execution authorization

The user explicitly requested updating all three plans and continuing. Proceed
with the selected parallel method without another plan-approval interruption.
