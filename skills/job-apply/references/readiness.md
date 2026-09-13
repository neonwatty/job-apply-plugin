# Current-form readiness packet

Read before the durable awaiting-review handoff. Resolve paths from the installed `<plugin-root>`, not the current directory.

Bundled fixtures are under `<plugin-root>/qa/fixtures/<fixture-id>/fixture.json`. Inspect only plausible fixtures for the observed platform, such as `greenhouse-form-readiness-v1`, `workday-form-readiness-v1`, or `rippling-form-readiness-v1`. Their `steps[].controls[]` define control IDs, roles, and required flags. Enumerate the complete required controls from the live form first; select a fixture only if it represents that exact set. A missing match is a Needs Attention blocker, not permission to edit a fixture or omit extra controls.

The pure builders in `<plugin-root>/scripts/job_apply_form_readiness.py` provide the maintained serialization contract:

- `make_form_manifest(fixture, observation_revision=revision)` constructs the manifest. Its `complete=True` is an agent attestation; use it only after independently confirming the entire observed required-control set matches the fixture.
- `make_readiness_observation(fixture, control_states, observation_revision=revision, adapter_state=..., upload_capability=..., validation_error_control_ids=..., final_control_state=...)` constructs the value-free observation. Supply each state from current visible evidence. Explicitly provide adapter, upload, validation, and final-control state; do not rely on optimistic defaults.

Use one positive observation revision for that fresh observation and pass it unchanged to both builders and `expectedObservationRevision`. It is separate from the retained post-acquisition `attemptRevision`. Never reuse replay observations or generate success states by iterating a fixture: a fixture describes expected controls, not their observed completion. Verify a file control is accepted and ordinary fields are complete only from actual current browser evidence. Unknown, inaccessible, or rejected controls cannot support awaiting_review.

Build the private session object with these keys (replace the descriptive placeholders with objects and exact integer revisions):

```text
status: review
step: final_review
pendingFields: []
attemptRevision: retained post-acquisition job revision
readinessInput:
  attemptRevision: same retained job revision
  evidenceKind: agent_attested_current_attempt
  fixture: exact selected bundled fixture object
  formManifest: builder result from the verified complete required-control set
  observation: builder result from current observed states
  expectedObservationRevision: same fresh observation revision
```

Use the private `job-apply-attempt.py ... handoff --status awaiting_review --input <private-temp.json>` client in [application.md](application.md). The Store recomputes the report; an attempted write or successful local serialization is not a confirmed handoff. Delete private input on success or failure, preserve the draft on rejection, and never fall back to raw claim commands. Every final submission control remains untouched for the owner.
