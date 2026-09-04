# Task 5A report: recorder safety and pure capture primitives

## Status

Complete. Recorder safety, resource, PNG, option-validation, and ATS predicates
are extracted into bounded leaves. Runtime broker, isolated-world, CDP capture,
checkpoint commit, record lifecycle, and CLI orchestration remain in the facade
for Task 5B.

Base: `cfe7e72c360797e68de35d430cf00b5bf87bdf03`.

## Compatibility contract

The facade preserves every observable named export. The brief's twelve-export
inventory is the twelve callable/class bindings below; the facade also retains
its two frozen constants, for fourteen module namespace names in total:

- `BrokerClient`
- `RecorderError`
- `captureFullPagePng`
- `commitCheckpoint`
- `decodeCapturedPng`
- `inspectionHasSensitivePage`
- `isSensitivePage`
- `sanitizeObservedControl`
- `validateCaptureResources`
- `validateCheckpointKind`
- `validateRecorderOptions`
- `validateSafetyRevision`
- `CAPTURE_LIMITS`
- `CHECKPOINT_KINDS`

`RecorderError` is defined once in `qa/recorder/errors.mjs`. The facade and all
leaves import or re-export that same class binding. A failing-first contract
test demonstrated the leaves were absent before extraction, then verified the
full namespace inventory, strict identity equality, cross-module
`instanceof`, and the prohibition on leaves importing `qa/recorder.mjs`.

## Extraction and line counts

| File | Physical lines |
| --- | ---: |
| `qa/recorder.mjs` | 1,510 |
| `qa/recorder/errors.mjs` | 1 |
| `qa/recorder/resources.mjs` | 134 |
| `qa/recorder/png.mjs` | 90 |
| `qa/recorder/safety/common.mjs` | 33 |
| `qa/recorder/safety/linkedin.mjs` | 40 |
| `qa/recorder/safety/greenhouse.mjs` | 65 |
| `qa/recorder/safety/ashby.mjs` | 52 |
| `qa/recorder/safety/lever.mjs` | 123 |
| `qa/recorder/safety/workday.mjs` | 96 |
| `tests_js/recorder_facade_contract.test.mjs` | 62 |

Every new source/test leaf is below 500 physical lines. The facade remains an
intentional Task 5B baseline exception. Its sole baseline ceiling was lowered
exactly from 2,087 to 1,510 lines, a 577-line reduction; no other baseline
entry changed and the recorder entry was not removed.

## Verification

- Failing-first contract run: one existing-inventory check passed and two
  leaf/import checks failed with `ERR_MODULE_NOT_FOUND`, as expected.
- Required focused command: 16 tests passed, 0 failed.
- Full `tests_js/recorder*.test.mjs` family: 42 tests passed, 0 failed in
  86.401 seconds.
- `npm run check:size`: passed with the exact 1,510-line recorder ceiling.
- `bash scripts/smoke-plugin.sh`: passed, including the three packaged browser
  and CLI walkthroughs plus isolated Claude Code and Codex installs.
- Syntax checks and `git diff --check`: passed.

## Self-review

- Compared each extracted predicate and validator with the base implementation;
  URL, frame, control-count, CAPTCHA, credential, canonical-base64, PNG CRC,
  path, symlink, loopback, sanitization, revision, and resource-limit checks are
  unchanged.
- Confirmed runtime deadlines/constants and all Task 5B-owned implementations
  remain in `qa/recorder.mjs`.
- Confirmed module dependencies are one-way: leaves use `errors.mjs` and safety
  common primitives, and no leaf imports the facade.
- Confirmed the diff is limited to the 5A allowed files plus this required
  coordination report.

## Concerns

None. The brief's phrase "twelve exports" excludes the two already-public
constants; the contract test deliberately freezes all fourteen observable
namespace names to avoid an API regression.
