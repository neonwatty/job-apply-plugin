import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("recorder facade preserves its named export inventory", async () => {
  const recorder = await import("../qa/recorder.mjs");
  assert.deepEqual(Object.keys(recorder).sort(), [
    "BrokerClient",
    "CAPTURE_LIMITS",
    "CHECKPOINT_KINDS",
    "RecorderError",
    "captureFullPagePng",
    "commitCheckpoint",
    "decodeCapturedPng",
    "inspectionHasSensitivePage",
    "isSensitivePage",
    "sanitizeObservedControl",
    "validateCaptureResources",
    "validateCheckpointKind",
    "validateRecorderOptions",
    "validateSafetyRevision",
  ]);
});

test("pure recorder leaves share one RecorderError identity", async () => {
  const [facade, errors, resources, png] = await Promise.all([
    import("../qa/recorder.mjs"),
    import("../qa/recorder/errors.mjs"),
    import("../qa/recorder/resources.mjs"),
    import("../qa/recorder/png.mjs"),
  ]);
  assert.equal(facade.RecorderError, errors.RecorderError);
  assert.throws(
    () => resources.validateCaptureResources({ controlCount: -1 }),
    (error) => error instanceof facade.RecorderError,
  );
  assert.throws(
    () => png.decodeCapturedPng("invalid", 1, 1),
    (error) => error instanceof facade.RecorderError,
  );
});

test("recorder leaves never import the facade", async () => {
  const leaves = [
    "errors.mjs",
    "resources.mjs",
    "png.mjs",
    "safety/common.mjs",
    "safety/linkedin.mjs",
    "safety/greenhouse.mjs",
    "safety/ashby.mjs",
    "safety/lever.mjs",
    "safety/workday.mjs",
  ];
  for (const relative of leaves) {
    const source = await readFile(path.join(root, "qa/recorder", relative), "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*recorder\.mjs["']/);
  }
});
