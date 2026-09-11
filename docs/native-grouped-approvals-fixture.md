# Native grouped approval fixture

New version 9 synthetic Stores support grouped answer approval preview and
commit through the native CLI. Initialize a fixture and build the native addon
as described in [Native Jobs](native-jobs-fixture.md). Existing fixtures and
live applicant Stores are not adopted or upgraded. Keep Python writers away
from the native fixture.

## Preview and confirm

Use a pending field produced by [claim progress or handoff](native-claims-fixture.md).
Read the job and session revisions through `job-activity --id ID`. The decision
reference comes from that session's pending information; the answer must still
match the pending field's recorded answer revision. Create a JSON input file:

```json
{"decisions":[{"reference":"pending_0123456789abcdef0123456789abcdef","answerKey":"synthetic-answer","currentUse":true,"remember":false,"policyMode":"strict","useAuthority":"accepted_record","allowedSensitiveFieldClasses":[]}]}
```

The sample reference is illustrative: replace it with the actual fixture field
reference and select the policy and authority appropriate to the decision.
Preview with the current revisions:

```sh
node runtime/cli/native-jobs.js --root /private/tmp/new-native-jobs --native-lock /absolute/flock.node approval-preview --id synthetic-job --expected-job-revision 4 --expected-session-revision 123 --input /absolute/decisions.json
```

Preview returns `jobRevision`, `sessionRevision`, sorted `approvals`, a
`previewToken` and `mutated: false`. Each approval contains identity, decision,
policy, eligibility, confidence, reason codes and answer revision, without the
saved answer value. Preview does not modify the fixture. Review its decisions
and policy outcome, then explicitly confirm with the returned token and the
same revisions and input:

```sh
node runtime/cli/native-jobs.js --root /private/tmp/new-native-jobs --native-lock /absolute/flock.node approval-approve --id synthetic-job --expected-job-revision 4 --expected-session-revision 123 --input /absolute/decisions.json --preview-token grouped-approval-v1.REPLACE_WITH_RETURNED_HASH --owner-confirmed
```

Both commands accept `--input -` for stdin. Commit returns `approved: true`,
the new `sessionRevision` and the stored `approvals`. These are direct fixture
service results; they do not introduce the compatibility task CLI envelope.

## Revision and consent boundaries

Commit requires explicit owner confirmation and a matching preview token.
Job, session, pending reference, answer identity and answer revision are checked
again before the write. A stale preview or unavailable answer requires a fresh
preview against current state. Semantic confidence, scope and sensitive-field
policy determine eligibility; recording a decision does not make an ineligible
answer eligible. Denied current use must carry `useAuthority: "none"`.

A commit updates only the selected session's approvals and timestamp. It retains
other current approvals and removes stale ones. It does not update the answer
Store, change job status, resolve pending fields or append application history.
The `remember` decision is recorded in the approval; this operation does not
persist a new answer value. Existing claim ownership does not block grouped
approval. No new journal or HTTP mutation endpoint is introduced.

In Companion, open the job's Activity section and select **Refresh activity**.
The existing view shows the number of current session approvals and identifies
pending items with a recorded approval. Changing the saved answer revision makes
the old approval disappear from that current projection. Approval counts describe
recorded decisions; they are not a guarantee of reuse eligibility. Final review
and submission remain human actions.

## Validation and remaining scope

Differential tests use separate synthetic native and Python roots to compare
policy results, preview tokens, failures and persisted sessions. The production
browser walkthrough runs the CLI with Python absent from PATH, verifies preview
is read-only and commit changes only the session, then refreshes Companion to
check approval visibility and later answer-revision invalidation. The activity
projection and UI are checked for absence of the synthetic answer value.

The version 9 fixture marker and inventory validation remain unchanged. General
native Store activation, writer handoff and installable Python-free packaging
remain separate work.
