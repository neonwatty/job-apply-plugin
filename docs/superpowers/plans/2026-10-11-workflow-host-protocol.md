# Host Browser Protocol Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development with isolated worktrees. Steps use checkbox tracking.

**Goal:** Expose code-generated host-browser guidance and bounded durable reports through the existing attempt broker.

**Architecture:** Parse a closed attested report into existing progress/Needs Info claim events; let ClaimWorkflow enforce canonical guards and replay. Return explicit report-only provenance. Preserve all existing broker commands.

**Tech Stack:** TypeScript, generated ESM runtime, native fixture Store and Node tests.

**Spec:** [Browser-capable host design](../specs/2026-10-11-workflow-browser-capable-host-design.md).

## Global Constraints

- Use Codex's existing browser tools. No restricted CLI transport or replacement browser tool is the product host.
- Fictional explicit Store, native-lock paths and controlled loopback pages only; no owner browser/Store, ATS, final submission or staging promotion.
- Report evidence is `agent_attested`; it never creates trusted adapter verification or authenticated human approval.
- Keep existing exact-revision, source, claim, replay and safe-handoff guards. Code owns durable state, not arbitrary host browser actions.
- Source/test/runtime files stay within 500 physical lines; generated runtime matches TypeScript.
- Workers are not alone, may edit only allowed_files and must not revert others. Parent owns integration, registry changes, review and publication.

## Review Focus

- Changed payload using old operation ID conflicts; exact replay changes no state.
- New-ID stale revision fails; replacement broker cannot regain claim from a receipt.
- Drift/revocation suppresses action guidance but preserves legitimate safe exits.
- Pending fields are preserved via existing saved-session fingerprint.
- Unknown/trusted/awaiting-review reports are rejected before mutation.

## H1: Broker context and report

**allowed_files:** create `src/workflows/applications/host-browser-report.ts`,
`src/app/host-browser-guidance.ts`; modify
`src/integrations/host/claim-broker.ts`, `src/cli/experimental-claim-workflow.ts`;
matching runtime modules; create `tests_js/workspace_host_browser_protocol.test.mjs`
and `tests_js/workspace_host_browser_protocol_cli.test.mjs`.
Do not edit shared Store schemas, ClaimWorkflow or parent matrix without reporting
an actual dependency first.

**Interfaces:** consume the exact report/context/result shapes in the integration
plan. Export `hostBrowserReport(raw:unknown)` returning a parsed existing
ClaimEvent, and `hostBrowserGuidance(context)` returning the fixed hostBrowser
projection. Keep context and report dispatch in existing broker, invoking inspect
and execute once as appropriate; report dispatch never supplies a host user event.

- [ ] Write failing real-ClaimWorkflow tests for read-only scoped context, progress checkpoint, exact replay with identical snapshot, conflicting payload, stale revision, drift/revocation, Needs Info pending preservation and rejected privileged report shapes.
- [ ] Run focused tests, record failures caused by absent behavior, implement parser/guidance/broker additions, then build runtime and rerun to green.
- [ ] Add CLI/installed command round trips including synthetic-marker/absolute-path/input bounds and rejection of --host-user-event for reports. Assert broker loss offers no browser action and old receipts grant no claim.
- [ ] Run new files plus workspace_attempt_guidance and existing claim protocol tests. Assert final submission untouched, zero new trusted durable browser operations, and wrapper never labels historical checkpoints verified.
- [ ] Report source/runtime diff, red/green commands and known limitations. Parent performs serial commit/review gates before publication; do not push.
