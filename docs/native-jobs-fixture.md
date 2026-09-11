# Native Jobs fixture

The opt-in native launcher runs React → HTTP → TypeScript → disk. Its CLI uses
the same Jobs service and cross-process native lock. The default Companion
launcher continues to use Python compatibility mode.

Supported operations are `job-create`, `job-get`, `job-list` and `job-update`,
including URL deduplication, revisions and human/agent provenance. Resume
selection validates the shared registry. Managed resume import, list, get,
metadata update, file replacement, legacy adoption, default selection, integrity
check, content read and resolution are available through the same Store lock.
Facts/profile operations, [active claims](native-claims-fixture.md),
[workspace projections](native-projections-fixture.md), and
[job status transitions](native-job-transitions-fixture.md),
[CLI job upsert preview/commit](native-job-upsert-fixture.md), and
[CLI legacy job import](native-legacy-jobs-fixture.md) and
[CLI single-job task intake](native-task-intake-fixture.md) are also available. Other
workflows return `unsupported_native_workflow`; they never fall back to Python.

## Run against a new synthetic root

Build from the implementation checkout with its locked dependencies installed:

```sh
npm run build:runtime
npm run companion:build
node tools/build-native-lock.mjs --output /absolute/new/native-addon-directory
```

Use the artifact path returned by the native build as `/absolute/flock.node`
below. Choose a new absolute root under a real, private parent directory. On
macOS, use `/private/tmp` rather than its `/tmp` alias. Initialization refuses
existing directories; it does not migrate, copy or repair a Store.

```sh
node runtime/cli/native-jobs.js fixture-init --root /private/tmp/new-native-jobs
node apps/companion/launch.mjs --root /private/tmp/new-native-jobs --native-jobs-fixture /absolute/flock.node
```

Open the authenticated URL printed by the launcher. The native view opens Jobs
and identifies itself as a synthetic workspace. Tokens are not written to disk.

The CLI accepts the same input shapes as the corresponding Python Jobs commands:

```sh
node runtime/cli/native-jobs.js --root /private/tmp/new-native-jobs --native-lock /absolute/flock.node job-create --input /absolute/synthetic-job.json --origin human
node runtime/cli/native-jobs.js --root /private/tmp/new-native-jobs --native-lock /absolute/flock.node job-list
node runtime/cli/native-jobs.js --root /private/tmp/new-native-jobs --native-lock /absolute/flock.node job-update --id JOB_ID --expected-revision 1 --input /absolute/synthetic-patch.json
node runtime/cli/native-jobs.js --root /private/tmp/new-native-jobs --native-lock /absolute/flock.node resume-import --path /absolute/resume.pdf --input /absolute/resume-metadata.json
node runtime/cli/native-jobs.js --root /private/tmp/new-native-jobs --native-lock /absolute/flock.node resume-list
node runtime/cli/native-jobs.js --root /private/tmp/new-native-jobs --native-lock /absolute/flock.node resume-replace --id RESUME_ID --path /absolute/replacement.pdf --expected-revision 1
node runtime/cli/native-jobs.js --root /private/tmp/new-native-jobs --native-lock /absolute/flock.node resume-set-default --id RESUME_ID --expected-revision 2
node runtime/cli/native-jobs.js --root /private/tmp/new-native-jobs --native-lock /absolute/flock.node resume-check --id RESUME_ID
```

Input can also come from stdin with `--input -`. CLI JSON output uses the
lossless numeric/text codec; browser editing requires safe integer revisions.

## Boundaries and recovery

Only the initialized fixture inventory is permitted: the readiness marker, Store
lock, Jobs, profile, fact-groups, answers, resume registry/files and extraction
documents/journals, private sessions/history and coordinator/journal. Resume replacement writes a durable intent before installing bytes;
the next locked operation rolls that exact record forward after interruption and
clears owned staging files. Unknown state, symlinks, hard links, permissive files
and mismatched recovery identities are rejected. Keep the failed fixture for
diagnosis; do not remove unknown state to force it open.

The marker restricts this native implementation; it cannot stop an older Python
writer. Do not point Python, compatibility mode or real applicant data at this
root. General writer handoff and installable Python-free packaging remain later
milestones.

The tests create independent Python and native roots, compare Jobs behavior,
exercise native CLI contention with an empty PATH, inject persistence failures,
verify resume byte/metadata recovery, reject file swaps, kill a lock holder, and
run a production Next/browser conflict-and-reload flow with managed resume import.
No owner account, live Store, visible browser or plugin installation is used.

Facts/profile and managed resumes are available in newly initialized version 7
synthetic fixtures. See [Facts/profile commands and limits](native-facts-fixture.md).
Older fixtures must be recreated at a new path; they are not
automatically upgraded.

Version 7 also initializes `answers.json` for remembered-answer query, editing,
review and explicit reveal through native HTTP/CLI and the Answers tab. It supports durable merge, cleanup approval and idle pending-question resolution;
active coordinator claims remain unavailable. See [Answers scope](native-answers-fixture.md).

Extraction requests, proposals and review use the shared lock and extraction
journal. See [Extraction workflow and limits](native-extractions-fixture.md).
