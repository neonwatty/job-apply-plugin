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
python3 "<plugin-root>/scripts/job-apply-store.py" profile-replace --input <profile.json>
python3 "<plugin-root>/scripts/job-apply-store.py" preferences-get
python3 "<plugin-root>/scripts/job-apply-store.py" preferences-set --input <preferences.json>
```

`preferences-set` merges supplied keys and preserves all other profile and preference fields. Use `--replace` only after the user explicitly chooses to replace the full preferences object.

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

Store a reviewed non-sensitive answer with `answer-put --input <answer.json>`. The helper owns stable keys and aliases; omit `key` for a dynamic question unless a documented semantic key already exists.

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

## Application history

Append minimal lifecycle events using `history-append --input <event.json>`. History may contain application metadata and `answerKeys`; it must never duplicate answer values, profile data, credentials, or browser state.

Use `reviewed` when Job Apply reaches final review. Do not record `completed` unless the user later confirms that they personally submitted the application. A policy receipt is separate and never changes legacy history semantics.

```bash
python3 "<plugin-root>/scripts/job-apply-store.py" history-list
```

## Resumable sessions

Use `session-save --id <application-id> --input <session.json>` after meaningful non-final progress. Sessions may contain ATS/role/step metadata, `answerKeys`, and pending-field descriptions; they must not contain answer values.

```bash
python3 "<plugin-root>/scripts/job-apply-store.py" session-list
python3 "<plugin-root>/scripts/job-apply-store.py" session-load --id <application-id>
python3 "<plugin-root>/scripts/job-apply-store.py" session-delete --id <application-id>
```

Delete a session after the user confirms submission or explicitly abandons it. History remains separate.

## Safety rules

1. Never bypass the helper for persistent data mutations.
2. Never print profile or answer values merely to diagnose storage.
3. Never infer remember consent from permission to fill a form.
4. Never copy answer values into history or sessions.
5. Never downgrade or overwrite corrupt or future-version files; report the helper error.
6. Never store credentials, authentication state, CAPTCHA/MFA data, or payment information.
7. Answer memory and inert Auto-submit policy never change the current rule that only the user may submit an application.
