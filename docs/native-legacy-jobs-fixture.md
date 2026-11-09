# Native legacy job import fixture

The opt-in version 9 native fixture supports `legacy-jobs-preview` and
`legacy-jobs-commit` through its CLI. The workflow discovers timestamped search
reports, previews selected entries and commits reviewed migration decisions
under the shared Store lock. Imported jobs appear in Companion Jobs after
Refresh or reload. It adds no legacy import HTTP route or browser selection UI.

Use a new synthetic Store initialized as described in
[Native Jobs fixture](native-jobs-fixture.md), plus a separate synthetic home
directory. Do not use an applicant's live Store or search reports, and do not
run Python writers against the native fixture.

## Discover, select and confirm

Discovery reads only immediate files named `search-*.md` within
`~/.claude-job-searches`. The CLI derives that path from its process home
directory. For a POSIX fixture, point only the CLI subprocess at a synthetic
home containing `.claude-job-searches`; keep the Store root separate. For
example, create `search-fixture.md` there with this synthetic content:

```markdown
### 1. Synthetic engineer — Fixture company
- **URL**: https://example.invalid/careers/fixture-job
- **Source**: Synthetic board
- **Location**: Fixture city
```

The native addon must include directory discovery support. Build the addon from
this checkout using the command in the Native Jobs fixture guide; an older
addon without that capability cannot perform discovery safely.

```sh
env HOME=/private/tmp/synthetic-legacy-home node runtime/cli/native-jobs.js --root /private/tmp/new-native-jobs --native-lock /absolute/flock.node legacy-jobs-preview
env HOME=/private/tmp/synthetic-legacy-home node runtime/cli/native-jobs.js --root /private/tmp/new-native-jobs --native-lock /absolute/flock.node legacy-jobs-preview --select ITEM_ID
env HOME=/private/tmp/synthetic-legacy-home node runtime/cli/native-jobs.js --root /private/tmp/new-native-jobs --native-lock /absolute/flock.node legacy-jobs-commit --select ITEM_ID --confirm PREVIEW_TOKEN
```

The first preview returns the root label, manifest and discovered items without
reading or initializing Jobs. Items include a stable item ID, source locator
and `valid` or `invalid` state; valid items contain parsed job fields. A missing
search directory produces an empty discovery result.

Repeat `--select ITEM_ID` for multiple entries, preserving selection order
between preview and commit. Selecting duplicate IDs, unknown items or invalid
items fails. A selected preview adds a token, per-item decisions and summary
counts for `create`, `update`, `noop`, `conflict` and `invalid`. It does not write
the planned Jobs document. Review all decisions before passing the token to
`--confirm`; conflict or invalid decisions do not prevent other valid selected
items from being committed. Commit reports `committed: true` only when Jobs
actually changes.

## Reports and source safety

The parser accepts numbered third-level headings in the form
`### 1. Role — Company`, with optional company score text, and supported labeled
fields. A plain HTTP or HTTPS `URL` or `Apply` value must resolve to one
normalized URL. Unsupported headings, duplicate labels, missing URLs and
ambiguous URLs are reported as invalid entries. Source, location, salary and
description labels map to the corresponding job fields.

Discovery is bounded to 100 matching files, 2 MiB per file, 20 MiB total and
5,000 entries. Reports must decode as UTF-8. The search root must be a regular
directory and matching entries must be regular files. Symlink roots and reports
are rejected. Discovery pins the root directory descriptor and inspects and
opens entries relative to it, checking file identity and size around reads.
Safety or limit failures reject discovery rather than silently omitting a
matching report. Reports are read only; import never rewrites them.

## Drift, provenance and refresh

The token binds the ordered selection, selected payloads and locators, the
entire discovered file manifest and the Jobs snapshot. Commit repeats discovery
and token validation while holding the Store lock. Report changes, selection
changes or Store changes reject a stale token. Preview again and review the
current decisions before retrying.

Imported fields receive migration provenance, and each successful record stores
its source locator in `legacySources`. Locator identity uses the report path and
entry ID, allowing an existing import to be found when report bytes change.
Migration can update fields still attributed to migration or fill empty fields;
it preserves nonempty human, agent and unattributed values. An imported URL can
refresh through a matching locator when its field remains eligible for migration
updates. Ambiguous identities and deleted matches remain conflicts.

A changed locator digest alone updates `legacySources` and increments the job
revision. Repeating an unchanged import is a no-op. New jobs start saved;
existing statuses are preserved. As in Python legacy import, an active claim
does not add a write prohibition for this operation. Import does not submit an
application or modify coordinator claims.

## Fixture boundary and remaining scope

Only this narrow repository operation may preview an absent `jobs.json` using
an empty epoch snapshot and persist it on a changed commit. The existing native
fixture marker and other inventory validation still apply. Pending recovery
operations must complete before import; previews do not replay journals. This is not a
mechanism to adopt an arbitrary legacy Store, repair damaged state or activate
native writes against live data. No new marker version or journal is introduced.

Model, differential, native CLI and discovery checks cover planning and safety
separately. Browser coverage verifies that CLI-imported records are visible in
Companion; it does not add a browser import workflow. Passing checks and CI are
recorded with the change's validation evidence.

[Single-job task intake](native-task-intake-fixture.md) is also available through
the native fixture CLI. General writer activation and installable Python-free
packaging remain later work.
