# Native Jobs fixture

The opt-in native launcher runs React → HTTP → TypeScript → disk. Its CLI uses
the same Jobs service and cross-process native lock. The default Companion
launcher continues to use Python compatibility mode.

Supported operations are `job-create`, `job-get`, `job-list` and `job-update`,
including URL deduplication, revisions and human/agent provenance. Resume
selection validates a read-only registry; it does not inspect content or assert
preflight readiness. Profile and resume documents remain unchanged. Other
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
```

Input can also come from stdin with `--input -`. CLI JSON output uses the
lossless numeric/text codec; browser editing requires safe integer revisions.

## Boundaries and recovery

Only the readiness marker, Store lock, Jobs document and read-only profile/resume
documents are permitted in the fixture root. Unsupported domain state, journals,
leftover temporary files, symlinks, hard links and non-private files are rejected.
Keep the failed fixture for diagnosis; do not remove unknown state to force it
open. No automatic recovery or repair is implemented here.

The marker restricts this native implementation; it cannot stop an older Python
writer. Do not point Python, compatibility mode or real applicant data at this
root. General writer handoff and installable Python-free packaging remain later
milestones.

The tests create independent Python and native roots, compare Jobs behavior,
exercise native CLI contention with an empty PATH, inject persistence failures,
kill a lock holder, and run a production Next/browser conflict-and-reload flow.
No owner account, live Store, visible browser or plugin installation is used.
