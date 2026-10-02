# One application task or worker

The host agent may route one ordinary, exact-job application to one dedicated
top-level Codex task or one capable worker. Companion and the TypeScript CLI do
not launch agents. This route does not apply to resume extraction, loopback QA
replay, account canaries, or recovery of an expired or interrupted claim.

## Coordinator before launch

1. Resolve the canonical Store under Answer Memory rules and identify the exact
   selected job under [intake](intake.md). A saved model choice cannot select a job.
2. Read `profile.agentModelPreferences` through `store profile-inspect` under
   [agent model preferences](../../answer-memory/references/agent-model-preferences.md).
   Use the current host's `application` key and Codex's
   `applicationReasoningEffort` unless the owner chose another model or effort
   for this request. A missing field means the host default for that choice.
3. Choose a boundary the host can actually launch. In Codex desktop, browser-bound
   filling uses this top-level task or, only when the owner explicitly requests a
   separate task, one new top-level local task with the selected model and effort.
   Do not use a browser-bound subagent merely to change models. A worker route requires
   verified access to its own required browser surface. Repeat [Codex model
   preflight](../../answer-memory/references/agent-model-preferences.md#codex-model-preflight)
   for the intended task or worker tool. If the model, effort, or override is unavailable,
   stop before task creation, claim, or browser work. Never silently substitute.
4. For a new Codex task, resolve the local project through the host project list
   and create a local task with the selected exact `model` and `thinking` overrides;
   omit either when its host default is selected. Do not request a new
   worktree for form filling. Give it only the canonical job ID and the current
   request's exact authorization scope, plus directions to follow this skill.
   Do not include applicant values, resume path, credentials, claim token,
   browser state, or blanket consent. The new task reads the canonical Store and
   owns the visible browser. It does not create another task or worker. Record
   the selected pair and successful launch tool result in the coordinator handoff;
   the child must not infer its runtime model from the prompt. For a
   capable worker on another host, pass the same limited context and boundaries.

The coordinator does not separately select, acquire, fill, navigate, or submit
the same job while the task or worker is active. Follow progress through the
host's task wait facility. Relay needed owner decisions with exact live-form
scope and only value-free progress. A failed launch leaves the job unclaimed.
If the task stops or loses the broker, inspect canonical task and claim state
before resuming; do not launch a replacement against an unseen attempt.

## Task or worker boundaries

The filling agent runs the ordinary `task` and `attempt` commands itself. In
Guided mode, it first completes the visible early account check before selection
or acquisition; an authentication gate leaves the job queued without a claim.
It then acquires the exact selected Ready job through the private attempt broker
before form entry, and evaluates any active Autofill or Campaign authority
before each action group. A model preference or task launch is never application
authority. If authority evaluation denies or a consent interrupt appears,
follow Guided live-form approval and the existing Needs Attention rules.

Only one filling agent and one visible-browser owner may be active for the Store
at a time. Campaign to Review starts the next job only after the previous job
has a durable review or Needs Attention handoff and campaign progress still
names the next Ready job. Never run parallel filling agents.

The filling agent returns the exact canonical job status and a value-free
account of completed fields, blockers, and manual review. It never activates Submit, Send, Apply, Mark applied, or an equivalent final action. The owner
inspects and submits the visible form manually.
