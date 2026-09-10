# Native workspace projections

The synthetic native fixture supports Overview, Needs Attention, and selected-job Activity in Companion. Overview opens native Facts, Resumes, Jobs, or Needs Attention. Attention opens the current canonical job; its detail dialog includes Activity and a route to Answers for pending information. Refresh updates resolved attention items. Failed reads retain an explicitly stale snapshot and offer retry.

These projections use the same native Store lock and recovery path as application work. Pending native journals are recovered before reading. An ordinary read with no recovery pending leaves canonical document and session bytes unchanged. Corrupt or unsupported state fails closed; it is never displayed as an empty workspace.

## Synthetic CLI and HTTP

Use a newly initialized v9 fixture and the native lock artifact described in [the claims fixture guide](native-claims-fixture.md). No existing/live Store is adopted or upgraded.

```sh
node runtime/cli/native-jobs.js --root /absolute/synthetic/root --native-lock /absolute/posix-lock.node owner-beta-overview
node runtime/cli/native-jobs.js --root /absolute/synthetic/root --native-lock /absolute/posix-lock.node needs-attention
node runtime/cli/native-jobs.js --root /absolute/synthetic/root --native-lock /absolute/posix-lock.node job-activity --id example-job
node runtime/cli/native-jobs.js --root /absolute/synthetic/root --native-lock /absolute/posix-lock.node job-preflight --id example-job
node runtime/cli/native-jobs.js --root /absolute/synthetic/root --native-lock /absolute/posix-lock.node task-snapshot
```

Authenticated GET routes are `/api/overview`, `/api/attention`, `/api/jobs/{id}/activity`, and `/api/jobs/{id}/preflight`. The task snapshot is CLI-only and combines overview, privacy-minimized jobs, and attention under one lock. CLI and HTTP call shared TypeScript services; neither invokes Python on the fixture.

Overview counts active jobs/resumes and accepted answers, derives missing setup, and checks actual resume readiness before recommending a ready job. Attention distinguishes expired claims, claimless interruptions, owner review, browser actions, and missing information, with stable ordering and a canonical snapshot signature. Activity includes only the selected job's history, claim timing, session readiness/blockers, and value-free pending-answer eligibility/current approvals. It omits URLs, notes, profile/resume content, pending question text, answer values, claim owner labels, and bearer credentials. Revisions remain lossless in the projections.

The response contracts preserve Python behavior for native-supported records. Existing native v9 validation is intentionally stricter: legacy sessions without durable pending references and unrelated corrupt sessions/history are rejected before projection. This does not establish compatibility with arbitrary legacy Stores.

## Remaining work

Expired claims can be recovered explicitly through native application controls. Claimless interruption recovery, recording Applied/Closed outcomes, lifecycle/Trash, and the remaining application transitions are not available in this native fixture yet. The UI states these limits. API guidance retains the existing Python contract; compatibility command names are not authorization to run Python against a native fixture.

Final submission on third-party sites remains human-only. Live Store adoption, native writer activation, and final Python-free package cutover remain separate milestones.
