# Trusted human approval adapter: feasibility checkpoint

Reviewed 2026-10-10 against `21999d2d724033c7e90c2a87a7e360e37ad8eba3` (PR #206).

## Decision

No supported, protected human-event channel has been established for the existing Job Apply Codex or Claude plugin installation. Keep the current trusted-attempt embedding API fixture-only and keep legacy attestation explicit. Adding a hook, MCP tool, local HTTP route, or CLI flag now would not justify claiming authenticated human approval.

This is a scoped evidence result, not a claim that either host can never support the integration. Official documentation provides host integration building blocks. The missing piece is a demonstrated deployment in which the real human input handler, approval authority, executable code, and transport are outside the model's control. A separate protected embedding host is a plausible next experiment; it is not supplied by this plugin today.

## What the repository actually enforces

- [`src/harness/user-events.ts`](../../src/harness/user-events.ts) separates approval issuance from verification in memory. Grants bind two SHA-256 digests, expire within five minutes, support revocation, and close on an invalid/backward clock. It explicitly leaves human authentication to its caller.
- [`src/integrations/host/trusted-attempt.ts`](../../src/integrations/host/trusted-attempt.ts) retains the approval object and exposes read-only review only while the broker runs. It closes approvals on shutdown and cannot restart the same host instance.
- [`src/app/claim-workflow.ts`](../../src/app/claim-workflow.ts) requires grants for acquisition, restart, recovery, and cancellation in trusted mode. Review binds the complete parsed event and canonical input scope; execution checks before work, on historical replay, and immediately before commit. A grant does not authorize browser progress, sensitive answers, or final submission.
- [`src/cli/experimental-claim-workflow.ts`](../../src/cli/experimental-claim-workflow.ts) has an optional in-process composition port, with no public grant command. Both server paths require the synthetic Store marker. Trusted mode ignores the legacy event attestation flag.
- [`tests_js/workspace_host_approval_process_support.mjs`](../../tests_js/workspace_host_approval_process_support.mjs) simulates approval over fixture-parent IPC. The simulator proves separation from the ordinary client, not human origin or an operating-system boundary against an unrestricted same-user process.
- [`src/app/preparation-workflow.ts`](../../src/app/preparation-workflow.ts) still matches a caller-supplied `HostUserEvent` to the reply. Its CLI explicitly describes `--host-user-event` as attestation. Attempt grants do not upgrade preparation replies.

The manifests in [Codex](../../.codex-plugin/plugin.json) and [Claude](../../.claude-plugin/plugin.json) package skills; they do not declare an authenticated approval service. See the existing [slice contract](trusted-host-approval-slice.md) and [experiment plan](agent-workflow-experiment-plan.md).

## Official host capabilities and their limits

The following pages were opened, not inferred from search snippets. Product capabilities are documentation findings; the trust conclusions are this investigation's assessment. Installed host behavior was not exercised.

| Surface | Documented capability | Assessment for this plugin |
| --- | --- | --- |
| Codex lifecycle hooks | `UserPromptSubmit` receives prompt and turn information. Command hooks receive JSON on stdin. Plugin hooks require trust; managed hooks can exclude plugin/user hooks. Some tool paths bypass hooks. [Hooks](https://learn.chatgpt.com/docs/hooks) | A useful notification source. The documented payload is not a signed human-origin receipt. A model-reachable script accepting that JSON can be invoked directly. Managed configuration still needs protected code, transport, and execution boundaries. |
| Codex app-server | Client JSON-RPC handles command/file approvals, `item/tool/requestUserInput`, and `mcpServer/elicitation/request`. Input prompts can specify automatic timeout resolution. [App Server](https://learn.chatgpt.com/docs/app-server) | A separately owned client can implement a real decision UI. A plugin is not automatically that client. Request IDs and accepted responses identify protocol exchanges, not necessarily human actions. |
| Codex approval policy | Auto-review can route eligible approvals to a reviewer agent, including MCP/app approvals. [Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review) | Successful tool permission cannot be treated as evidence that a person approved the workflow event. A human-only workflow gate must be separate from automatic tool approval. |
| Claude lifecycle hooks | `UserPromptSubmit` receives prompt JSON. `Elicitation` may answer without showing a dialog; `ElicitationResult` can replace or block a user's response, including changing declined input to accepted output. [Hooks reference](https://code.claude.com/docs/en/hooks) | Plain hook input or MCP `accept` is insufficient human provenance. A protected host would need to own and constrain all response-producing paths. |
| Claude Agent SDK | `canUseTool` can pause for application-supplied approval or `AskUserQuestion` input. Automatically approved tools bypass that callback; application logic collects the actual user response. [Handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input) | Feasible building block for an embedding application, with independently protected input handling. It is not an authenticated approval callback added to the existing plugin by changing its skills. |
| Claude Enterprise inference hooks | Enterprise administrators can configure signed requests from Anthropic to an organization-owned security server. The payload is governed inference context and the verdict allows or denies inference. [Inference hooks](https://platform.claude.com/docs/en/manage-claude/inference-hooks) | Demonstrates authenticated provider transport, but does not establish an exact human workflow decision. No Enterprise configuration or protected integration is established here; this is not the current plugin path. |

Codex supports plugin lifecycle hooks on local execution/orchestration surfaces, with restrictions for cloud-orchestrated Work. Installing a plugin does not deploy a protected owner service. [Plugins](https://learn.chatgpt.com/docs/plugins)

No reviewed API establishes a plugin-consumable signed receipt saying that a particular human approved this exact Job Apply event and input revision. This negative finding is limited to the reviewed interfaces; it is not an exhaustive assertion about private host APIs.

## Rejected shortcuts

| Proposed shortcut | Missing boundary |
| --- | --- |
| Model emits `approved: true`, copies a reply, or calls an approval tool | The proposal producer also produces its authority. |
| Model calls `request_user_input`, then supplies the answer to a command | The plugin receives a model-controlled copy. It lacks direct, protected host delivery and exact pending-request correlation. |
| Parse a user-role transcript or local event file | Writable/replayable storage is not authentication. User role alone also fails to distinguish a human from a programmatic sender. |
| Install a hook that invokes `approve` with JSON stdin | The executable must distinguish actual host invocation from another process. JSON fields, environment variables, parent PID claims, and script location alone do not establish that distinction. |
| Treat MCP elicitation acceptance as human approval | Clients and hooks can supply answers. The server must authenticate and constrain the particular host's decision path, including modifications and automatic resolution. |
| Add an approval route to Companion | A model with local HTTP or browser control may invoke it. Existing application access is not proof of human presence. |
| Put a secret in a file, environment variable, or model-started broker | The model's same-user shell may read it or replace the process/code. A secret helps only if an independently enforced boundary protects it. |
| Owner starts an ordinary shell script that waits for input | Ownership of the launcher alone does not exclude agent access to the terminal, input device, process, or files. |
| Reuse app-server login or a signed provider request | Account/provider identity is distinct from fresh human approval of an exact domain operation. |

These are design assessments of the stated threat model. No exploit against an owner host was attempted. The current research session permits unrestricted same-user shell access, so it cannot serve as evidence that those surfaces are protected.

## Bounded next option: a protected embedding experiment

Before source implementation, choose a host deployment capable of enforcing the following requirements. These are proposed acceptance conditions, not claims that a stock plugin configuration already meets them.

1. **Independent owner.** An owner-controlled supervisor starts the broker and decision UI. The agent cannot launch a replacement authority, select approval callbacks, edit trusted executables/configuration, attach a debugger, signal/inject into the owner process, or acquire its credentials. Protect canonical Store writes too; otherwise the agent can bypass the broker directly.
2. **Separated channels.** The model channel carries untrusted proposals and public results. The decision channel terminates at the owner service and accepts only authenticated UI decisions. Do not expose its methods through model tools, Companion routes, writable files, or an unauthenticated loopback socket. Private inherited IPC is useful only when the OS/process restrictions actually protect its endpoints.
3. **Human interaction boundary.** The decision UI uses an authenticated owner session and an explicit decision for the displayed operation. The agent's browser, accessibility, shell, network, and remote-control tools must not operate that UI or replay its requests. Session cookies, CSRF protection, localhost binding, or an ordinary click alone do not prove this isolation. An independent device or protected native presence mechanism is a possible design input, not a demonstrated solution here.
4. **Exact presentation and binding.** The service calls `review(event)`, holds the immutable result privately, displays the operation and meaningful scope/revisions, and correlates the owner's response to that result and a fresh pending request. The UI must use reviewed data, not model-written approval prose. Denial, dismissal, timeout, unknown session, changed event, stale task, and canceled request issue no grant.
5. **Grant lifecycle.** Only the owner's decision handler calls `approvals.approve(binding, lifetime)`. Keep the grant ID private; use it for revocation. The existing workflow remains responsible for current policy, scope, replay, and commit checks. Close pending requests and authority when the session or broker exits. Recovery in a new broker requires a new decision.
6. **Preparation parity.** Design a distinct preparation review/verification port before claiming coverage of the whole workflow. Bind the route operation, task and expected revision, pending question identity, complete reply, and canonical input scope. Define replay, denial, expiry, changed-input behavior, and the commit check before adapting UI. A shared digest shape alone does not make the two domain contracts interchangeable.
7. **Retention discipline.** Store no prompt transcript, answer value, applicant data, bearer, or approval secret in receipts. Decide which value-free decision identifiers are needed and bound their lifetime. Keep approval memory and workflow history retention separate.

Codex app-server and the Claude SDK can be investigated as the supervisor's model transport. That is a new embedding deployment with an owned UI and restricted agent environment. The next experiment should first demonstrate the isolation using fictional data and simulated model requests; running a model is not required to prove request correlation or rejection. A stock-host plugin adapter remains unavailable until a supported protected host bridge is identified and tested.

## Scope and interface checkpoint

Current allowed files: this document only, plus ignored `.workflows/local/approval-adapter/` receipts. No new runtime entry point, hook, MCP server, manifest setting, source API, or dependency is proposed for this checkpoint.

No source expansion is requested while the protected input path is unresolved. If a future host deployment is selected, agree its exact files and interfaces before implementation. It will depend on: authenticated owner/session identity; a protected transport; pending-request correlation; complete immutable event/input binding; preparation-specific validation; supervisor-owned startup/shutdown/recovery; and separation from the browser adapter and retained history policy. Neither parallel workstream should interpret this report as granting approval or enabling trusted mode by default.

## Verification and remaining evidence

This report changes documentation only. Local source inspection verifies the described current primitives and preparation gap. Official pages establish the listed capabilities and counterexamples; they do not prove this user's installed host version or configuration. No model, native browser, live Store, credential, plugin installation, or production approval flow was exercised.

Run whitespace/link-target checks for this document. The parent owns affected-suite selection and any required broader gate; this workstream must not start a full, release, or native suite in parallel. Existing fixture tests remain relevant evidence for grants, forged legacy flags, expiry/revocation, changed inputs, replay, and broker loss, but passing them again would not establish a human event source.

Before an adapter can be accepted, demonstrate with disposable fixtures that: a genuine protected owner decision authorizes only the reviewed event; direct model proposals and forged decision JSON cannot issue grants; the agent cannot reach or replace the decision channel; automated hook/elicitation answers do not count; cross-session responses, stale changes, timeout, denial, replay, and broker replacement fail as specified; and preparation replies receive equivalent protection. Record the host/version and actual enforced restrictions. Until then, authenticated human-event acceptance remains unverified.
