# Native answer lifecycle fixture

The native fixture CLI and HTTP API support answer trash, restore and permanent
deletion for synthetic version 9 Stores.
This does not activate native writes on owner Stores or change Python launchers.

## Operations and integration

The `AnswerLifecycleService` exports `trash(key, revision)`,
`restore(key, revision)` and `delete(key, revision)`. It uses the existing
`AnswerRepository.answerTransaction` to read and write under the fixture lock.
No new journal or Store interface is introduced.

Shared dispatch composes `answerLifecycleHttp` before `answerHttp` and exposes
`answerLifecycleCommands` through the native CLI.
The CLI commands are `answer-trash`, `answer-restore` and `answer-delete`, each
requiring `--key` and `--expected-revision`. Both adapters use the same locked lifecycle service.

Authenticated `POST /api/answers/:urlEncodedKey/{trash,restore,delete}` and
`POST /api/answers/by-key/:base64urlKey/{trash,restore,delete}` accept
exactly `{"expectedRevision": CURRENT_REVISION}`. Revisions are positive integers;
booleans, JSON floats and additional confirmation fields are rejected. Explicit
permanent-delete confirmation belongs in the UI. Refresh canonical state after
acknowledgment or error; never blindly retry a destructive request.

Trash and restore return the existing answer mutation projection, with reference
counts and nonsensitive values. Sensitive values remain omitted. Delete returns
`{deleted: true, key}` or `{deleted: false, key}` for an absent identity. An absent
delete does not check the requested revision. Redirect sources remain immutable
and reject deletion even when there is no answer record at that source identity.

## Python parity and protected references

The authority is `scripts/job_apply_store/domains/answers/mutations.py`,
`read.py`, and `scripts/job_apply_workspace/domains/answers.py` plus `auth.py`.

Legacy answers without a revision use revision 1. Existing records check the
revision before no-op detection. No-op trash/restore preserves bytes and does not
sample timestamps. A changed trash samples deletion and update timestamps
separately; restore samples the update timestamp once. Trash rejects canonical
redirect targets. Restore of an already active target remains a no-op.

Permanent deletion checks redirect source identity, record presence, revision,
prior trash, incoming redirects, sessions, then history. Every session is
protected, including completed and abandoned sessions. Both `answerKeys` and
pending-field `answerKey` references block deletion. Application history remains
protected. The operation never erases references to make deletion succeed.

Reference errors use locked snapshot counts for sessions and history and fixed
redacted messages. Counts do not include question text, answer values, paths,
URLs or credentials. Immutable source deletion maps to `store_rejected`, matching
Python; immutable target trash maps to `redirect_target_blocked`. Missing records
map to 404, reference/revision conflicts to 409, and generic Store rejection to
400. OS failures return a fixed 500 `storage_error` without private exception text.

## Durability and verification

Only answers.json is written; jobs, resumes, sessions and history stay intact.
Tests inject write, file-sync and replace failures before canonical replacement,
verify original bytes, and retry through a fresh repository. An error after
canonical replacement may be ambiguous: do not assume the old answer still
exists or retry using the old revision. Refresh canonical state first.

`tests_js/workspace_native_lifecycle_answers.test.mjs` runs the actual native
repository with an isolated lock addon and independent copied Python Stores.
It compares returned results, errors and persisted answers for legacy records,
Unicode keys, sensitive values, redirects, all session states, pending fields,
and history. It also checks no-op bytes/clocks, strict HTTP payloads, CLI leaves,
redacted OS failures, and repository restart after pre-replacement failures.
Python and native never write the same Store. These fixture tests do not replace
shared dispatch, production browser, normal hook or installed-package acceptance.
