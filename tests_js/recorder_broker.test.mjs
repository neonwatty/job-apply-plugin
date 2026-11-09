import { test } from "node:test";
import { BrokerClient, EventEmitter, abortCheckpointClient, access, assert, captureFullPagePng, chmod, chromium, commitCheckpoint, createHash, decodeCapturedPng, exerciseRejectedCaptureStates, http, inspectionHasSensitivePage, isSensitivePage, mkdir, mkdtemp, mockCaptureIsolated, once, path, postControl, readFile, readdir, rename, rm, root, runLauncher, runNode, sanitizeObservedControl, sendSlowPartialBody, spawn, startIndependentChromium, startPartialBody, startSyntheticSite, stat, stopChild, symlink, tmpdir, validateCaptureResources, validateCheckpointKind, validateRecorderOptions, validateSafetyRevision, waitForDevToolsActivePort, waitForExit, waitForFile, waitForInitialPageTarget, withTimeout, writeFile } from "./recorder_test_support.mjs";

test("broker request deadlines begin when serialized execution starts", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.stdin = {
    destroyed: false,
    write(payload, callback) {
      const { id } = JSON.parse(payload);
      setTimeout(() => client._handleLine(JSON.stringify({ id, ok: true, result: id })), 700);
      callback();
    },
    destroy() { this.destroyed = true; },
  };
  child.kill = () => {};
  const client = new BrokerClient(child, { close() {} });
  const started = Date.now();
  assert.deepEqual(await Promise.all([
    client.request("first"),
    client.request("second"),
  ]), [1, 2]);
  assert.ok(Date.now() - started >= 1300);
});

test("broker timeout fails the session and rejects later writes", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.stdin = {
    destroyed: false,
    write(_payload, callback) { callback(); },
    destroy() { this.destroyed = true; },
  };
  let killedWith;
  child.kill = (signal) => {
    killedWith = signal;
    child.exitCode = 1;
    child.emit("exit", 1, signal);
  };
  const client = new BrokerClient(child, { close() {} });
  await assert.rejects(client.request("slow"), /timed out|broker unavailable/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(killedWith, "SIGTERM");
  assert.equal(child.stdin.destroyed, true);
  await assert.rejects(client.request("late"), /broker unavailable/);
});

test("broker timeout escalates to SIGKILL only after graceful cleanup windows", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.stdin = {
    destroyed: false,
    write(_payload, callback) { callback(); },
    destroy() { this.destroyed = true; },
  };
  const signals = [];
  child.kill = (signal) => {
    signals.push({ signal, at: Date.now() });
    if (signal === "SIGKILL") child.exitCode = 1;
  };
  const client = new BrokerClient(child, { close() {} });
  const started = Date.now();
  await assert.rejects(client.request("blocked"), /timed out|broker unavailable/);
  await new Promise((resolve) => setTimeout(resolve, 1850));
  assert.deepEqual(signals.map(({ signal }) => signal), ["SIGTERM", "SIGKILL"]);
  assert.ok(signals[0].at - started >= 1200);
  assert.ok(signals[1].at - signals[0].at >= 1400);
});
