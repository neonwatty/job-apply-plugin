# Controlled Browser Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add absolute single-select and checkbox values to the controlled Chromium fixture without changing durable operation schemas.

**Architecture:** Host-private typed targets extend the local adapter and page port. Public requests remain opaque `fill` operations. The trusted page driver performs conditional writes and exact private readback in the existing revision protocol.

**Tech Stack:** TypeScript/ESM runtime, Node tests, pinned Playwright/Chromium, native DOM setters.

**Spec:** [Approved design](../specs/2026-10-11-workflow-operator-controls-evaluation-design.md); parent process-loss integration is [P3](2026-10-11-workflow-integration.md).

## Global Constraints

- Fictional controlled loopback forms only; final submission remains manual.
- Keep public requests as `kind: 'fill'` with opaque `controlId` and `valueRef`.
- Checkbox operations set an absolute state; they never toggle.
- No durable journal or BrowserAdapter schema change is expected.
- No uploads, navigation, custom widgets, multi-select controls, or submit actions are added.
- Source/test/runtime files stay at or below 500 physical lines.
- Never edit parent-owned process-loss harness or installed host files.

## Review Focus

1. Desired checkbox value is false: exact readback can still be complete (B1).
2. Duplicate or disabled option value: reject with no event or write (B2).
3. Property-only checked/indeterminate change: invalidate an old observation (B2).
4. Same selector resolves to a replaced node or wrong form: reject stale identity (B2).
5. Synchronous handlers overwrite intended value or asynchronous handlers mutate later: never claim verified success for differing readback (B2).

## Allowed files

Modify `src/integrations/browser/local-fixture-adapter.ts`,
`local-fixture-page.ts`, matching `runtime/integrations/browser/*.js` files,
`tests_js/workspace_local_browser_support.mjs`, and
`docs/architecture/local-browser-fixture.md`. Create
`tests_js/workspace_local_browser_controls.test.mjs` and, if extraction is needed,
`tests_js/workspace_local_browser_controls_support.mjs`.

## B1: Private target contract and compatibility

**Interfaces:** Export from `local-fixture-page.ts`:

```ts
type LocalFixtureTarget =
  | { kind: 'text'; value: string }
  | { kind: 'select'; value: string }
  | { kind: 'checkbox'; checked: boolean };
```

`LocalFixtureControl` accepts legacy `{valueRef:string,value:string}` or new
`{valueRef:string,target:LocalFixtureTarget}`; reject mixed shapes. Normalize
legacy text in the adapter. `LocalFixturePagePort.compareAndFill({expected,
controlId,value?,target?})` and `readback(controlId, string|LocalFixtureTarget)`
retain legacy text calls for existing injected drivers. New typed mappings use
`target`; new driver normalizes either form and rejects ambiguous combinations.
Result types and public BrowserAdapter methods remain unchanged.

- [ ] Write parameterized tests for legacy text, typed text, select, checkbox true and false. Assert public request stays `fill`, private target reaches only page port, and no desired values appear in observations/durable requests. Wrong types, mixed mapping shapes, and unknown subtype reject.

  Representative false-value assertions: `assert.equal(request.kind, 'fill'); assert.deepEqual(privateTarget, {kind:'checkbox', checked:false}); assert.equal(readback.effect, 'matches');`.
- [ ] Run `node --test tests_js/workspace_local_browser_controls.test.mjs`; verify missing target support fails.
- [ ] Implement the union, immutable mapping validation/normalization, and forwarding in named source modules. Preserve legacy text driver call shapes and keep durable/source binding checks intact.
- [ ] Build runtime and run new tests plus `workspace_local_browser_adapter.test.mjs`; require zero failures. Run `npm run typecheck` and `npm run build:check`.
- [ ] Commit source/runtime and tests: `feat: bind typed absolute values in local browser adapter`.

## B2: Chromium driver and conditional fields

**Interfaces:** Extend existing `localBrowserFixture(t, options={})` in the
support file using an optional `controlsFixture:true` mode; preserve existing
`t`-only behavior and test cleanup registration. Return existing
`{browser,page,origin,driver,adapter}` plus private `mappings`, a
`ReadonlyMap<string,LocalFixtureControl>`. `driver()` still returns a page port;
`adapter(port=driver(), mappingsOverride=mappings)` constructs a new adapter.
New mode has fixed IDs `contact.name`, `contact.method`, `preferences.optIn`,
`contact.details`, `notes`, and `submit`. `notes` and `submit` are observed but
never mapped for writes. Default mappings bind method to select `email`, optIn
to checkbox false, and details to fictional text; tests use `mappingsOverride`
for true and invalid targets. All IDs remain in the observed control inventory.

- [ ] Add browser tests: select exact option; set true then false; replay produces no extra events; reveal/hide a known conditional field preserves its draft; hidden control rejects; fresh observation enables a revealed field. Assert successful mutation revision is exactly prior revision + 1.

  Representative assertions: `assert.equal(BigInt(after.observationRevision), BigInt(before.observationRevision)+1n); assert.equal(afterNotes, beforeNotes); assert.equal(replayWrites, firstWrites);`.
- [ ] Add stale cases for checked/indeterminate property edits, option insertion/removal/disable, hidden/disabled target, replaced node, wrong form ownership, unrelated draft edit, and final-action change. Assert zero writes for precondition rejection. Reject indeterminate checkboxes rather than inferring a boolean state.
- [ ] Add duplicate-option and handler-conflict tests. Assert disabled optgroup/options and multi-select reject; synchronous handler overwrites yield differing readback and durable uncertainty. Use a controlled barrier for asynchronous changes, not arbitrary sleeps.
- [ ] Run the focused controls file and confirm meaningful failures for each added behavior.
- [ ] Implement normalization, exact subtype validation, visibility/form checks, and snapshot tracking. Fixed mapped slots remain present as unavailable when hidden/absent. Track selected options, checked/indeterminate, node identity, availability, and all unrelated draft controls. Use native setters and dispatch input/change once; snapshot after synchronous handlers. Available determinate checkbox controls report `complete` for both booleans; private readback still requires equality.
- [ ] Run controls, original local adapter, and local host tests after runtime build. Require zero failures, preserved old text semantics, and no network beyond fixture origin. Run size and matrix checks.
- [ ] Document supported controls, legacy mapping compatibility, rejection cases, and evidence limits. Commit: `feat: verify conditional select and checkbox writes`. Return mappings, fixture contract, revision, and focused receipts to parent for P3 process-loss tests.
