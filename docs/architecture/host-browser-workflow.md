# Host browser workflow bridge

The experimental plugin now connects the claim broker's private capability to
canonical application authority and durable browser intent. It uses a fictional
native Store and a synthetic adapter. It does not authenticate a human, operate
a live ATS, prove external exactly-once effects, or submit an application.

## Organization

| File | Responsibility |
| --- | --- |
| `contracts/workspace/browser-authority.ts` | Closed trusted value-source grants |
| `app/claim-workflow.ts` | Private claim, exact active task/input binding, serialized lifecycle |
| `store/native-claim-workflow-tasks.ts` | Canonical authority evaluation under the existing Store lock |
| `integrations/host/browser-authority.ts` | Snapshot host grants and reject unknown or incompatible opaque references |
| `integrations/host/workflow-browser-host.ts` | Separate model and protected host ports; compose the durable boundary |
| `integrations/host/browser-workflow-broker.ts` | Dedicated browser transport discriminators and heartbeat lifecycle |
| `cli/experimental-browser-workflow.ts` | Installed fixture-only model client; serving requires trusted embedding |

The browser boundary continues to own durable pending intent, uncertainty,
terminal receipts and read-only reconciliation. The workflow owns its claim
capability. Neither the browser proposal nor the durable browser ledger receives
the claim bearer, applicant values, local resume paths, approval grants or user
event credentials.

## Protected and model ports

`createWorkflowBrowserHost` accepts a trusted workflow factory, adapter, native
operation Store and value grants. It constructs the user-event verifier itself
and returns separate `model` and `host` facets:

- `model.context`, `event`, `observe`, `execute`, and `reconcile` accept proposals.
- `host.review` returns the exact event/input binding for host presentation.
- `host.approvals` accepts, revokes or closes short-lived exact-event grants.
- `host.heartbeat` and `close` own broker lifecycle.

The embedding must keep the protected facet out of model transport and must
authenticate the human decision before approving it. A model's boolean, repeated
request, copied binding or `--host-user-event` flag cannot mint a grant here.
Fixture IPC demonstrates possession of a protected in-process port; it is not
evidence of real host authentication.

`createTrustedBrowserWorkflowHost(root, nativeLock, adapter, grants, {controls})` runs this
composition using the installed private broker. The installed model client is:

```text
workflow browser context --root ROOT --native-lock ARTIFACT
workflow browser event --root ROOT --native-lock ARTIFACT --input EVENT
workflow browser observe --root ROOT --native-lock ARTIFACT --input BINDING
workflow browser execute --root ROOT --native-lock ARTIFACT --input MUTATION
workflow browser reconcile --root ROOT --native-lock ARTIFACT --input RECONCILIATION
```

Observe input is the closed `BrowserBinding`. Execute input is the existing
closed `BrowserMutation`; reconciliation input is `{binding, operationId}`.
The broker accepts only dedicated `browser_*` messages. An ordinary attempt or
campaign client cannot use another dispatch path to bypass the protected event
boundary. There is no approval command, and plain CLI serving without trusted
embedding fails.

Installed `browser context` includes `browserRecovery`: actual persisted hot and
archived operation counts, remaining archive segments, any unresolved operation
ID, and an explicit continue/reconcile-or-handoff/capacity-handoff action. Its
native inspection validates archive references without writing a rollover or
presenting an uncommitted in-memory projection as durable state.

## What code checks

Before initial execution, after durable reservation, and for historical replay
or reconciliation, the host bridge requires:

1. A supported host-configured value reference, matching fill/upload kind, and
   exact trusted control-to-value mapping copied when the host is constructed.
2. The current active application task, task revision, job and attempt revision.
3. The broker's still-live private claim and unchanged canonical preparation input.
4. The exact authority revision, active unexpired scope and expected destination.
5. The exact canonical source revision: a supported nonempty profile field,
   confirmed answer with canonical sensitivity/current-use rules, or selected
   managed resume identity and content revision.

Authority evaluation reads the same locked canonical snapshot as task and claim
validation. It does not acquire the Store lock recursively. No Store lock is
held during adapter calls; the durable boundary rechecks authority after writing
intent and the adapter conditionally compares the form and observation revision
immediately before a synthetic write.

The host supplies the canonical-source/control mapping and must detect browser
interrupts at the adapter boundary. This bridge does not treat a model-supplied
claim that CAPTCHA, consent, or other interruptions are absent as evidence.
The current synthetic adapter has only its explicitly constructed fictional
control states and cannot infer conditions on a real site.

Progress makes the old task revision stale. Revocation prevents new writes,
replay and reconciliation under revoked authority. A safe needs-info handoff
remains available to release the claim. Closing or losing the broker discards
its private capability; constructing a new host never reconstructs that bearer
from a task or browser receipt. Explicit workflow recovery remains necessary.

## Evidence and limits

`tests_js/workspace_host_browser*.mjs` exercises native extraction, confirmed
run selection, preparation, protected acquisition and actual canonical authority
before synthetic fill/upload. It checks exact replay, forged references and
bindings, changed inputs, broker loss, revocation and safe handoff, transport
separation, and preservation of unrelated canonical data.

Installed acceptance exercises the same public commands using a test-only host
driver. Neither source nor installed tests claim live-browser draft preservation
or actual human authentication. Those require a supported production embedding
and a demonstrated conditional write/readback mechanism.
