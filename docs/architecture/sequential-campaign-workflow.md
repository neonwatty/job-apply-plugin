# Sequential campaign workflow

This experimental fixture host executes one application attempt at a time through
`SequentialCampaignWorkflow` and `NativeCampaignWorkflowTasks`. Its authority is
the existing `campaign_to_review` grant. The ordered `jobBindings` from that grant
and the bound application run determine which Ready job may start next.

## Durable state and ownership

There is no second active workflow task and no duplicate queue cursor. The
application run, authority, job statuses, claim, and attempt receipts are already
canonical durable records. Acquisition and handoff publish job transitions and
workflow receipts through the same recoverable claim journal. Recreating the
broker after a completed handoff therefore selects the next Ready job. A live or
expired claim blocks moving on; broker loss requires explicit same-job recovery.

Jobs at Needs Info or Awaiting Review are skipped. An owner explicitly returning
a Needs Info job to Ready may retry that job under a still-current campaign grant.
A queue containing only blocked or unavailable jobs reports `needs_attention`.
`complete` means every scoped job reached Awaiting Review, Applied, or Closed;
manual review and submission may still remain. Awaiting Review never triggers an automatic restart or final submission.

## Execution boundary

`campaignProjection` generates the next permitted candidate. The native campaign
adapter checks the selected job, grant status/expiry, run, profile revision,
resume/fact binding, destination, and preflight again under the claim transaction
lock immediately before executing a domain action. A model cannot override queue
order by supplying another Ready job. The existing harness still enforces one
active workflow, exact revisions, operation replay, and one coordinator claim.

Pause, resume, and stop use the existing authority service with an exact authority
revision and explicit matching host attestation. Pause/stop/revocation block new
ordinary work. Guarded Needs Info handoff and cancellation can release an owned
claim after authority changes. Explicit expired same-task recovery remains available
to restore a lost capability for that safe exit; it cannot enable ordinary
progress or a review handoff while authority is unavailable. Historical duplicate events return their existing
receipt without running another domain action. Attestation is not authenticated
human approval, and the CLI requires a marked synthetic Store.

## Entry point and layout

`workflow campaign serve|context|event|pause|resume|stop` uses the existing private
attempt broker transport. Only one attempt/campaign broker can own that transport
for a Store. Control commands require `--expected-revision` and
`--host-user-event`; acquisition events retain the existing host-event requirement.

- `src/contracts/workspace/sequential-campaign.ts`: deterministic scope and queue policy.
- `src/store/native-campaign-workflow-tasks.ts`: locked execution guard around the existing claim adapter.
- `src/app/sequential-campaign-workflow.ts`: orchestration, advisory context, and controls.
- `src/cli/experimental-campaign-workflow.ts`: synthetic fixture host.

The campaign host does not itself operate a live browser. Browser writes still
need their own capability, observation, reconciliation, and final-action boundary.
