# Native task compatibility CLI fixture

The opt-in version 9 native fixture exposes the ten task commands through
`runtime/cli/native-task.js`. This entry point wraps the existing native services
in the Python task CLI's JSON success and error protocol. It does not change the
installed launcher or authorize migration of an existing applicant Store.

## Connect to a disposable fixture

Build the native runtime and addon and initialize a new synthetic Store as
explained in [Native Jobs fixture](native-jobs-fixture.md). Supply both native
connection flags before the command:

```sh
node runtime/cli/native-task.js --root /private/tmp/new-native-jobs --native-lock /absolute/flock.node snapshot
node runtime/cli/native-task.js --root /private/tmp/new-native-jobs --native-lock /absolute/flock.node intake --input /absolute/synthetic-job.json
node runtime/cli/native-task.js --root /private/tmp/new-native-jobs --native-lock /absolute/flock.node activity --id synthetic-job
```

`--root` and `--native-lock` select an explicitly initialized native fixture and
its addon. They are native connection requirements, separate from compatibility
of the task command protocol. The wrapper does not default to the owner's home
Store or activate Python-to-native writer handoff. Keep Python writers and real
applicant data away from the native fixture.

All `--input` arguments name UTF-8 JSON files containing an object. Unlike the
lower-level native Jobs CLI, this wrapper does not interpret `--input -` as stdin;
it names a file literally called `-`. Intake always uses agent provenance. The
lower-level `runtime/cli/native-jobs.js` entry point remains available with its
existing command names and service results.

## Commands and results

| Command | Required command arguments |
| --- | --- |
| `snapshot` | None |
| `activity` | `--id` |
| `intake` | `--input` |
| `select` | `--id`, `--expected-revision` |
| `resolve-pending-answer` | `--id`, `--reference`, `--expected-job-revision`, `--expected-session-revision`, `--expected-answer-revision` |
| `semantic-lookup` | `--input` |
| `cleanup-preview` | None |
| `cleanup-approve` | `--input` |
| `approval-preview` | `--id`, `--expected-job-revision`, `--expected-session-revision`, `--input` |
| `approval-approve` | `--id`, `--expected-job-revision`, `--expected-session-revision`, `--preview-token`, `--input` |

`select`, `resolve-pending-answer`, `cleanup-approve` and `approval-approve`
require explicit `--owner-confirmed` to perform their operation. Do not add this
flag without the owner's confirmation. Existing preflight, exact revision,
semantic reuse and preview-token checks remain in force. Grouped approval input
is an object containing only `decisions`; see the
[grouped approval fixture](native-grouped-approvals-fixture.md) for its fields.

Successful operations exit 0 and emit JSON on stdout with `ok: true` and the
command name. Snapshot nests its result under `snapshot`; activity returns
`jobId` and `activity`. Other commands include their service result in the
success envelope. Intake and snapshot retain their restricted job projections.
Errors exit 2 and emit `{"ok":false,"error":{"code":"…","message":"…"}}`
on stdout with generic, redacted messages and empty stderr. `--help` displays
usage rather than a task result.

## Validation boundary

The production Companion browser proof runs the wrapper with Python absent from
PATH against a disposable fixture. It captures a job, checks its visibility in
Jobs, verifies activity and snapshot envelopes, rejects selection without owner
confirmation without changing Jobs, then selects with confirmation and reloads
the canonical revision in Companion. This adds no HTTP endpoint or browser form.

Compatibility at this fixture boundary does not establish live writer handoff,
legacy Store adoption, installed launcher activation or complete Python-free
packaging. Those remain separate migration work.
