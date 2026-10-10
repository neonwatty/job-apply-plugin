# Browser boundary experiment (slice 5)

This bounded experiment provides an executable synthetic adapter and a typed
boundary for operations routed through it. It does not install a live browser
adapter, call a real application site, or intercept the host's browser or shell.
Final submission remains human-only.

## Existing authority and evidence

The [experiment plan](agent-workflow-experiment-plan.md) requires authorization
before adapter calls, readback after writes, scope invalidation after form changes,
and accurate evidence labels. The [trusted host primitive](trusted-host-approval-slice.md)
is an embedding interface; it is not a demonstrated authenticated Codex or Claude
human-event channel. Browser execution has the same integration limitation.

`AttemptAuthority` privately owns the claim capability. Its `authority-evaluate`
operation delegates to canonical application authority checks for the active run,
profile/resume revisions, claim, destination, operation and answer scope. It does
not inspect a browser. Existing readiness builders serialize agent observations
and explicitly do not prove browser state. Synthetic results must not become
`agent_attested_current_attempt` evidence or successful live readiness packets.

The current host browser guidance requires visible supported surfaces, exact-form
consent, immediate private comparison after field entry, and a manual final action.
No existing repository integration demonstrates a host-owned conditional browser
write/readback capability callable by this TypeScript boundary. Consequently this
slice makes no supported-host mediation claim beyond the synthetic adapter.

## Implemented contract

The trusted embedding supplies an authority port and an adapter. Model-facing
input supplies an operation proposal only. Authority, adapter implementations and
observation provenance are never selected by the proposal.

- A scope identifies the task/revision, job, attempt revision, authorization
  revision, form identity, and adapter observation revision using exact decimal
  revision strings. Form identity includes document ID, form ID, origin and the
  complete control-set fingerprint.
- A mutation identifies one operation ID and one `fill` or `upload` operation.
  Values are passed by opaque canonical references; applicant values, paths,
  credentials and arbitrary scripts do not belong in public receipts.
- Observations contain the adapter's evidence kind, form identity, observation
  revision, value-free control states and final-action state. Synthetic evidence
  remains explicitly synthetic even when every fixture control verifies.
- A trusted authority port evaluates the exact immutable proposal against current
  canonical authority and returns a decision bound to the request's SHA-256
  fingerprint, including its operation ID and scope. It is not an
  approval boolean accepted from the model transport.

## Execution and failure semantics

Parse closed, bounded input; reject unknown/final operations; check current scope
and authority before any adapter call. A denial performs zero adapter calls and
zero browser writes. The adapter checks form identity and observation revision at
the mutation boundary before applying a write. These checks are executable in
the synthetic adapter; a future live adapter must demonstrate its actual race and
atomicity guarantees rather than inherit this claim by implementing a type.

A write acknowledgment is not completion. Read the adapter after one accepted
write and require an exact private match before returning verified completion.
Readback must identify the exact operation and request fingerprint, retain the
same form, report the next observation revision, leave the final action untouched,
and verify the target against the privately resolved expected value. A nonempty
control alone is insufficient. Missing, malformed, wrong or stale readbacks leave
the original operation uncertain. Synthetic upload comparison represents fixture
content only; it is not an upload to an ATS.

Form changes, stale observation, failed readback and uncertain exceptions prevent
further writes under the old scope. A timeout never causes an automatic retry.
Historical operation IDs cannot execute another write; altered reuse conflicts.
An exact duplicate returns the retained receipt after checking current authority.
An explicit `reconcile(operationId)` reads the original effect again without a
write. Only the exact matching readback resolves uncertainty, including when the
write succeeded but its response was lost. Observing alone or issuing a new
operation ID cannot remove the uncertainty barrier. An absent/mismatching effect
remains blocked for handoff; this slice provides no automatic retry or reset API.
An adapter's conditional rejection is recorded as `not_applied`, invalidates the
cached observation, and cannot be retried under the same operation ID.

The first boundary instance is serialized, limited to 64 operation receipts
without eviction, and memory-only. Replays remain available at capacity. It does not
promise exactly-once effects on third-party sites or recovery across a process
restart. No Store or CLI composition activates it. A live integration will need
durable uncertain-operation records and explicit restart reconciliation before
being enabled for real applications. Constructing another boundary discards the
old instance's memory and is not a supported way to recover an uncertain live
operation. Trusted authority and adapter callbacks are embedding assumptions,
not authenticated human approval or an OS boundary. The synthetic adapter's
comparison and write execute without an intervening await; no analogous atomic
guarantee has been demonstrated for a supported host browser.

## Ownership and remaining gates

Implementation belongs in `src/integrations/browser/` and generated runtime
mirrors, with focused `tests_js/workspace_browser_boundary*` tests. Shared
application/harness contracts remain with the integration owner. Approval work
must eventually provide the actual trusted canonical authority bridge; retention
work must eventually provide durable recovery/receipt policy. Neither an approval
receipt nor a synthetic observation establishes live browser truth.

Focused synthetic checks cover denial without adapter calls, exact scope changes,
form replacement before mutation, readback failure, uncertain timeout, replay,
concurrency, evidence labels and final-action rejection. Package, full native and
release gates remain integration-owner work. Promotion needs a separate host
capability demonstration or must explicitly retain agent-attested live browsing.
