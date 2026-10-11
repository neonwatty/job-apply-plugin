# Slice 22: operator integration, browser controls, and repeated evaluation

Status: original scope approved on 2026-10-11, subsequently superseded by the
user's requirement for a host agent with browser tools. Implementation has not
started. See [revised direction](2026-10-11-workflow-browser-capable-host-design.md).

Base: PR #212, `42759e072f850a2512db322d308d278f7696bc3f`.
Integration branch: `codex/agent-workflows-22-operator-controls-evaluation`.

## Intent and scope

Continue the experimental plugin refactor so code owns durable state,
authorization, recovery, and completion checks, while the model proposes bounded
actions and explains outcomes. This slice composes existing mechanisms, broadens
controlled browser coverage, and collects repeated Codex evidence.

The user approved three parallel workstreams and parent ownership of shared
interfaces, integration, testing, and review. The work remains stacked on #212.
It does not merge the experimental stack or promote it to staging.

All executions use fictional Stores and controlled browsers. Final submission
remains manual. No real applicant records, active owner browser, ATS destination,
or production installation is part of this slice.

## Approach

Recommended: extend the existing host and evaluation seams with three isolated
worker packages. Preserve durable operation and model proposal schemas wherever
the existing semantics suffice. The parent owns shared support and cancellation.

Alternatives considered:

- A new production approval UI and live ATS adapter would require security and
  deployment evidence absent from these fixtures, and would expand this slice.
- Evaluation-only work would quantify the current scenarios but leave operator
  composition and non-text browser behavior untested.

## 1. Standalone experimental operator launcher

Compose the installed host, existing `createOperatorApprovalSession`, dedicated
`createTerminalApprovalSurface`, and restricted Codex transport. Start from an
unacquired fictional fixture. The existing automatically approved evaluation
fixture remains a separate, explicitly simulated mode for unattended trials.

Sequence:

1. Validate the configured Codex executable/catalog/schema and run the existing
   capability probe before inference. Prepare the isolated fixture and host.
2. Open separate operator input/output TTY descriptors in the trusted launcher.
   The host child owns the approval session and terminal surface; its ordinary
   private fixture IPC remains separate from operator input.
3. Obtain the exact canonical acquire event through the trusted fixture path.
   Present the immutable event and challenge using the existing terminal grammar.
4. Approve only through the terminal surface's canonical re-review. Execute the
   exact event once; derive the model's binding from its canonical receipt.
   Revoke the setup grant after acquisition. The model never receives a grant,
   operator descriptor, private IPC function, or approval command.
5. Run the bounded proposal loop and canonical grading. Denial, EOF, expiry,
   invalid terminal input, or cancellation produces an explicit stopped outcome.
   No inference or browser write begins after unsuccessful acquisition.
6. On interruption, cancel the active transport invocation, confirm process-group
   cleanup, close operator authority while the host is still alive, stop the
   host, and only then remove an eligible fixture. Preserve uncertain state and
   diagnostics whenever cleanup cannot be established.

### Shared interfaces and lifetime rules

- Parent extracts unacquired setup from `evals/workflows/model-fixture.mjs` into
  a fixture lifecycle seam. The existing default retains its current synthetic
  auto-acquire behavior and report semantics.
- Terminal review executes in the host child because the approval capability is
  synchronous. Do not wrap that capability over asynchronous IPC.
- Dedicated inherited TTY descriptors may use fd 4/5 while private fixture IPC
  stays on fd 3. Codex processes receive only their existing piped stdio.
- Terminal-review IPC uses an explicit bounded timeout exceeding the challenge
  deadline plus cleanup allowance. The current generic 10-second IPC timeout
  cannot govern a 60-second review. Timeout closes the pending review and revokes
  authority before reporting a stopped outcome.
- Parent adds optional cancellation propagation through evaluation runner,
  transport, and bounded Codex process. Cancellation stops future dispatch,
  terminates the owned process group, and requires confirmed disappearance.
  An uncertain in-flight browser effect follows existing durable reconciliation;
  cancellation never converts uncertainty into success or rollback.
- Keep the five model operations and closed proposal schema unchanged. Operator
  interaction is a host control path, never a sixth model operation.

### Evidence boundary

The launcher is for a separately invoked operator session. During development,
the parent agent has shell/computer access, so terminal typing under this active
session cannot establish protected human provenance. Automated terminal tests
use simulated input and label it accordingly. No real operator decision is
required to complete automated acceptance.

Dedicated descriptors and disabled model tools establish a narrow channel
contract, not OS user authentication or complete process confinement. Preserve
the existing live-provider capability-equivalence caveat. The launcher must not
advertise authenticated human approval or readiness for live ATS deployment.

## 2. Absolute-value browser controls

Extend the trusted local fixture adapter/page driver to single-select menus and
checkboxes, plus conditional visibility of a fixed set of mapped controls.
Keep public requests as `kind: 'fill'` with opaque `controlId` and `valueRef`.
The host privately binds those references to typed desired values.

Desired values distinguish text, a single option value, and a boolean checked
state. Checkbox operations set an absolute state; they never toggle. An invalid
type, missing/disabled option, replaced control, hidden/disabled target, changed
document, stale observation, or final-action change rejects before mutation.

The trusted page driver compares identity/revision and sets the value in one
synchronous browser execution turn, then dispatches the existing input/change
events. Observation must include checked state, selected option/availability,
and conditional control availability in its revision tracking. Dynamic remounts
invalidate an old observation.

Use a fixed mapped inventory with unavailable conditional slots so showing a
known field does not silently change the intended form identity. Conditional
side effects update the observation; unrelated fields and drafts remain intact.
Arbitrary new control mappings require a new trusted mapping/observation.

Readback compares the exact desired state privately. Successfully setting a
checkbox to false is complete when it matches the intended value; completion
must not be based on truthiness. Durable verification still requires its existing
complete-state and observation contracts. Document revision advancement remains
consistent with the existing conditional-write protocol.

No durable journal or BrowserAdapter schema change is expected. If preserving
the existing semantics proves impossible, the worker reports the conflict to the
parent before extending persisted contracts. No uploads, navigation, custom
widgets, multi-select controls, or submit actions are added.

## 3. Repeated Codex evaluation

Preserve at most five sequential trials per batch and twenty turns per trial.
Run fifteen planned trials, five for each existing scenario: missing-input
handoff, source conflict, and prompted interruption replay.

Three sequential five-trial batches use validated scenario offsets 0, 2, and 1.
This produces balanced globally round-robin coverage; restarting the existing
scenario index at zero for every batch would incorrectly produce 6/6/3 coverage.
Each trial uses a fresh installed fixture and the same clean committed revision.

Record the complete planned schedule before execution. Every planned slot has a
stable identity and a status distinguishing successful execution, failed model
execution, setup failure, cleanup failure, and not started. A cleanup failure
stops later trials. Preserve all earlier results and the reason later slots were
not run. Never replace a failed attempt with a successful retry in the aggregate.

The aggregate reports denominators for planned, attempted, completed, and passed
trials; per-scenario canonical and scenario success; proposal/rejection counts;
and observed latency distributions with sample counts. Separate setup failures
from model outcomes. Report missing latency data explicitly. These samples do
not establish statistical UX superiority or a production success-rate estimate.

Reuse existing blinded transcript packets and manual review validation. Give
packets random review identifiers and retain the identity mapping privately.
Question-quality scores remain null until an actual reviewer supplies them.
Synthetic terminal decisions and fake-provider tests never count as live model
or human evidence. The prompted replay scenario remains separate from actual
process-kill tests.

## Parallel ownership

All workers start from the same integration contracts in isolated worktrees.
They must not revert other workers' changes. Source/test/runtime files stay at
or below 500 physical lines, with extraction before growth reaches that limit.

| Owner | Allowed files / responsibility |
| --- | --- |
| Operator worker | New `evals/workflows/operator-*.mjs`, new `tests_js/workspace_workflow_operator*.test.mjs`, operator launcher documentation. Uses parent-provided fixture/host seams; does not edit transport cancellation. |
| Browser worker | `src/integrations/browser/local-fixture-adapter.ts`, `local-fixture-page.ts`, matching runtime files, `tests_js/workspace_local_browser_support.mjs`, dedicated local browser control tests, controlled-browser documentation. |
| Evaluation worker | `evals/workflows/codex-model-trials.mjs`, new repeated-batch/report modules and CLI, dedicated repeated-evaluation tests, evaluation documentation. Does not change process/transport cancellation. |
| Parent | Fixture lifecycle extraction, installed host/support IPC, model runner/transport/process cancellation, shared types if needed, integration tests, matrix/package registration, README/progress, review and publication. |

Shared changes land before dependent implementation is integrated. Workers can
develop against the agreed seams with focused fixtures. Parent runs combined
acceptance serially after integration. Actual Codex requests also run serially.

## Acceptance and publication

Focused tests cover:

- Approval, denial, expiry, invalid responses, EOF, canonical revision changes,
  cancellation during review/inference, shutdown, and absence of model access
  to operator capabilities. Simulated decision provenance is explicit.
- Checked true and false, select options, hidden conditional controls, stale
  observations, node replacement, unavailable options, unchanged unrelated
  drafts, exact replay, and process loss around a browser write.
- Balanced schedules, complete failure accounting, denominators, report
  validation, retained traces, cleanup failure, and absent human scores.
- Combined installed execution: operator acquisition plus a non-text write;
  revoked authority preventing later operations/reconciliation; cancellation
  preserving unresolved effects; recovery of original intent without duplicate
  writes. No test reconstructs destroyed browser drafts.

Before publication, run affected selection against staging and the intended PR
base, source/runtime/type/size checks, installed-package release validation, and
the repository's ordinary commit/push gates. Use the configured evidence-bound
Python/native environment where required. Keep failed evidence and compare
unexpected failures with the clean base. Independent branch review uses the
repository-required review toolkit and validates every accepted finding.

Run the fifteen live trials on a clean committed candidate, retain the exact
revision and runtime identity, then include their results and limitations in the
PR. Any later behavior change invalidates affected model evidence and requires
an explicitly identified new batch rather than relabeling old results.

Deliver one integrated experimental PR stacked on #212. Final publication is
conditional on passing required gates; this design makes no claim that those
future checks or model trials have run.
