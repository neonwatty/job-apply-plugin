---
name: answer-memory
description: Manage Job Apply's local profile, reusable answers, application history, and resumable sessions. Use whenever a Job Apply workflow needs to initialize, migrate, read, or update persistent applicant data.
allowed-tools: Read, Write, Bash
---

# Answer Memory

Use this skill as the storage contract for every Job Apply workflow. It manages local files through the bundled helper; it does not browse job sites or submit applications.

## Non-negotiable interface

Resolve `<plugin-root>` once before the first helper call:

1. In Codex, use the installed skill path shown in the skill catalog and walk up from `skills/answer-memory/SKILL.md` to the plugin root. If Codex exposes `PLUGIN_ROOT`, it may be used after confirming it contains `scripts/job-apply-store.py`.
2. In Claude Code, use `CLAUDE_PLUGIN_ROOT` after confirming it contains the helper.
3. Never assume the current working directory is the plugin root, and never search unrelated user directories for it.

Run the helper from that resolved root:

```bash
python3 "<plugin-root>/scripts/job-apply-store.py" <command>
```

### Approved local QA routing

An approved replay URL has the exact loopback form `http://127.0.0.1:<port>/#qa-route=<run-id>.<64-lowercase-hex-token>`. Before **any** storage command for that workflow, resolve the complete fragment value without navigating it or printing it:

```bash
python3 "<plugin-root>/scripts/qa-replay.py" resolve --route-token "<qa-route-token>"
```

The resolver returns one JSON field, `storeRoot`. For the entire replay, add `--root "<resolved-storeRoot>"` immediately after `job-apply-store.py` on **every** command, including `init`, `profile-get`, answer, history, and session commands. Never omit `--root`, use `JOB_APPLY_STORE_DIR`, inspect the default store, or fall back to `~/.job-apply/` during an approved local replay. If resolution fails, stop the replay without making any storage call. Treat the route token and resolved path as private run metadata and do not repeat them in prose or logs.

For replay lifecycle evidence, use `qa-replay.py started --run-id "<run-id>"` before form work and `qa-replay.py reviewed --run-id "<run-id>"` only at visible final review. These idempotent commands use the same isolated store helper and persist only the run identifier, platform label, statuses, timestamps, and empty answer-key/pending-field lists. Never manufacture replay history or session files. `reviewed` requires the correlated server review event, an ordered start, a matching nonterminal run, and zero final-action activations.

After evaluation, or when abandoning a prepared replay, retire its synthetic data with `python3 "<plugin-root>/scripts/qa-replay.py" cleanup --run-id "<run-id>"`. Cleanup authenticates shutdown of a prepared fixture server and never signals an unknown process. For race safety it never unlinks run artifacts: it turns them into zero-length sanitized tombstones through verified open descriptors. Completed runs retain their redacted report and lifecycle tombstone; abandoned runs retain only a meaningful lifecycle tombstone, with all synthetic content and routing secrets sanitized. Running cleanup again is safe.

The command examples below show normal persistent usage without a QA route. When a QA route is active, the explicit `--root` rule above overrides every example.

Do not directly create, parse, patch, append to, or replace files under `~/.job-apply/`. Do not recreate question normalization, answer keys, migration logic, permissions, or atomic writes in the agent. Use only helper commands described here and in [the storage contract](references/storage-contract.md).

Successful data commands return JSON on stdout. If the helper returns nonzero, stop the storage operation, preserve the existing files, and explain the failure without printing stored values.

## Initialize and locate the store

Start every workflow that needs persistent state with:

```bash
python3 "<plugin-root>/scripts/job-apply-store.py" init
```

This creates the local store if needed and non-destructively migrates an existing `~/.claude-job-profile.json`. The legacy file is never deleted or rewritten. To inspect resolved locations:

```bash
python3 "<plugin-root>/scripts/job-apply-store.py" paths
```

The default layout is:

```text
~/.job-apply/
  profile.json
  answers.json
  jobs.json
  resumes.json
  applications.jsonl
  sessions/
    <application-id>.json
  auto-submit/
    campaign.json
    applications/<campaign-ref>/<application-ref>.json
    receipts.jsonl
```

The `auto-submit/` directory is separate version-1 policy state. Ordinary `init` does not create or activate it, so existing stores remain `review_only` compatible.

## Auto-submit policy

Auto-submit policy is managed only through the inert local helper:

```bash
python3 "<plugin-root>/scripts/job_apply_policy.py" status
python3 "<plugin-root>/scripts/job_apply_policy.py" activate --input <campaign.json>
python3 "<plugin-root>/scripts/job_apply_policy.py" authorize --input <authorization.json>
python3 "<plugin-root>/scripts/job_apply_policy.py" claim-final-action \
  --input <fresh-observed-identity.json> \
  --application-ref <opaque-application-ref> --lease-id <opaque-lease-ref> \
  --attempt <1-or-2> --action-capability <private-64-hex-capability>
python3 "<plugin-root>/scripts/job_apply_policy.py" record-outcome \
  --campaign-id <opaque-campaign-ref> \
  --application-ref <opaque-application-ref> \
  --lease-id <opaque-lease-ref> \
  --claim-id <opaque-claim-ref> \
  --outcome <confirmed_submitted|uncertain|blocked> \
  [--confirmation-event <trusted-confirmation-event.json> \
   --confirmation-capability <private-64-hex-capability>]
python3 "<plugin-root>/scripts/job_apply_policy.py" kill
python3 "<plugin-root>/scripts/job_apply_policy.py" revoke
```

Apply the same explicit `--root` routing rule used by the storage helper, especially in local QA. `status` and `authorize` fail closed to `review_only`. Activation requires a trusted local input with explicit risk acknowledgement, exact immutable application rules, opaque resume and sensitive-answer revisions, at most ten slots, and at most four hours. No webpage, redirect, remembered tab, or inferred consent is policy input.

The initial lease reserves one distinct slot atomically. Authorization is idempotent, but consumption is not: the synthetic activation boundary rechecks the active campaign, kill switch, campaign and lease expiry, exact freshly observed identity, sensitive allowlist, ordinal, retry state, and private capability under the policy lock, then gives exactly one caller an activation. Detached claims and claim proofs are not activation authority. The first `uncertain` outcome allows exactly one second lease on the same slot; a second `uncertain` persists `uncertain_exhausted`. `confirmed_submitted` requires a distinct trusted confirmation event that independently observed activation; a click or caller digest is not confirmation. `kill` persists an immediate campaign-wide stop. Receipts and policy records must remain value-free.

This helper is policy/storage only and never controls a browser. The only executable adapter currently approved is the private isolated-loopback synthetic verifier. Live use remains prohibited until the separately reviewed canary package and exact canary approval.

## Supplying JSON input

Commands that accept `--input` require a JSON object. Use a user-only temporary file, remove it after the helper returns, and never print its contents to logs. The helper also accepts `--input -` when a caller already has a safe private stdin channel.

Do not place passwords, credentials, authentication tokens, CAPTCHA answers, payment data, or browser session data in any input.

## Profile and preferences

```bash
python3 "<plugin-root>/scripts/job-apply-store.py" profile-get
python3 "<plugin-root>/scripts/job-apply-store.py" profile-inspect
python3 "<plugin-root>/scripts/job-apply-store.py" profile-replace \
  --input <profile.json> --expected-revision <revision> \
  --source <user|resume|agent|migration>
python3 "<plugin-root>/scripts/job-apply-store.py" profile-patch \
  --input <patch.json> --expected-revision <revision> \
  --source <user|resume|agent|migration>
python3 "<plugin-root>/scripts/job-apply-store.py" preferences-get
python3 "<plugin-root>/scripts/job-apply-store.py" preferences-set \
  --input <preferences.json> --expected-revision <revision> \
  --source <user|resume|agent|migration> [--replace]
```

Inspect the profile immediately before either mutation and pass its current revision.
`preferences-set` merges supplied keys and preserves all other profile and preference
fields. Use `--replace` only after the user explicitly chooses to replace the full
preferences object. A revision conflict means the profile changed concurrently;
reload it and resolve the difference instead of retrying the stale write.

`profile-get` keeps the legacy raw-profile response. Use `profile-inspect` before a
selective edit to obtain the current revision and fact provenance, then pass that
revision to `profile-patch`. A conflict means another client changed the profile;
reload and show the user the current data instead of retrying a stale patch.

## Resume records

Resume records use stable IDs and managed private copies. New imports accept PDF,
DOCX, and UTF-8 TXT files up to 10 MiB, reject duplicate content including trash,
and never persist the import source path. Legacy absolute-path records remain valid
until explicitly adopted under the same ID.

```bash
python3 "<plugin-root>/scripts/job-apply-store.py" resume-create --input <resume.json>
python3 "<plugin-root>/scripts/job-apply-store.py" resume-import --input <resume.json>
python3 "<plugin-root>/scripts/job-apply-store.py" resume-list
python3 "<plugin-root>/scripts/job-apply-store.py" resume-get --id <resume-id>
python3 "<plugin-root>/scripts/job-apply-store.py" resume-update \
  --id <resume-id> --expected-revision <revision> --input <patch.json>
python3 "<plugin-root>/scripts/job-apply-store.py" resume-adopt \
  --id <legacy-resume-id> --expected-revision <revision> [--path <source-path>]
python3 "<plugin-root>/scripts/job-apply-store.py" resume-set-default \
  --id <resume-id> --expected-revision <revision>
python3 "<plugin-root>/scripts/job-apply-store.py" resume-check --id <resume-id>
python3 "<plugin-root>/scripts/job-apply-store.py" resume-trash \
  --id <resume-id> --expected-revision <revision>
python3 "<plugin-root>/scripts/job-apply-store.py" resume-restore \
  --id <resume-id> --expected-revision <revision>
python3 "<plugin-root>/scripts/job-apply-store.py" resume-delete \
  --id <resume-id> --expected-revision <revision>
```

`resume-create` remains compatible and now performs the same managed import as the
preferred `resume-import`. A `path` patch replaces bytes atomically for a managed
record while preserving its ID and job assignments; legacy records require
`resume-adopt`. The first active resume becomes the default unless explicitly
declined. Trashing fails while a resume is explicitly assigned to an active job,
or while the default is implicitly selected by an active job with no assignment.
Restore selects the resume only when it is the sole active record. Permanent
deletion requires trash and no job reference, and releases the content digest.
`resume-check` reports availability without mutating the stored observation.

## Resume extraction proposals

Extraction is performed by the calling agent and supplied as a bounded structured
JSON object; the helper does not parse, author, or tailor resumes. Inspect the
managed resume and profile revisions immediately before creating a proposal:

```bash
python3 "<plugin-root>/scripts/job-apply-store.py" resume-proposal-create \
  --resume-id <resume-id> --expected-resume-revision <resume-revision> \
  --expected-profile-revision <profile-revision> --input <candidate.json>
python3 "<plugin-root>/scripts/job-apply-store.py" resume-proposal-list \
  [--resume-id <resume-id>] [--status pending]
python3 "<plugin-root>/scripts/job-apply-store.py" resume-proposal-get --id <proposal-id>
python3 "<plugin-root>/scripts/job-apply-store.py" resume-proposal-review \
  --id <proposal-id> --expected-revision <proposal-revision> \
  --expected-profile-revision <profile-revision> --input <decisions.json>
```

Creation auto-fills only absent or null unprotected facts with `source=resume`.
Blank strings, existing arrays or objects, and human-cleared/protected facts remain
pending. Review input has the form
`{"decisions":{"/json/pointer":"use_extracted|keep_current"}}`; accepted values
are stamped `source=user`. A review may decide only some pending paths. Never retry
a revision or selected-baseline conflict against unseen state. Creating another
pending proposal for the same resume requires `--supersedes <proposal-id>` so the
old record remains auditable. Resume replacement, trash, deletion, missing bytes,
or digest drift makes a proposal stale.

## Reusable answers

Answer states have distinct behavior:

| State | Meaning | May fill without asking? |
|---|---|---|
| `confirmed` | The user confirmed this value | Yes, only when non-sensitive and scope still matches |
| `inferred` | A candidate derived from context | No; show it and ask |
| `missing` | No supported answer is known | No; ask |
| `sensitive` | Salary, authorization, visa, demographic, disability, or similar | Never; ask before every use |

Look up the exact question and relevant scope before filling:

```bash
python3 "<plugin-root>/scripts/job-apply-store.py" answer-find \
  --question "Are you authorized to work in the United States?" \
  --scope '{"country":"US"}'
```

Store a new reviewed non-sensitive answer with `answer-put --input <answer.json>`. Put creates accepted records only; use `answer-observe` to create pending records and `answer-review` to decline them. Updating through put requires `--expected-revision`; prefer selective `answer-update`. The helper owns stable keys and aliases and rejects normalized question/alias collisions inside the same exact scope.

For the shared answer-library surface, list and selectively edit records through
the helper. Existing records without explicit revisions are exposed as revision
1 and gain durable revision metadata on their next mutation.

```bash
python3 "<plugin-root>/scripts/job-apply-store.py" answer-list [--state <state>] \
  [--review-status <accepted|pending|declined> | --all-review-statuses] \
  [--query <text>] [--offset <n>] [--limit <n>] \
  [--include-trashed] [--trashed-only]
python3 "<plugin-root>/scripts/job-apply-store.py" answer-observe --input <observation.json>
python3 "<plugin-root>/scripts/job-apply-store.py" answer-review \
  --key <answer-key> --decision <accepted|declined> \
  --expected-revision <revision> [--input <patch.json>] [--remember-sensitive]
python3 "<plugin-root>/scripts/job-apply-store.py" answer-reveal --key <answer-key>
python3 "<plugin-root>/scripts/job-apply-store.py" answer-update \
  --key <answer-key> --expected-revision <revision> --input <patch.json>
python3 "<plugin-root>/scripts/job-apply-store.py" answer-merge \
  --winner-key <accepted-winner-key> --source-key <active-duplicate-key> \
  --expected-winner-revision <revision> --expected-source-revision <revision>
python3 "<plugin-root>/scripts/job-apply-store.py" answer-trash \
  --key <answer-key> --expected-revision <revision>
python3 "<plugin-root>/scripts/job-apply-store.py" answer-restore \
  --key <answer-key> --expected-revision <revision>
python3 "<plugin-root>/scripts/job-apply-store.py" answer-delete \
  --key <answer-key> --expected-revision <revision>
```

Legacy active records without `reviewStatus` are accepted without changing their stable keys or scopes. `answer-observe` creates a stable pending `missing` or `inferred` record; repeated observations update value-free observation metadata. This lock-serialized, additive observation update is the sole existing-record mutation that intentionally takes no expected revision: it changes only observation count/timestamps and never replaces canonical answer fields. Derived-key and redirect lookup must still match the record's current exact scope; an occupied historical key at another scope fails observation without mutation. Declined records stay durable for deduplication and are hidden from default views. Generic put/update operations cannot create or transition pending/declined review status; only `answer-review` can transition a pending record to accepted or declined. Every list item omits `value`, including non-sensitive answers, and reports reference counts. Permanent deletion requires trash and fails on any session or append-only history reference.

`answer-merge` requires an explicit accepted winner, an active duplicate source, exact matching scopes, and both current revisions. It preserves the winner value, sensitive-consent marker, source/provenance, state, and confirmation metadata; discards the source value; transfers the normalized source question and aliases; and combines only value-free observation counts/timestamps. A third-record alias collision fails before mutation. Mutable sessions are rewritten atomically through the existing crash-recovery coordinator. History is never rewritten: the removed key becomes a permanent flattened value-free redirect, and reads/reference counts resolve it to the winner. Redirect targets must remain active and cannot be trashed. Never try to reuse, restore, delete, or resurrect a merged source key.

### Sensitive answers require two decisions

Ask separately:

1. May I use this answer in the current form?
2. Would you like me to remember this specific answer for later applications?

Permission to fill is not permission to remember. If the user approves current use but not storage, do not persist the value. You may record a `sensitive` placeholder with `"value": null`.

Persist a non-null sensitive value only after explicit field-specific remember consent in the current interaction:

```bash
python3 "<plugin-root>/scripts/job-apply-store.py" answer-put \
  --input <sensitive-answer.json> \
  --remember-sensitive
```

Even a remembered sensitive answer must be shown and reconfirmed before each future form entry.
Changing a stored sensitive value through `answer-update` requires a fresh
`--remember-sensitive` decision. Editing only its aliases or question wording
does not manufacture a new retention decision.

## Application history

Append minimal lifecycle events using `history-append --input <event.json>`. History may contain application metadata and `answerKeys`; it must never duplicate answer values, profile data, credentials, or browser state.

Use `reviewed` when Job Apply reaches final review. Do not record `completed` unless the user later confirms that they personally submitted the application. A policy receipt is separate and never changes legacy history semantics.

```bash
python3 "<plugin-root>/scripts/job-apply-store.py" history-list
```

## Canonical jobs

Use the job commands for durable records shared by people, the companion UX,
and agent workflows. New jobs begin in `saved`. Updates and lifecycle changes
require the current positive `revision`, so stale clients cannot silently replace
newer edits.

```bash
python3 "<plugin-root>/scripts/job-apply-store.py" job-create --input <job.json>
python3 "<plugin-root>/scripts/job-apply-store.py" job-list [--status <status>]
python3 "<plugin-root>/scripts/job-apply-store.py" job-get --id <job-id>
python3 "<plugin-root>/scripts/job-apply-store.py" job-preflight --id <job-id>
python3 "<plugin-root>/scripts/job-apply-store.py" job-update \
  --id <job-id> --expected-revision <revision> --input <patch.json>
python3 "<plugin-root>/scripts/job-apply-store.py" job-transition \
  --id <job-id> --status <status> --expected-revision <revision>
python3 "<plugin-root>/scripts/job-apply-store.py" job-trash \
  --id <job-id> --expected-revision <revision>
python3 "<plugin-root>/scripts/job-apply-store.py" job-restore \
  --id <job-id> --expected-revision <revision>
python3 "<plugin-root>/scripts/job-apply-store.py" job-delete \
  --id <job-id> --expected-revision <revision>
```

Only explicit user confirmation may transition a reviewed job to `applied`; pass
`--user-confirmed` only for that direct confirmation. A job must be in recoverable
trash before permanent deletion. Use `--include-trashed` only when the user wants
to inspect or restore trashed records. Run `job-preflight` before `ready`; the
transition fails if the profile is empty or no usable assigned/default resume file
exists. Missing role or company and a changed resume file are warnings, not hidden
assumptions.

## Resumable sessions

Use `session-save --id <application-id> --input <session.json>` after meaningful non-final progress. Sessions may contain ATS/role/step metadata, `answerKeys`, and pending-field descriptions; they must not contain answer values.

```bash
python3 "<plugin-root>/scripts/job-apply-store.py" session-list
python3 "<plugin-root>/scripts/job-apply-store.py" session-load --id <application-id>
python3 "<plugin-root>/scripts/job-apply-store.py" session-delete --id <application-id>
```

Delete a session after the user confirms submission or explicitly abandons it. History remains separate.

## Ready-job agent handoff

Canonical ready jobs are consumed through the coordinator, not by a standalone `ready -> in_progress` transition. The store permits at most one global claim, uses a 300-second lease and 60-second heartbeat cadence, and stores only a SHA-256 token hash. `job-acquire` and `claim-recover` return the raw bearer token in their machine-readable stdout; treat that output as ephemeral and never repeat the token in user-facing text or persist it in logs, sessions, or temporary files.

```bash
python3 "<plugin-root>/scripts/job-apply-store.py" job-list --status ready
python3 "<plugin-root>/scripts/job-apply-store.py" job-acquire --id <job-id> --owner <owner-label> --expected-revision <revision>
python3 "<plugin-root>/scripts/job-apply-store.py" claim-status
python3 "<plugin-root>/scripts/job-apply-store.py" claim-heartbeat --id <job-id> --token <token>
python3 "<plugin-root>/scripts/job-apply-store.py" claim-progress --id <job-id> --token <token> --input <session.json>
python3 "<plugin-root>/scripts/job-apply-store.py" claim-handoff --id <job-id> --token <token> --status needs_info --expected-revision <revision> --input <session.json>
python3 "<plugin-root>/scripts/job-apply-store.py" claim-handoff --id <job-id> --token <token> --status awaiting_review --expected-revision <revision> --input <session.json>
python3 "<plugin-root>/scripts/job-apply-store.py" claim-recover --id <same-job-id> --owner <owner-label>
```

`job-acquire` requires the revision shown during selection, rechecks readiness under the global lock, and returns the resolved resume record, preferring the job's assigned resume over the active default. Terminal handoff likewise requires the post-acquisition or post-recovery revision retained by the caller; reloading just before handoff would mask a concurrent change. A stale revision fails without changing claim, job, history, or session state. A live claim is never stolen or silently released. Generic transition, trash, deletion, and session-mutation commands reject active canonical jobs. An expired claim can only be recovered explicitly for the same `in_progress` job; use `claim-status` to obtain that job ID. Recovery rotates the token and preserves its session and status. Heartbeat, progress, recovery, and both handoffs require canonical `in_progress` status. The session schema rejects explicit value fields, but allowed metadata strings cannot be classified semantically: callers must never encode answer values in `step`, question metadata, answer keys, or any other allowed string. The needs-info and review handoffs journal and roll forward job, history, session, and claim-release changes idempotently after a crash.

## Safety rules

1. Never bypass the helper for persistent data mutations.
2. Never print profile or answer values merely to diagnose storage.
3. Never infer remember consent from permission to fill a form.
4. Never copy answer values into history or sessions.
5. Never downgrade or overwrite corrupt or future-version files; report the helper error.
6. Never store credentials, authentication state, CAPTCHA/MFA data, or payment information.
7. Answer memory and inert Auto-submit policy never change the current rule that only the user may submit an application.
