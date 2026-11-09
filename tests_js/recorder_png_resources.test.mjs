import { test } from "node:test";
import { BrokerClient, EventEmitter, abortCheckpointClient, access, assert, captureFullPagePng, chmod, chromium, commitCheckpoint, createHash, decodeCapturedPng, exerciseRejectedCaptureStates, http, inspectionHasSensitivePage, isSensitivePage, mkdir, mkdtemp, mockCaptureIsolated, once, path, postControl, readFile, readdir, rename, rm, root, runLauncher, runNode, sanitizeObservedControl, sendSlowPartialBody, spawn, startIndependentChromium, startPartialBody, startSyntheticSite, stat, stopChild, symlink, tmpdir, validateCaptureResources, validateCheckpointKind, validateRecorderOptions, validateSafetyRevision, waitForDevToolsActivePort, waitForExit, waitForFile, waitForInitialPageTarget, withTimeout, writeFile } from "./recorder_test_support.mjs";

test("capture resource limits accept boundaries and reject one over", () => {
  const limits = {
    maxControls: 2,
    maxHtmlBytes: 3,
    maxScreenshotWidth: 4,
    maxScreenshotHeight: 5,
    maxScreenshotBytes: 6,
    maxCheckpoints: 7,
    maxSessionBytes: 8,
  };
  assert.doesNotThrow(() => validateCaptureResources({
    controlCount: 2,
    htmlBytes: 3,
    screenshotWidth: 4,
    screenshotHeight: 5,
    screenshotBytes: 6,
    checkpointCount: 7,
    sessionBytes: 8,
  }, limits));
  for (const field of Object.keys({
    controlCount: 2,
    htmlBytes: 3,
    screenshotWidth: 4,
    screenshotHeight: 5,
    screenshotBytes: 6,
    checkpointCount: 7,
    sessionBytes: 8,
  })) {
    const value = {
      controlCount: 2,
      htmlBytes: 3,
      screenshotWidth: 4,
      screenshotHeight: 5,
      screenshotBytes: 6,
      checkpointCount: 7,
      sessionBytes: 8,
    };
    value[field] += 1;
    assert.throws(() => validateCaptureResources(value, limits), /capture resource limit/);
  }
});

test("captured PNG decoding is canonical, bounded, and dimension-locked", () => {
  const encoded =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const decoded = decodeCapturedPng(encoded, 1, 1);
  assert.ok(decoded.byteLength > 0);
  for (const invoke of [
    () => decodeCapturedPng("not base64", 1, 1),
    () => decodeCapturedPng(`${encoded}=`, 1, 1),
    () => decodeCapturedPng(encoded, 2, 1),
    () => decodeCapturedPng(encoded, 1, 2),
    () => decodeCapturedPng(encoded, 1, 1, decoded.byteLength - 1),
    () => {
      const corrupted = Buffer.from(decoded);
      corrupted[corrupted.length - 5] ^= 1;
      return decodeCapturedPng(corrupted.toString("base64"), 1, 1);
    },
  ]) {
    assert.throws(invoke, /invalid screenshot capture/);
  }
});

test("captured PNG decoding handles canonical near-limit base64 iteratively", () => {
  const small = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const payload = Buffer.alloc(4_900_001, 0x61);
  const ancillary = Buffer.alloc(payload.length + 12);
  ancillary.writeUInt32BE(payload.length, 0);
  ancillary.write("raNd", 4, "ascii");
  payload.copy(ancillary, 8);
  let crc = 0xffffffff;
  for (let index = 4; index < ancillary.length - 4; index += 1) {
    crc ^= ancillary[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  ancillary.writeUInt32BE((crc ^ 0xffffffff) >>> 0, ancillary.length - 4);
  const large = Buffer.concat([
    small.subarray(0, small.length - 12),
    ancillary,
    small.subarray(small.length - 12),
  ]);
  const encoded = large.toString("base64");
  assert.ok(large.byteLength > 4_800_000);
  assert.match(encoded, /==$/);
  assert.equal(decodeCapturedPng(encoded, 1, 1, large.byteLength).byteLength,
    large.byteLength);

  const midpoint = Math.floor(encoded.length / 2);
  const invalidValues = [
    `${encoded.slice(0, midpoint)}-${encoded.slice(midpoint + 1)}`,
    `${encoded}=`,
    encoded.slice(0, -1),
    `${encoded.slice(0, -3)}B==`,
  ];
  for (const value of invalidValues) {
    assert.throws(
      () => decodeCapturedPng(value, 1, 1, large.byteLength),
      (error) => error?.constructor?.name === "RecorderError" &&
        error.message === "invalid screenshot capture",
    );
  }
  assert.throws(
    () => decodeCapturedPng(encoded, 1, 1, large.byteLength - 1),
    (error) => error?.constructor?.name === "RecorderError" &&
      error.message === "invalid screenshot capture",
  );
});

test("checkpoint safety revision rejects transient document changes", () => {
  assert.doesNotThrow(() => validateSafetyRevision(7, 7));
  assert.throws(() => validateSafetyRevision(7, 9), /unstable page document/);
});
