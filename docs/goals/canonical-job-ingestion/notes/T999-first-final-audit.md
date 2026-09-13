# T999 First Final Audit

Decision: `not_complete`; `full_outcome_complete: false`.

The canonical ingestion workflow is executable and its core oracle passes: preview/commit CLI commands work, replay is idempotent, identity conflicts are deterministic, provenance is inspectable, human values survive agent enrichment, job-search uses the shared queue, and all 330 tests plus smoke checks pass.

Completion was rejected because default human `job-update` now silently ignores explicit null or empty values for optional fields. A human therefore cannot clear notes, descriptions, source metadata, or similar fields through the shared edit surface, despite prior helper behavior and the UX CRUD contract.

## Oracle map

- Usable human-and-agent CLI workflow: pass. Public `job-upsert-preview` and `job-upsert-commit` commands exist; the focused walkthrough passes; job-search previews structured agent input before confirmed commit.
- Preview has zero durable mutation and detects drift: pass. The focused test checks bytes, mtimes, absence of `.store.lock`, stale-token rejection, and unchanged `jobs.json`.
- Idempotent commit: pass. Fresh replay reports one noop, `committed=false`, one stable job ID, and final list count 1.
- Deterministic identity conflicts: pass. Focused tests and the walkthrough cover cross-record and incompatible identities without mutation.
- Human edit precedence: pass. Agent enrichment cannot replace a human role; agent-authored fields remain agent-updateable.
- Inspectable provenance: pass. JSON-pointer entries expose origin, observation source, and update time.
- Partial records remain safe: pass. URL-only records remain `saved`; invalid metadata does not move records into ready or applied.
- Existing behavior does not regress: fail. Creating notes and description, then applying default human `notes=None` and `description=''`, leaves revision 1 and the original values instead of applying the patch.
- Fresh regression and packaging proof: pass. Five focused tests, 330 repository tests, and plugin smoke validation passed during audit.
- Explicit non-goals remain excluded: pass. No migration, global claim, application-browser, or frontend implementation was added.

Required correction: restore direct human clearing semantics without allowing agent-origin null or empty values to clear human-authored data, then run a fresh final audit.
