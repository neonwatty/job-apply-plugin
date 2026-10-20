import { test } from "node:test";
import { BrokerClient, EventEmitter, abortCheckpointClient, access, assert, captureFullPagePng, chmod, chromium, commitCheckpoint, createHash, decodeCapturedPng, exerciseRejectedCaptureStates, http, inspectionHasSensitivePage, isSensitivePage, mkdir, mkdtemp, mockCaptureIsolated, once, path, postControl, readFile, readdir, rename, rm, root, runLauncher, runNode, sanitizeObservedControl, sendSlowPartialBody, spawn, startIndependentChromium, startPartialBody, startSyntheticSite, stat, stopChild, symlink, tmpdir, validateCaptureResources, validateCheckpointKind, validateRecorderOptions, validateSafetyRevision, waitForDevToolsActivePort, waitForExit, waitForFile, waitForInitialPageTarget, withTimeout, writeFile } from "./recorder_test_support.mjs";

test("bounded CDP screenshot command permits a stable capture after one second", async () => {
  const encoded =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const isolated = mockCaptureIsolated(async (command) => {
    if (command === "Page.getLayoutMetrics") {
      return { cssContentSize: { x: 0, y: 0, width: 1, height: 1 } };
    }
    if (command === "Page.captureScreenshot") {
      return new Promise((resolve) => setTimeout(() => resolve({ data: encoded }), 1500));
    }
    throw new Error("unexpected command");
  });
  const started = Date.now();
  const screenshot = await captureFullPagePng(
    isolated,
    1,
    1,
    new AbortController().signal,
  );
  const elapsed = Date.now() - started;
  assert.ok(screenshot.byteLength > 0);
  assert.ok(elapsed >= 1250, `screenshot completed too quickly: ${elapsed}ms`);
});

test("bounded CDP screenshot trusts only stable conservative DPR values", async () => {
  const encoded =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const layout = { cssContentSize: { x: 0, y: 0, width: 1, height: 1 } };
  for (const ratio of [1, 1.25, 2]) {
    let captureOptions;
    const isolated = mockCaptureIsolated(async (command, options) => {
      if (command === "Page.getLayoutMetrics") return layout;
      if (command === "Page.captureScreenshot") {
        captureOptions = options;
        return { data: encoded };
      }
      assert.fail(`unexpected command: ${command}`);
    }, ratio);
    assert.ok((await captureFullPagePng(
      isolated,
      1,
      1,
      new AbortController().signal,
    )).byteLength > 0);
    assert.equal(captureOptions.captureBeyondViewport, true);
    assert.equal(captureOptions.clip.scale, 1 / ratio);
  }

  for (const ratio of [0.5, 4.01, Number.NaN, Number.POSITIVE_INFINITY, "2", null]) {
    const isolated = mockCaptureIsolated(() => assert.fail("invalid DPR reached capture"), ratio);
    await assert.rejects(captureFullPagePng(
      isolated,
      1,
      1,
      new AbortController().signal,
    ), /invalid screenshot capture/);
  }
  const missing = mockCaptureIsolated(() => assert.fail("missing DPR reached capture"));
  missing.contexts.clear();
  await assert.rejects(captureFullPagePng(
    missing,
    1,
    1,
    new AbortController().signal,
  ), /invalid screenshot capture/);

  let dprReads = 0;
  const drifting = mockCaptureIsolated(async (command) => {
    if (command === "Page.getLayoutMetrics") return layout;
    if (command === "Page.captureScreenshot") return { data: encoded };
    assert.fail(`unexpected command: ${command}`);
  }, () => (++dprReads === 1 ? 2 : 1.25));
  await assert.rejects(captureFullPagePng(
    drifting,
    1,
    1,
    new AbortController().signal,
  ), /unstable page document/);
});

test("bounded CDP screenshot fails closed when script restoration is uncertain", async () => {
  const encoded =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const layout = { cssContentSize: { x: 0, y: 0, width: 1, height: 1 } };
  const capture = async (scriptHandler) => {
    const isolated = mockCaptureIsolated(async (command) => {
      if (command === "Page.getLayoutMetrics") return layout;
      if (command === "Page.captureScreenshot") return { data: encoded };
      assert.fail(`unexpected command: ${command}`);
    }, 1, scriptHandler);
    let detachCalls = 0;
    isolated.session.detach = async () => { detachCalls += 1; };
    await assert.rejects(captureFullPagePng(
      isolated,
      1,
      1,
      new AbortController().signal,
    ), /invalid screenshot capture/);
    return { isolated, detachCalls };
  };

  const retryCalls = [];
  let enableAttempts = 0;
  const restoredOnRetry = await capture((disabled) => {
    retryCalls.push(disabled);
    if (!disabled && ++enableAttempts === 1) throw new Error("restore failed once");
  });
  assert.deepEqual(retryCalls, [true, false, false]);
  assert.equal(restoredOnRetry.detachCalls, 0);
  assert.equal(restoredOnRetry.isolated.contexts.size, 1);

  const failedCalls = [];
  const neverRestored = await capture((disabled) => {
    failedCalls.push(disabled);
    if (!disabled) throw new Error("restore failed");
  });
  assert.deepEqual(failedCalls, [true, false, false]);
  assert.equal(neverRestored.detachCalls, 1);
  assert.equal(neverRestored.isolated.contexts.size, 0);
  assert.equal(neverRestored.isolated.allowedContexts.size, 0);
});

test("bounded CDP screenshot restores scripts after disable or capture failure", async () => {
  const layout = { cssContentSize: { x: 0, y: 0, width: 1, height: 1 } };
  for (const failureCommand of ["disable", "capture"]) {
    const scriptCalls = [];
    const isolated = mockCaptureIsolated(async (command) => {
      if (command === "Page.getLayoutMetrics") return layout;
      if (command === "Page.captureScreenshot") {
        throw new Error("capture failed");
      }
      assert.fail(`unexpected command: ${command}`);
    }, 1, (disabled) => {
      scriptCalls.push(disabled);
      if (disabled && failureCommand === "disable") throw new Error("disable failed");
    });
    await assert.rejects(captureFullPagePng(
      isolated,
      1,
      1,
      new AbortController().signal,
    ), new RegExp(`${failureCommand} failed`));
    assert.deepEqual(scriptCalls, [true, false]);
  }
});

test("bounded CDP screenshot command rejects timeout and protocol failure", async () => {
  const layout = { cssContentSize: { x: 0, y: 0, width: 1, height: 1 } };
  const stalled = mockCaptureIsolated(async (command) =>
    command === "Page.getLayoutMetrics" ? layout : new Promise(() => {}));
  const started = Date.now();
  await assert.rejects(captureFullPagePng(
    stalled,
    1,
    1,
    new AbortController().signal,
  ), /operation timed out/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 4500, `screenshot timed out too quickly: ${elapsed}ms`);
  assert.ok(elapsed < 8000, `screenshot timeout was not bounded: ${elapsed}ms`);
  const failed = mockCaptureIsolated(async (command) => {
    if (command === "Page.getLayoutMetrics") return layout;
    throw new Error("synthetic protocol failure");
  });
  await assert.rejects(captureFullPagePng(
    failed,
    1,
    1,
    new AbortController().signal,
  ), /synthetic protocol failure/);
});

test("bounded CDP screenshot rejects unsafe metrics and layout drift", async () => {
  const encoded =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const rejectsMetrics = async (content, width = 1, height = 1) => {
    const isolated = mockCaptureIsolated(async (command) => {
      if (command === "Page.getLayoutMetrics") return { cssContentSize: content };
      assert.fail("unsafe metrics reached screenshot capture");
    });
    await assert.rejects(captureFullPagePng(
      isolated,
      width,
      height,
      new AbortController().signal,
    ), /invalid screenshot capture|capture resource limit exceeded/);
  };
  for (const content of [
    { x: 1, y: 0, width: 1, height: 1 },
    { x: -1, y: 0, width: 1, height: 1 },
    { x: -0, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: Number.NaN, height: 1 },
    { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 1 },
    { x: 0, y: 0, width: 4096.1, height: 1 },
    { x: 0, y: 0, width: 1, height: 16384.1 },
  ]) await rejectsMetrics(content);
  await rejectsMetrics({ x: 0, y: 0, width: 1, height: 1 }, 1.5, 1);
  await rejectsMetrics({ x: 0, y: 0, width: 1, height: 1 }, 4097, 1);

  let metricReads = 0;
  const drifting = mockCaptureIsolated(async (command) => {
    if (command === "Page.getLayoutMetrics") {
      metricReads += 1;
      return { cssContentSize: {
        x: 0,
        y: 0,
        width: 1,
        height: metricReads === 1 ? 1 : 2,
      } };
    }
    return { data: encoded };
  });
  await assert.rejects(captureFullPagePng(
    drifting,
    1,
    1,
    new AbortController().signal,
  ), /unstable page document/);
});
