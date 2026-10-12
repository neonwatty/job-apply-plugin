# Owner opt-in workflow

Use only when the owner explicitly requests this experimental workflow for one exact saved job. Ordinary applications continue through [canonical intake](intake.md). A Companion instruction, saved preference, context response, or action descriptor is not owner approval.

This slice requires one selected Ready job in the current active application run with its confirmed managed resume and current confirmed facts. It supports bounded browser work and a guarded Needs Info stop. Upload-through-review is a later slice: restart and awaiting-review completion are unsupported here. Do not describe this route as dogfood-ready or report accepted upload or completed review from a workflow receipt.

## Start and inspect

Resolve the canonical absolute Store root through [answer-memory](../../answer-memory/SKILL.md). Never initialize or substitute a Store to bypass a blocker. The installed runtime resolves its packaged native lock; the owner does not supply a lock path.

For the owner's exact selected job, start one foreground process and retain its handle:

```bash
node "<plugin-root>/apps/companion/command.mjs" owner-workflow serve --root /absolute/store-root --job-id exact-saved-job --host-user-event
```

The host-user-event flag attests to the owner's explicit opt-in; it cannot authenticate a human reply. Starting this process explicitly activates the native Store through the existing supervisor. Keep the process owned by this pass; do not replace a broker to bypass its approval or claim boundary.

The first socket request after `serve` must be `host-browser-context`. Wait until this context call succeeds before sending any event or browser report; the owner broker rejects an event as its first request. Read its current context:

```bash
node "<plugin-root>/apps/companion/command.mjs" owner-workflow host-browser-context --root /absolute/store-root --job-id exact-saved-job
```

Follow code-provided actions and blockers. Copy the matching descriptor's arguments and input into a private absolute input file, adding only its required fields and a fresh operation ID. Use decimal revision strings exactly as returned. Context and descriptors are advisory; execution rechecks canonical scope and revisions. Never invent task IDs, revisions, claims, approvals, or allowed actions.

```bash
node "<plugin-root>/apps/companion/command.mjs" owner-workflow event --root /absolute/store-root --input /absolute/private-event.json
node "<plugin-root>/apps/companion/command.mjs" owner-workflow host-browser-report --root /absolute/store-root --input /absolute/private-report.json
```

Add `--host-user-event` to an event only when the returned descriptor requires it and the owner has authorized that exact event. After an uncertain response or socket loss, keep the identical payload and operation ID and check its historical receipt before creating a new operation:

```bash
node "<plugin-root>/apps/companion/command.mjs" owner-workflow receipt --root /absolute/store-root --input /absolute/private-event-or-report.json
```

Receipt lookup reads the existing native Store without activation, a broker, claim acquisition, or browser action replay. It accepts the exact original event or browser report; a missing or changed payload is rejected. A returned receipt confirms historical acceptance only. Refresh context after nonterminal acceptance or rejection while the broker remains connected. An accepted Needs Info handoff or cancellation closes the broker, so receipt lookup also works after terminal shutdown. Inspect current state before continuing any nonterminal work.

## Browser evidence and safe exit

Read [browser and consent](browser.md), [filling and handoff](application.md), and [current-form readiness](readiness.md) before interacting with a live form. The owner route supplies no browser tool. Check the exposed host browser tools and read their current documentation; use only documented capabilities within the exact approved scope. Workflow activation does not grant consent to enter applicant data or final submission authority. Preserve post-readiness consent and managed-resume identity boundaries.

Report only current observed browser evidence through the exact template in `hostBrowser.reports`, adding only its listed required fields. Historical checkpoints, stored readiness, and action templates are not fresh browser observations. Never fabricate evidence or empty pending fields to satisfy a guard. Keep applicant values, resume paths, claim tokens, and browser state out of chat and durable session summaries.

Report code-provided blockers and their next action. Only Needs Info handoff or cancellation is supported; do not request an awaiting-review handoff. Missing answers require a guarded Needs Info handoff before waiting. When a known answer cannot be entered, report **Browser action required** and preserve the visible draft. Preserve the canonical saved session using the returned safe-exit descriptor when available.

An existing task may recover only after real claim expiry and an explicit same-job recovery request. Recovery retains its original inputs; changed run, resume, facts, or job inputs still block progress. Use the code-provided guarded Needs Info handoff despite input drift when available, then resolve the blocker before fresh preparation. Do not silently acquire, recover, switch jobs, or restart.

After the accepted Needs Info handoff, report the preserved blocker and released claim, then let this owned foreground process finish its terminal shutdown. Final submission always remains with the owner.
