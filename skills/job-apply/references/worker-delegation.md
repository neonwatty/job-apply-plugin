# One application worker

The host agent may delegate one ordinary, exact-job application to one sub-agent.
Companion and the TypeScript CLI do not launch agents. This route does not apply
to resume extraction, loopback QA replay, account canaries, or recovery of an
expired or interrupted claim.

## Coordinator before launch

1. Resolve the canonical Store under Answer Memory rules and identify the exact
   selected job under [intake](intake.md). A saved model choice cannot select a job.
2. Read `profile.agentModelPreferences` through `store profile-inspect` under
   [agent model preferences](../../answer-memory/references/agent-model-preferences.md).
   Use `codex.application` or `claudeCode.application` for the current host, unless
   the owner chose another model in the current request. A missing field means the
   host's default worker model.
3. Check that the host can launch one sub-agent with the selected model. If a
   non-default model is unavailable, stop before claim or browser work and tell
   the owner. Do not silently substitute another model.
4. Launch one worker for the exact job. Give it the job ID and the current request's
   exact authorization scope, but no applicant values, resume path, credentials,
   claim token, browser state, or blanket consent. Tell it to follow this skill's
   ordinary intake, account, consent, form verification, and handoff references
   from the canonical Store. The worker must not delegate another worker.

The coordinator does not separately select, acquire, fill, navigate, or submit
the same job while the worker is active. It relays any needed owner decision with
the exact live-form scope and records only value-free progress. If the worker
stops or loses the broker, inspect the canonical task and claim state before
resuming; do not start a replacement worker against an unseen attempt.

## Worker boundaries

The worker runs the ordinary `task` and `attempt` commands itself. In Guided mode,
it first completes the visible early account check before selection or acquisition;
an authentication gate leaves the job queued without a claim. It must then acquire
the exact selected Ready job through the private attempt broker before form entry,
and it must evaluate any active Autofill or Campaign authority before each
action group. A model preference, parent delegation, or prior approval is never
application authority. If authority evaluation denies or a consent interrupt
appears, follow Guided live-form approval and the existing Needs Attention rules.

Only one application worker and one visible-browser owner may be active for the
Store at a time. Campaign to Review launches the next worker only after the
previous job has a durable review or Needs Attention handoff and the campaign
progress still names the next Ready job. Never run parallel filling workers.

The worker returns the exact canonical job status and a value-free account of
completed fields, blockers, and manual review. It never activates Submit, Send,
Apply, Mark applied, or an equivalent final action. The owner inspects and
submits the visible form manually.
