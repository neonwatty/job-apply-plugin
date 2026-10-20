# Task 5B report: recorder runtime, capture, checkpoint, record, and CLI

## Status

Implemented the bounded 5B extraction on base
`6115e4a208f1b208e8d139c2637777e93e7b0c23`.

`qa/recorder.mjs` is now a 45-line executable/import-compatible facade. Broker,
isolated-world source, capture, checkpoint, record, and CLI responsibilities are
directional leaves. Promotion, replay, Chrome control, Task 5A primitives, and
the recorder-filesystem implementation were not modified.

## TDD evidence

Before production edits, `tests_js/recorder_facade_contract.test.mjs` and the
recorder source-privacy test were extended to require:

- strict facade-to-leaf identity for `BrokerClient`, `captureFullPagePng`,
  `inspectionHasSensitivePage`, and `commitCheckpoint`;
- strict `RecorderError` identity through broker, capture, and checkpoint error
  paths;
- exact isolated installer and snapshot source bytes;
- injected record/checkpoint CLI dispatch patch points; and
- no reverse import from any new leaf into the facade.

RED command:

```text
node --test --test-concurrency=1 tests_js/recorder_facade_contract.test.mjs tests_js/recorder.test.mjs
```

RED result: 4 passed, 5 failed for the intended missing-module reasons
(`broker-client.mjs`, `isolated-source.mjs`, and `cli.mjs`, plus the privacy and
reverse-import inventories awaiting the requested leaves).

After extraction, the focused facade/broker/capture/checkpoint/record command
passed 21/21. The final complete recorder command passed 45/45.

## Extracted responsibilities

- `broker-client.mjs`: serialized request queue, broker protocol, request
  deadlines, EOF grace, graceful SIGTERM, SIGKILL escalation, and shared abort
  deadline helpers. Its repository-root calculation was adjusted from `..` to
  `../..` solely because the implementation moved one directory deeper.
- `isolated-source.mjs`: the isolated installer and snapshot source builders.
- `capture.mjs`: ATS-sensitive inspection composition, isolated-world/frame
  management, bounded CDP screenshot capture, DPR/layout validation, script
  restoration, and decoded PNG handoff.
- `checkpoint.mjs`: lifecycle validation, capture transaction construction,
  broker-only evidence writes, atomic commit/rollback/sequence reuse, and the
  bounded local checkpoint client.
- `record.mjs`: event capture, safety revision coordination, local authenticated
  control server, checkpoint serialization, shutdown quiescence, receipts, and
  signal handling.
- `cli.mjs`: exact flag parsing, command dispatch, injectable runtime patch
  points, safe stderr selection, and exit behavior.
- `recorder.mjs`: original named exports and direct-execution guard only.

All checkpoint artifacts continue to be created, renamed, removed, and hashed
through the descriptor-bound `qa.recorder_fs` broker. Orchestration does not
reopen broker-owned paths.

## Compatibility contracts

The facade retains exactly these 14 named exports:

```text
BrokerClient
CAPTURE_LIMITS
CHECKPOINT_KINDS
RecorderError
captureFullPagePng
commitCheckpoint
decodeCapturedPng
inspectionHasSensitivePage
isSensitivePage
sanitizeObservedControl
validateCaptureResources
validateCheckpointKind
validateRecorderOptions
validateSafetyRevision
```

`RecorderError` remains the single class from `qa/recorder/errors.mjs`.
`BrokerClient`, `captureFullPagePng`, `inspectionHasSensitivePage`, and
`commitCheckpoint` are strict-identical facade/leaf bindings.

The isolated-source parity fixtures are:

```text
installer(__qa_fixture)  10fed2f5c068776aa2b3c3aae9659af32c79ebcfe7049b3c18b142524046c0e8
snapshot(false)          bf3b80c045d2b50812fb4c202eda92d05f36da36335a043de3a2a5abd3590100
snapshot(true)           335fb1cde036c46b15c12902d4cdccf26d87d59406d7daab3ed80dbaff44a415
```

## Physical line counts

| File | Lines |
| --- | ---: |
| `qa/recorder.mjs` | 45 |
| `qa/recorder/broker-client.mjs` | 195 |
| `qa/recorder/isolated-source.mjs` | 282 |
| `qa/recorder/capture.mjs` | 384 |
| `qa/recorder/checkpoint.mjs` | 288 |
| `qa/recorder/record.mjs` | 362 |
| `qa/recorder/cli.mjs` | 51 |
| `tests_js/recorder.test.mjs` | 124 |
| `tests_js/recorder_facade_contract.test.mjs` | 145 |

Every changed source and test is below 500 physical lines. Only the
`qa/recorder.mjs` baseline entry was removed.

## Verification

```text
node --test --test-concurrency=1 tests_js/recorder*.test.mjs
  PASS: 45/45

python3 -m unittest -v tests.test_recorder_fs
  PASS: 14/14

npm run test:qa-browser
  PASS: 104/104, serialized

npm run check:size
  PASS

bash scripts/smoke-plugin.sh
  PASS: static/package checks, 3/3 packaged browser and CLI walkthroughs,
  isolated Claude Code install, isolated Codex install and byte parity

node --check (facade and all six new leaves)
  PASS

git diff --check
  PASS
```

## Self-review

- Compared the moved capture functions mechanically with the base source;
  differences are only export markers and whitespace.
- Compared broker behavior mechanically; its only code change is the equivalent
  repository-root path for the deeper module location.
- Compared commit, checkpoint-client, flag-parser, record pre-checkpoint, and
  record post-checkpoint sections mechanically with the base source.
- Audited the checkpoint-writer parameterization: current write queue, safety
  revision, page sequence, and shutdown state are resolved at the same operation
  points as the monolith.
- Confirmed the dependency direction is facade -> CLI -> record -> checkpoint ->
  capture -> isolated source/shared 5A primitives, with broker helpers shared
  downward and no leaf importing the facade.
- Confirmed no promotion, replay, Chrome, recorder filesystem, or unrelated
  source was changed.

## Concerns

No known blocker or behavioral concern remains. The new non-facade exports are
internal composition seams; the public facade inventory is unchanged.
