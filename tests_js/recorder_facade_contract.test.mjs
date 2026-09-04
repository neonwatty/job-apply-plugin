import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

test("runtime leaves preserve facade identities and patch points", async () => {
  const [facade, broker, capture, checkpoint] = await Promise.all([
    import("../qa/recorder.mjs"),
    import("../qa/recorder/broker-client.mjs"),
    import("../qa/recorder/capture.mjs"),
    import("../qa/recorder/checkpoint.mjs"),
  ]);
  assert.equal(facade.BrokerClient, broker.BrokerClient);
  assert.equal(facade.captureFullPagePng, capture.captureFullPagePng);
  assert.equal(facade.inspectionHasSensitivePage, capture.inspectionHasSensitivePage);
  assert.equal(facade.commitCheckpoint, checkpoint.commitCheckpoint);

  const child = { exitCode: 1 };
  const client = new facade.BrokerClient(child, { close() {} });
  await assert.rejects(
    client.request("late"),
    (error) => error instanceof facade.RecorderError,
  );
  await assert.rejects(
    facade.captureFullPagePng({}, 0, 1),
    (error) => error instanceof facade.RecorderError,
  );
  await assert.rejects(
    facade.commitCheckpoint({}),
    (error) => error instanceof facade.RecorderError,
  );
});

test("isolated-world source remains byte-for-byte stable", async () => {
  const { isolatedInstallerSource, isolatedSnapshotSource } =
    await import("../qa/recorder/isolated-source.mjs");
  const digest = (source) => createHash("sha256").update(source).digest("hex");
  assert.equal(
    digest(isolatedInstallerSource("__qa_fixture")),
    "10fed2f5c068776aa2b3c3aae9659af32c79ebcfe7049b3c18b142524046c0e8",
  );
  assert.equal(
    digest(isolatedSnapshotSource(false)),
    "bf3b80c045d2b50812fb4c202eda92d05f36da36335a043de3a2a5abd3590100",
  );
  assert.equal(
    digest(isolatedSnapshotSource(true)),
    "335fb1cde036c46b15c12902d4cdccf26d87d59406d7daab3ed80dbaff44a415",
  );
});

test("CLI dispatch keeps record and checkpoint runtime patch points", async () => {
  const facade = await import("../qa/recorder.mjs");
  const { dispatchRecorderCommand } = await import("../qa/recorder/cli.mjs");
  const calls = [];
  const runtime = {
    runRecord: async (options) => calls.push(["record", options]),
    runCheckpoint: async (session, kind) => calls.push(["checkpoint", session, kind]),
  };
  await dispatchRecorderCommand([
    "record", "--output", "/tmp/.qa-private/capture",
    "--cdp-url", "http://127.0.0.1:9222",
  ], runtime);
  await dispatchRecorderCommand([
    "checkpoint", "--kind", "application-opened",
    "--session", "/tmp/.qa-private/capture",
  ], runtime);
  assert.deepEqual(calls, [
    ["record", {
      cdpUrl: "http://127.0.0.1:9222",
      output: "/tmp/.qa-private/capture",
    }],
    ["checkpoint", "/tmp/.qa-private/capture", "application-opened"],
  ]);
  await assert.rejects(
    dispatchRecorderCommand(["unknown"], runtime),
    (error) => error instanceof facade.RecorderError &&
      error.message === "invalid recorder command",
  );
});

test("recorder leaves never import the facade", async () => {
  const leaves = [
    "errors.mjs",
    "resources.mjs",
    "png.mjs",
    "broker-client.mjs",
    "isolated-source.mjs",
    "capture.mjs",
    "checkpoint.mjs",
    "record.mjs",
    "cli.mjs",
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
