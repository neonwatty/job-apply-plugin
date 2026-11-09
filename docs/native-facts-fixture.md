# Native Facts/profile fixture

The React Companion now exposes Facts in compatibility mode and the explicit
native synthetic fixture. Profile, preferences and fact groups share TypeScript
services between HTTP and the native CLI. The default launcher remains Python.
No live Store is adopted, migrated or activated by this change.

Create a new root using the [native fixture instructions](native-jobs-fixture.md).
The fixture marker is now version 4 and initialization also creates
`fact-groups.json`. Version 1 and 2 disposable fixtures must be recreated at a new
path; existing roots are never automatically upgraded. Profile replacement with
revision zero cannot initialize or recover a missing profile in this mode.

## Commands

Use `node runtime/cli/native-jobs.js --root /absolute/synthetic/root
--native-lock /absolute/flock.node` followed by one of:

- `profile-get`, `profile-inspect`, `preferences-get`
- `profile-patch --input patch.json --expected-revision 1 --source user`
- `profile-replace --input profile.json --expected-revision 1 --source user`
- `preferences-set --input preferences.json --expected-revision 1 --source user`
  (add `--replace` to replace preferences instead of merging them)
- `fact-group-list`, `fact-group-get --id ID`
- `fact-group-create --input group.json`
- `fact-group-update --id ID --input patch.json --expected-revision 1`
- `fact-group-delete --id ID --expected-revision 1`

Input `-` reads stdin. Supported sources are `user`, `resume`, `agent` and
`migration`. Non-user sources cannot overwrite or delete user-provenanced facts.
These are fixture commands, not a cutover of the existing Python dispatcher.

The native HTTP adapter implements the existing GET/PATCH `/api/profile` and
fact-group GET/list/create/update/delete routes. HTTP edits always use `user`
provenance; callers cannot supply an alternative source. The existing token,
Host, Origin and body-size checks still apply. Preferences are edited through
the profile HTTP route. Unsupported workflows still return 501.

## Editing and persistence

Facts supports nested fields, work-history and education entries, skills,
preferences, additional facts, group editing and deletion, search, draft
preservation and explicit conflict reapply. Refreshing retains unsaved facts.
Navigation prompts before discarding edits. Group deletion does not delete facts.

Browser parsing, editing and serialization retain large integers, float tokens,
unknown fields and nulls using the same lossless value model as the native Store.
Saves patch only changed top-level facts; nested named objects use merge patches.
Additional facts support atomic replacement, null values and explicit deletion.
New named fields cannot use No value because their merge-patch null means deletion. Arrays are
atomic values: reapplying an edited array replaces that array, so review it before
saving. Deeply nested values beyond 12 editor levels are retained and can be
edited through the CLI.

Every mutation acquires the same cross-process lock as Jobs and uses atomic JSON
replacement. Stale revisions, invalid documents, unsupported state and journals
fail without repair. No-op edits leave file bytes and timestamps unchanged.
Provenance refinement retains authority on untouched siblings.

Fact-group label identity uses the Unicode 15.0 full casefold table from CPython
3.12. Regenerate it with `tools/contracts/profile-facts/casefold.py` under that
Python version; runtime use does not invoke Python. Other Unicode-version
identities are not claimed. Automatic group ordering fails at the supported
1,000,000 bound rather than writing a record that subsequent reads reject.

## Verification

`tests_js/workspace_native_profile.test.mjs` compares independent Python/native
Stores, profile and group mutation results, provenance, persistence, no-ops,
corrupt metadata, replacement failures and concurrent CLI revision conflicts.
The production browser walkthrough exercises both Jobs and Facts using native
processes with an empty PATH, then verifies disk contents and reload behavior.

This phase does not implement managed resume files, extraction, general recovery,
writer handoff, live Store activation or a complete Python-free package. Windows
and real-account testing remain outside this local fixture milestone.
