# Host Browser Acceptance Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development with isolated worktrees. Steps use checkbox tracking.

**Goal:** Verify the installed experimental plugin with Codex's real host browser tools on controlled fictional pages.

**Architecture:** A loopback fixture server instruments page events and supplies independent state snapshots. Installed attempt commands own canonical workflow state. The parent agent performs browser interactions using host tools; the harness never pretends its scripted tests are host-tool evidence.

**Tech Stack:** Node HTTP/ESM, existing installedFixture/prepareInstalledCampaign helpers, Node tests, exposed Codex browser tools for live acceptance.

**Spec:** [Browser-capable host design](../specs/2026-10-11-workflow-browser-capable-host-design.md).

## Global Constraints

- Use Codex's existing browser tools. No restricted CLI transport or replacement browser tool is the product host.
- Fictional explicit Store, native-lock paths and controlled loopback pages only; no owner browser/Store, ATS, final submission or staging promotion.
- Report evidence is `agent_attested`; it never creates trusted adapter verification or authenticated human approval.
- Keep existing exact-revision, source, claim, replay and safe-handoff guards. Code owns durable state, not arbitrary host browser actions.
- Source/test/runtime files stay within 500 physical lines; generated runtime matches TypeScript.
- Workers are not alone, may edit only allowed_files and must not revert others. Parent owns integration, registry changes, review and publication.

## Review Focus

- Evidence must come from instrumented page state, not copied assistant success text.
- Existing output cannot be overwritten and failed trials cannot disappear.
- Unconfirmed broker shutdown preserves fixture files.
- Report replay does not increase browser event counts.
- Nine trials in one host-agent session are not independent model conversations or UX statistics.

## E1: Instrumented installed fixture harness

**allowed_files:** new `evals/workflows/host-browser-fixture.mjs`,
`host-browser-page.mjs`, `host-browser-grade.mjs`, `host-browser-cli.mjs`,
`tests_js/workspace_host_browser_acceptance.test.mjs`,
`docs/architecture/host-browser-acceptance.md`.
Use *_support.mjs for any new test helpers. Do not change shared existing fixture,
transport, matrix or model-study modules.

**Interfaces:** `createHostBrowserFixture({outputDirectory,scenario})` returns
`{url,manifest,inspect,grade,close}`; valid scenarios controls-handoff,
uncertain-resume, stale-report. `manifest` gives fictional installed plugin/root/
native-lock paths, exact candidate revision and scoped instructions. An owned
attempt broker runs for the fixture lifetime. Existing installed preparation
sets up known facts/run/job; no automatic acquisition or browser writes.

Page contains clearly labelled text, select, checkbox, conditional text,
unrelated prepopulated notes, and a prevented Submit button. Observe input/change
counts and submit attempts at the server via page events; validate bounded
payloads. Expose observer state to harness via a separate local endpoint; do not
ask the agent to mark a pass. Values are fictional. Server binds only 127.0.0.1.

CLI `start --output <new-dir> --scenario <id>` is foreground and prints one JSON
manifest. `inspect --manifest <file>` returns current page/canonical evidence;
`grade --manifest <file>` saves a durable report. Implement clean lifecycle and
an owned stop path documented for parent use; no arbitrary remote targets or
unbounded Store paths accepted from the browser. Existing installedFixture
cleanup remains conditional on confirmed owned-process shutdown.

- [ ] Write failing tests using real HTTP and installed Store/command helpers: clean initial state, bounded page event ingestion, grading rejects missing writes/altered notes/final attempt/active claim, preserves failed reports and refuses preexisting output.
- [ ] Implement fixture/server/grader without browser-driving code. Clearly label HTTP-simulated test events as harness tests. Protocol commands/report shapes come from integration plan and may be pending until integration.
- [ ] Grade checks canonical Needs Info with released claim, unchanged immutable inputs/unrelated job, expected fictional page values, preserved notes, zero submit attempts and scenario obligations. Replay obligations require canonical event receipts and unchanged page counters; no model claim substitutes.
- [ ] Run focused tests; return exact start/inspect/grade/stop commands and evidence schema. Parent integrates and runs nine actual host-browser trials (three/scenario), one new fixture per trial, sequentially.
- [ ] Document tool trace references, exact revision, completed/failed/unstarted counts and null human UX metrics. No live Codex CLI inference or visible owner browser interaction by this worker.
