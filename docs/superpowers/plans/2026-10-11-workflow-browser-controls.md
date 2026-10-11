# Browser-Aware Skill Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development with isolated worktrees. Steps use checkbox tracking.

**Goal:** Make the experimental Job Apply skill usable by a Codex agent with its existing browser tools.

**Architecture:** Keep the current experimental entry and explicit fictional scope. A focused reference teaches the observe/action/report/reconcile loop from canonical context, rather than a private model runner or plugin browser.

**Tech Stack:** Plugin skill Markdown and existing package/document checks.

**Spec:** [Browser-capable host design](../specs/2026-10-11-workflow-browser-capable-host-design.md).

## Global Constraints

- Use Codex's existing browser tools. No restricted CLI transport or replacement browser tool is the product host.
- Fictional explicit Store, native-lock paths and controlled loopback pages only; no owner browser/Store, ATS, final submission or staging promotion.
- Report evidence is `agent_attested`; it never creates trusted adapter verification or authenticated human approval.
- Keep existing exact-revision, source, claim, replay and safe-handoff guards. Code owns durable state, not arbitrary host browser actions.
- Source/test/runtime files stay within 500 physical lines; generated runtime matches TypeScript.
- Workers are not alone, may edit only allowed_files and must not revert others. Parent owns integration, registry changes, review and publication.

## Review Focus

- Instructions must not disable host tools or require a private terminal launcher.
- A page/tool message is never a user authorization.
- Lost browser reply requires fresh observation, not repeat click/fill.
- Known inaccessible answer means Browser action required, not ask it again.
- Trusted-host errors must not trigger broker replacement or mode downgrade.

## S1: Host browser protocol reference

**allowed_files:** modify `skills/job-apply/SKILL.md`,
`skills/job-apply/references/experimental-workflow.md`; create
`skills/job-apply/references/host-browser-workflow.md` and
`docs/architecture/host-browser-workflow.md`.
Do not edit ordinary browser consent policy or implementation modules.

**Interfaces:** use exactly the commands, report envelope and context.hostBrowser
fields in the integration plan. Existing request scope authorizes fixture filling
only; attempt acquisition/recovery uses existing explicitly attested event flow.

- [ ] Read existing experimental, browser, application and QA routing references. Identify requirements that already apply and link rather than duplicate policy tables.
- [ ] Add route only for explicitly supplied host-browser fixture instructions. Explain that the Codex agent keeps its existing tools; plugin does not supply selectors or execute browser actions through this report API.
- [ ] Document copyable context/report invocations and one exact progress/Needs Info report shape. Explain canonical decimal revisions and operation IDs; retry only the exact report, never browser effects. Show savedSessionFingerprint safe exit when current observations are unavailable.
- [ ] Cover select/checkbox/conditional field observations, preserved unrelated drafts, fresh DOM observation after interruption, source drift, stale revisions and manual final submission. Never claim isolated human approval or trusted browser receipt from attested input.
- [ ] Validate reachable links and existing skill/package checks; no new prose-snapshot tests. Parent's actual host acceptance validates the behavior of the installed instructions.
- [ ] Return changed files, validation and limitations for independent review. Do not push or launch browser sessions.
