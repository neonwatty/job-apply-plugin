# Slice 22 correction: browser-capable host agent

Status: user authorized revised implementation plans and continued execution on
2026-10-11. Uses Codex existing browser tools with the experimental attempt
broker. Replaces the restricted-runner product assumption.

## Required experience

The user works with an agent in an application such as ChatGPT, Codex, or Claude
Code. The agent has browser-use tools available while using Job Apply. Job Apply
continues to supply skills and deterministic workflow capabilities within the
host environment; users do not need a separate restricted model launcher to use
the product.

Confirmed by the user: use the browser tools already supplied by the host app.
The plugin does not supply a replacement browser tool or require the agent to
give up its existing browser access. Do not assume all hosts expose identical
browser or plugin interfaces. First implementation targets the existing Codex
host path, consistent with the user's earlier host selection; other hosts receive
explicit capability and packaging checks before support claims.

## Responsibility boundary

| Component | Responsibility |
| --- | --- |
| Host agent | Interpret the request, inspect the browser, choose the next useful action, operate available browser tools, communicate and ask for missing input |
| Plugin code | Canonical task/claim state, exact revisions, source selection, pending questions, policy checks, durable transitions, retry/recovery decisions and handoff status |
| Host browser tools | Actual page observation and interaction, with their host-specific identities, permissions and observable results |
| Skill instructions | Teach the agent how to consult state, use browser tools and report outcomes; keep policy tables and persisted state in code |

The protocol is: read canonical context; obtain the permitted workflow step;
inspect and act with the host's browser tools; report the observation/result;
let code validate and persist the appropriate transition. Stable operation IDs
and revision checks make reporting/retries deterministic. After ambiguous tool
completion, resume by observation and reconciliation rather than blindly
repeating a browser write.

Browser use remains available throughout the session. Plugin code need not own
the LLM process, provide its entire tool inventory, or receive all actions as
closed JSON proposals. Existing CLI commands may still serve as plugin APIs;
the problem with the previous plan is its disabled browser capabilities, not
the mere existence of a CLI.

## Honest enforcement and evidence

State ownership and model confinement are separate concerns. Validating a Store
transition does not physically prevent an agent from clicking through another
tool. A same-user agent with filesystem access may also bypass a local API; do
not describe code-managed state as a security boundary against arbitrary tools.

Use explicit evidence classes:

- Controlled adapter evidence: current fixture-only conditional writes and
  readbacks; retain the existing durable operation semantics and tests.
- Host-tool evidence: results obtained through a demonstrated host-owned
  integration, with only the guarantees that integration actually provides.
- Agent-attested evidence: observations or outcomes copied into plugin commands
  by the agent. Persist provenance and uncertainty; never promote these to
  trusted adapter verification merely because they match a schema.

Do not route agent-attested browser reports into the existing trusted adapter
verification path or manufacture its grants. Introduce an explicit host-mediated
workflow path if needed, with distinct result/provenance semantics and no silent
downgrade from trusted mode. Existing human-event attestation remains explicit;
a conversational reply or browser-controlled approval page is not authenticated
human presence. Requests within unchanged authorized scope should not prompt
for approval repeatedly.

Final submission remains manual. The agent instructions and supported workflow
commands stop before submission; claims of host-wide enforcement require actual
host support. Uncertain browser results remain uncertain, and destroyed drafts
are not reconstructed from fabricated evidence.

## Replacement parallel workstreams

1. **Host workflow integration.** Map the selected host's actual browser tool
   access and plugin invocation path. Expose canonical context, permitted next
   steps, bounded result reporting and recovery using existing workflow APIs
   where valid. Keep host-mediated evidence separate from trusted adapter state.
2. **Skills and browser protocol.** Update the experimental skill route for the
   browser-capable host: consult canonical state, observe actual controls, act,
   report, reconcile uncertainty, and hand off. Test selects, checkboxes,
   conditional fields and preserved drafts using controlled pages reached
   through that host path. Fixture adapter unit tests remain supplemental.
3. **Real host-agent acceptance.** Exercise the installed experimental plugin
   with browser tools enabled, fictional data and controlled pages. Independently
   inspect page state and canonical Store outcomes. Retain failed attempts,
   transcript/tool evidence, timing and human-review packets. Pin model/runtime
   and plugin revisions without treating restricted proposal trials as this lane.

The parent owns the shared context/result/provenance contract, integration,
review and testing. The [integration plan](../plans/2026-10-11-workflow-integration.md) defines
the context/report contract and disjoint ownership before worker edits. No new standalone approval UI is required by this scope.

## Reuse and acceptance

Retain PR #212 and its evidence. Durable state, revision guards, recovery,
archival, source binding and controlled browser tests remain useful. Restricted
Codex trials remain a narrow controller test lane. Their successful results do
not certify the browser-capable product workflow.

New acceptance must demonstrate that the agent can invoke browser tools while
using the plugin; interrupted work resumes from saved state; duplicate reports
do not duplicate transitions; unrelated drafts remain intact; stale reports are
rejected or marked uncertain; and final submission is untouched. Browser write
counts must come from independent controlled-page instrumentation, not assistant
self-report. Human UX scores remain unset until actually reviewed.

This remains on the experimental branch off PR #212. No promotion, merge,
production installation, owner Store/browser use, or live ATS testing follows
from this correction. The former implementation plans are marked superseded to
prevent execution under the wrong host assumptions.
