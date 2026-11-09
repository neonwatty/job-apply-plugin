# Persisted-state inventory discovery

Date: 2026-09-06. Requested discovery baseline: `05bf150`.
This is read-only source discovery, not an accepted exhaustive classification,
implementation receipt or assertion that the writer graph is closed. Proposed
owners use the migration graph's node IDs; integration must reconcile them with
the generated inventory and explicit package ownership before dispatch.

## Canonical Store paths

Paths below are relative to the configured Store root, never a live inspected
Store. No Store was opened and no persisted application data was read.

| Persisted path | Proposed owning nodes | Source evidence |
| --- | --- | --- |
| `profile.json` | PF | `scripts/job_apply_store/base.py:22` |
| `fact-groups.json` | PF | `scripts/job_apply_store/base.py:23` |
| `answers.json` | ANS | `scripts/job_apply_store/base.py:24` |
| `jobs.json` | JOB | `scripts/job_apply_store/base.py:25` |
| `resumes.json` | RES | `scripts/job_apply_store/base.py:26` |
| `resume-extractions.json` | RES | `scripts/job_apply_store/base.py:28` |
| `resume-extraction-requests.json` | RES | `scripts/job_apply_store/base.py:29` |
| `resume-extraction-journal.json` | JOUR / RES | `scripts/job_apply_store/base.py:30` |
| `applications.jsonl` | JOB; JOUR for cross-domain events | `scripts/job_apply_store/base.py:31` |
| `sessions/<safe-application-id>.json` | SESS | `scripts/job_apply_store/domains/sessions/document.py:64` |
| `coordinator.json` | SESS | `scripts/job_apply_store/base.py:33` |
| `coordinator-journal.json` | JOUR / SESS | `scripts/job_apply_store/base.py:34` |
| `automation-settings.json` | ACC | `scripts/job_apply_store/base.py:35` |
| `employer-accounts.json` | ACC | `scripts/job_apply_store/base.py:36` |
| `account-operation-journal.json` | JOUR / ACC | `scripts/job_apply_store/base.py:37` |
| `trusted-fill.json` | ACC | `scripts/job_apply_store/base.py:38` |
| `.store.lock` | TX | `scripts/job_apply_store/base.py:39` |
| `resume-files/<record.managedFile>` | RES / FS | `scripts/job_apply_store/domains/resumes/storage.py:55` |

The Store also references an external legacy profile, defaulting to
`~/.claude-job-profile.json` (`scripts/job_apply_store/base.py:44`). Treat that as
a migration input, not an ordinary canonical Store output.

## Dynamic and transient artifacts

- Session filenames derive from `_safe_session_id(application_id)`, then append
  `.json` (`scripts/job_apply_store/domains/sessions/document.py:64`). Their
  content/path identity is validated during startup
  (`scripts/job_apply_store/domains/startup.py:255`, `:290`).
- Managed resume files are resolved from persisted `managedFile` identities.
  Recovery includes quarantine names such as
  `.<previous.name>.<nonce>.quarantine`
  (`scripts/job_apply_store/domains/resumes/storage.py:375`), with additional
  lifecycle quarantine construction in
  `scripts/job_apply_store/domains/resumes/lifecycle.py:206`.
- Atomic JSON writes create sibling `.<target-name>.*.tmp` files before replace
  (`scripts/job_apply_store/io.py:105`). These are recovery/fault-injection
  artifacts and must not disappear from inventory merely because names vary.

This list identifies known dynamic patterns; it is not a complete inventory of
all staging, native, QA, replay or attempt artifacts.

## Separate policy storage

Proposed owners: FINAL for policy semantics, TX for durable primitives.
`scripts/job_apply_policy/storage.py:76` defines the `auto-submit` subtree:

- `auto-submit/campaign.json`
- `auto-submit/campaigns/<campaign-id-suffix>.json`
- `auto-submit/applications/<campaign-id-suffix>/<application-ref-suffix>.json`
- `auto-submit/receipts.jsonl`
- `auto-submit/.lock`

Dynamic application construction is in
`scripts/job_apply_policy/storage.py:95` and `:99`; archive construction is in
`scripts/job_apply_policy/campaigns.py:144` and `:161`. Policy writes use their
own atomic writer and lock implementation, so Store facade auditing alone cannot
establish that every canonical writer has migrated.

## Journal discriminators

All three Store journal envelopes permit `operation: null`.

| Journal | Discriminator and accepted values | Source evidence |
| --- | --- | --- |
| Coordinator | `operation.kind`: `answer_merge`, `answer_resolution`, `acquire`, `review_restart`, `recover`, `handoff` | `scripts/job_apply_store/domains/coordinator/persistence.py:139`, `:180`, `:243` |
| Extraction | `operation.kind`: `create`, `review`, `request-create`, `request-close`, `request-retry`, `request-complete`, `resume-request-close` | `scripts/job_apply_store/domains/extractions/journal.py:84` |
| Account operation | No `kind` field; `operation.stage`: `prepared`, `credential_provisioned`, `signup_in_progress` | `scripts/job_apply_store/domains/accounts/settings.py:87`, `:99` |

Extraction's legacy reduced envelope permits only `create` and `review`
(`scripts/job_apply_store/domains/extractions/journal.py:89`). Account-operation
outcome codes form an additional validated field; stage inventory does not cover
every operation transition or outcome contract.

## Nominal reads with write-capable dependencies

These methods call `initialize()` and therefore cannot be classified as pure
reads from their names or successful already-initialized fixture behavior:

| Method family | Source evidence |
| --- | --- |
| Profile get / inspect | `scripts/job_apply_store/domains/profile.py:282`, `:286` |
| Fact-group list / get | `scripts/job_apply_store/domains/profile_facts.py:64`, `:72` |
| Job get / list | `scripts/job_apply_store/domains/jobs/crud.py:138`, `:146` |
| Answer get / list / query / reveal / find / semantic lookup | `scripts/job_apply_store/domains/answers/read.py:184`, `:236`, `:250`, `:306`, `:320`, `:378` |
| Resume resolve / get / list | `scripts/job_apply_store/domains/resumes/read.py:74`, `:102`, `:113` |
| Extraction-request get / list | `scripts/job_apply_store/domains/extractions/requests.py:113`, `:120` |
| Employer-account list / get | `scripts/job_apply_store/domains/accounts/registry.py:108`, `:118` |
| Automation-settings get | `scripts/job_apply_store/domains/accounts/settings.py:140` |
| Claim status | `scripts/job_apply_store/domains/coordinator/claims.py:69` |

Claim status additionally calls `_ensure_coordinator_files()`. Other delegated
or indirect callers need an explicit call-graph audit; this table is a known
subset, not a complete command classification.

`initialize()` in `scripts/job_apply_store/domains/startup.py:52` performs:

- Private-directory creation/mode changes.
- Extraction-journal roll-forward and managed resume file recovery.
- Missing profile, answers, fact-group, jobs and resumes document creation.
- Legacy profile migration when the canonical profile is absent.
- History-file creation and mode enforcement.
- Coordinator file creation, pending-history-tail repair, coordinator journal
  roll-forward and history validation when coordinator state exists.

These effects appear at `scripts/job_apply_store/domains/startup.py:57`, `:64`,
`:72`, `:96`, `:108`, `:119`, `:130`, `:140` and `:149` respectively.
In contrast, `validate_workspace_startup()` explicitly calls existing-document
validation without initialization (`scripts/job_apply_store/domains/startup.py:159`).
Its no-write claim still requires the independent validation-path audit/tests.

## Integration follow-through

Reconcile every path, dynamic pattern and journal discriminator with inventory
rows and owning packages. Preserve lifecycle distinctions: pure existing-document
reads, lazy initialization, repair/recovery and explicit mutations. Trace shared
startup calls before assigning READ/PROJ behavior, and include policy/native/QA
writers before accepting CLOSE. No classification or completion gate is approved
by this discovery document alone.

Independent integration review added explicit resume staging patterns
`resume-files/.<resume-id>.*.tmp` and
`resume-files/.browser-upload.*<extension>` from
`scripts/job_apply_store/domains/resumes/storage.py:266` and `:330`.
The machine inventory now includes 28 artifact patterns and 19 journal variants.
Checker regressions reject drive-absolute/control/blank paths and unknown fields.
