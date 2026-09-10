# Native job upsert fixture

The opt-in version 9 native fixture supports `job-upsert-preview` and
`job-upsert-commit` through its CLI. Both use the native Jobs repository and
shared Store lock. Committed records appear in Companion Jobs after Refresh or
reload. This tranche adds no upsert HTTP route or browser batch editor.

Use a new synthetic root initialized as described in
[Native Jobs fixture](native-jobs-fixture.md). Do not use a live applicant Store
or run Python writers against the native fixture.

## Preview and commit

The input must contain only a `jobs` array. For example:

```json
{
  "jobs": [
    {
      "url": "https://example.invalid/careers/fixture-job",
      "role": "Synthetic role",
      "company": "Fixture company"
    }
  ]
}
```

```sh
node runtime/cli/native-jobs.js --root /private/tmp/new-native-jobs --native-lock /absolute/flock.node job-upsert-preview --input /absolute/synthetic-batch.json --origin agent
node runtime/cli/native-jobs.js --root /private/tmp/new-native-jobs --native-lock /absolute/flock.node job-upsert-commit --input /absolute/synthetic-batch.json --origin agent --token PREVIEW_TOKEN
```

`--origin` is required and accepts `human` or `agent`; migration provenance is
reserved for the separate legacy import workflow. Input may also be supplied
through stdin using `--input -`.

Both commands return a token, summary counts for `create`, `update`, `noop`,
`conflict` and `invalid`, and an ordered decision for every input item. A
decision includes its input index and action, plus an ID, changed fields or a
reason where applicable. Preview reports `committed: false` and does not write
the planned Jobs document. Commit reports `committed: true` only when at least
one create or update is persisted.

## Identity, provenance and drift

The preview token binds the entire current Jobs document, origin and canonical
input. Canonical input trims string values and ignores object key order, while
preserving array order. Commit recalculates that binding under the Store lock;
changed input, origin or Jobs state rejects the token before applying the plan.
After drift, preview again and review the new decisions.

Matching uses normalized URLs and source identities. Differing duplicate
identities within the batch, ambiguous or deleted stored matches, incompatible
identities and deterministic ID collisions become conflict decisions. Invalid
items have their own decisions. Neither kind prevents other valid items in the
same batch from being committed. Review every decision, not only the aggregate
count or process exit status.

Agent input may refresh fields already attributed to an agent or fill empty
fields with no provenance. It preserves human and migration provenance, and
nonempty unattributed fields. Human input can update supplied ingest fields.
Empty incoming values do not clear stored fields. Accepted changes increment
the record revision and stamp provenance; no-op items do neither. A batch with
only no-op, conflict or invalid decisions leaves Jobs bytes unchanged and
returns `committed: false`, including when called through commit.

Upsert preserves the Python behavior for active claims: it does not add a
claim-based write prohibition. It does not submit applications or change job
status; newly captured jobs start saved.

## Validation and remaining scope

Native version 9 fixture validation remains strict across the existing Store
inventory. A corrupt or unsupported fixture is rejected; this workflow does
not adopt or repair legacy Stores. No new fixture marker or persisted journal
is introduced by upsert.

The browser walkthrough previews without creating a visible record, commits
through the native CLI with Python absent from PATH, edits the record through
Companion, and confirms a later agent batch preserves the human field while
filling a new field. It checks preview/commit agreement, reload, clean
navigation and a 390-pixel viewport. Service and CLI tests cover planning,
token drift and persistence separately.

Legacy import preview/commit and task intake remain later tranches. General
writer activation and installable Python-free packaging are also deferred.
