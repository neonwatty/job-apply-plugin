# Native single-job task intake fixture

The opt-in version 9 native fixture supports `task-intake` through its CLI.
It atomically resolves one incoming job to a canonical active record using the
same identity and provenance rules as [job upsert](native-job-upsert-fixture.md).
The operation creates, updates or returns an unchanged job while holding the
shared Store lock. There is no separate intake preview or confirmation token.
Captured jobs appear in Companion Jobs after Refresh or reload; this adds no
new HTTP endpoint or browser intake form.

## Capture a synthetic job

Initialize a new synthetic Store and build the native addon as described in
[Native Jobs fixture](native-jobs-fixture.md). Keep Python writers and real
applicant data away from this fixture. Create a JSON file containing one job
object, rather than the `jobs` array wrapper used by batch upsert:

```json
{"url":"https://example.invalid/task-fixture","role":"Synthetic engineer","company":"Fixture company"}
```

```sh
node runtime/cli/native-jobs.js --root /private/tmp/new-native-jobs --native-lock /absolute/flock.node task-intake --input /absolute/synthetic-job.json
node runtime/cli/native-jobs.js --root /private/tmp/new-native-jobs --native-lock /absolute/flock.node task-intake --input /absolute/synthetic-job.json --origin human
node runtime/cli/native-jobs.js --root /private/tmp/new-native-jobs --native-lock /absolute/flock.node task-snapshot
```

`--input -` reads JSON from stdin. Origin defaults to `agent`; only `human` and
`agent` are accepted. Agent intake preserves human-authored fields. Human intake
may replace the supplied editable fields according to the existing upsert rules.
Intake does not select the job as ready, acquire a claim or submit an application.
The existing `task-select` operation still requires explicit owner confirmation
and the exact revision.

## Result and failure behavior

The fixture CLI returns the service result directly: an object with `action`
(`create`, `update` or `noop`) and `job`. The job is the same restricted projection
used in `task-snapshot`: identity, role, company, location, workplace and employment
types, status, priority, revision and timestamps when present. It excludes URL,
description, notes, provenance and claim credentials. This narrow native result
does not replace the full compatibility task CLI envelope or its handoff workflow.

Repeated equivalent intake converges on the same job and returns `noop` without
rewriting Jobs or incrementing its revision. Conflicting identities, deleted
matches and invalid incoming jobs fail as `task intake conflict` or
`task intake invalid`. They do not partially apply the incoming job. Invalid
origins and malformed JSON are rejected at their existing validation boundaries.

As in the Python intake operation, an active claim does not prohibit ingestion
updates. Intake preserves status and does not alter coordinator claims, sessions
or application history. Ordinary editing retains its existing claim restrictions.

## Fixture boundary and validation

The existing version 9 marker, inventory validation and recovery rules apply.
Intake does not adopt a legacy Store, activate general native writes or change
the installed launcher default. Use a newly initialized fixture; no marker
upgrade or new journal is introduced.

Differential tests compare the native result and persisted Jobs against an
independent Python fixture. The production browser walkthrough captures through
the native CLI with Python absent from PATH, checks visibility in Companion,
preserves a human company edit on subsequent agent intake, verifies no-op
convergence and compares redacted intake output with the task snapshot.

General task lifecycle parity, writer handoff and installable Python-free
packaging remain later work.
