import { test } from "node:test";
import { BrokerClient, EventEmitter, abortCheckpointClient, access, assert, captureFullPagePng, chmod, chromium, commitCheckpoint, createHash, decodeCapturedPng, exerciseRejectedCaptureStates, http, inspectionHasSensitivePage, isSensitivePage, mkdir, mkdtemp, mockCaptureIsolated, once, path, postControl, readFile, readdir, rename, rm, root, runLauncher, runNode, sanitizeObservedControl, sendSlowPartialBody, spawn, startIndependentChromium, startPartialBody, startSyntheticSite, stat, stopChild, symlink, tmpdir, validateCaptureResources, validateCheckpointKind, validateRecorderOptions, validateSafetyRevision, waitForDevToolsActivePort, waitForExit, waitForFile, waitForInitialPageTarget, withTimeout, writeFile } from "./recorder_test_support.mjs";

test("checkpoint suspends responsive scripts for a complete mutation-free capture", async (t) => {
  const site = await startSyntheticSite(t);
  const { cdpUrl } = await startIndependentChromium(t, `${site}/application`);
  const attached = await chromium.connectOverCDP(cdpUrl);
  t.after(() => attached.close());
  const page = attached.contexts()[0].pages()[0];
  await page.setContent(`<!doctype html><title>Responsive application</title>
    <style>html,body{margin:0}main{width:1277px;height:4511px;
      background:repeating-linear-gradient(45deg,#fff 0 8px,#eaf0f6 8px 16px)}</style>
    <main><h1>Responsive application</h1><button type=button>Continue</button>
      <div id=bottom style="position:absolute;top:4400px;left:0;width:1277px;height:111px;
        background:rgb(12,34,56)"></div></main>
    <script>
      window.resizeMutations = 0;
      addEventListener("resize", () => {
        document.querySelector("main").dataset.resizeMutation =
          String(++window.resizeMutations);
      });
    </script>`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    window.resizeMutations = 0;
    delete document.querySelector("main").dataset.resizeMutation;
  });
  const captureSession = await page.context().newCDPSession(page);
  const metrics = await captureSession.send("Page.getLayoutMetrics");
  const { width, height } = metrics.cssContentSize;
  await page.evaluate(() => {
    window.resizeMutations = 0;
    delete document.querySelector("main").dataset.resizeMutation;
  });
  const directCapture = await captureSession.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width, height, scale: 1 },
  });
  assert.ok(decodeCapturedPng(directCapture.data, width, height).byteLength > 0);
  assert.equal(await page.evaluate(() => window.resizeMutations), 0);
  await captureSession.detach();

  const directory = await mkdtemp(path.join(tmpdir(), "responsive-screenshot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateRoot = path.join(directory, ".qa-private");
  await mkdir(privateRoot, { mode: 0o700 });
  const session = path.join(privateRoot, "qa-session-responsive");
  const recorder = spawn(process.execPath, [
    "qa/recorder.mjs", "record", "--cdp-url", cdpUrl, "--output", session,
  ], { cwd: root });
  let recorderStderr = "";
  recorder.stderr.setEncoding("utf8");
  recorder.stderr.on("data", (chunk) => { recorderStderr += chunk; });
  t.after(() => stopChild(recorder));
  await waitForFile(path.join(session, "control.json"), 10000);
  const checkpoint = await runNode([
    "qa/recorder.mjs", "checkpoint", "--session", session,
    "--kind", "application-opened",
  ], 10000);
  assert.equal(checkpoint.code, 0, checkpoint.stderr);
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => window.resizeMutations), 0);
  const screenshotPath = path.join(
    session,
    "checkpoints/0001-application-opened/page.png",
  );
  const screenshot = await readFile(screenshotPath);
  recorder.kill("SIGTERM");
  assert.deepEqual(await waitForExit(recorder, 5000), { code: 0, signal: null });
  assert.equal(recorderStderr, "");
  const imagePage = await attached.contexts()[0].newPage();
  const lowerPixel = await imagePage.evaluate(async (source) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    canvas.getContext("2d").drawImage(image, 100, 4450, 1, 1, 0, 0, 1, 1);
    return Array.from(canvas.getContext("2d").getImageData(0, 0, 1, 1).data);
  }, `data:image/png;base64,${screenshot.toString("base64")}`);
  assert.deepEqual(lowerPixel, [12, 34, 56, 255]);
});

test("CDP capture normalizes a trusted Retina DPR without viewport clipping", async (t) => {
  const site = await startSyntheticSite(t);
  const { cdpUrl } = await startIndependentChromium(
    t,
    `${site}/application`,
    ["--force-device-scale-factor=2"],
  );
  const attached = await chromium.connectOverCDP(cdpUrl);
  t.after(() => attached.close());
  const page = attached.contexts()[0].pages()[0];
  await page.setContent(`<!doctype html><title>Retina application</title>
    <style>html,body{margin:0;width:1200px}main{width:1200px;height:2200px;overflow:hidden;
      background:repeating-linear-gradient(45deg,#fff 0 8px,#dfe8f1 8px 16px)}</style>
    <main><h1>Retina application</h1><button type=button>Continue</button></main>`, {
    waitUntil: "domcontentloaded",
  });
  assert.equal(await page.evaluate(() => devicePixelRatio), 2);
  await page.evaluate(() => {
    Object.defineProperty(window, "devicePixelRatio", { value: 99 });
  });
  assert.equal(await page.evaluate(() => devicePixelRatio), 99);

  const actualSession = await page.context().newCDPSession(page);
  t.after(() => actualSession.detach().catch(() => {}));
  await actualSession.send("Page.enable");
  await actualSession.send("Runtime.enable");
  const tree = await actualSession.send("Page.getFrameTree");
  const mainFrame = tree.frameTree.frame;
  const world = await actualSession.send("Page.createIsolatedWorld", {
    frameId: mainFrame.id,
    worldName: "qa-recorder-retina-test",
    grantUniversalAccess: false,
  });
  const metrics = await actualSession.send("Page.getLayoutMetrics");
  const dom = await page.locator("main").evaluate((main) => ({
    width: main.scrollWidth,
    height: main.scrollHeight,
  }));
  assert.equal(dom.width, metrics.cssContentSize.width);
  assert.equal(dom.height, metrics.cssContentSize.height);
  let captureOptions;
  const isolated = {
    contexts: new Map([[mainFrame.id, world.executionContextId]]),
    allowedContexts: new Set([world.executionContextId]),
    session: { send: (command, options) => {
      if (command === "Page.captureScreenshot") captureOptions = options;
      return actualSession.send(command, options);
    } },
  };
  const screenshot = await captureFullPagePng(
    isolated,
    dom.width,
    dom.height,
    new AbortController().signal,
  );
  assert.equal(captureOptions.captureBeyondViewport, true);
  assert.deepEqual(captureOptions.clip, {
    x: 0,
    y: 0,
    width: dom.width,
    height: dom.height,
    scale: 0.5,
  });
  assert.ok(decodeCapturedPng(
    screenshot.toString("base64"),
    dom.width,
    dom.height,
  ).byteLength > 0);
});

test("CDP capture unions opposite-axis bounded DOM and layout extents", async (t) => {
  const site = await startSyntheticSite(t);
  const { cdpUrl } = await startIndependentChromium(t, `${site}/application`);
  const attached = await chromium.connectOverCDP(cdpUrl);
  t.after(() => attached.close());
  const page = attached.contexts()[0].pages()[0];
  await page.setContent(`<!doctype html><title>Offset application</title>
    <style>html,body{margin:0}main{position:absolute;left:-77px;top:120px;
      width:1277px;height:4511px;background:linear-gradient(#fff,#dfe8f1)}</style>
    <main><h1>Offset application</h1></main>`, { waitUntil: "domcontentloaded" });
  const dom = await page.locator("main").evaluate((main) => ({
    width: main.scrollWidth,
    height: main.scrollHeight,
  }));
  const actualSession = await page.context().newCDPSession(page);
  await actualSession.send("Page.enable");
  await actualSession.send("Runtime.enable");
  const tree = await actualSession.send("Page.getFrameTree");
  const mainFrame = tree.frameTree.frame;
  const world = await actualSession.send("Page.createIsolatedWorld", {
    frameId: mainFrame.id,
    worldName: "qa-recorder-union-test",
    grantUniversalAccess: false,
  });
  let captureOptions;
  const isolated = {
    contexts: new Map([[mainFrame.id, world.executionContextId]]),
    allowedContexts: new Set([world.executionContextId]),
    session: { send: (command, options) => {
      if (command === "Page.captureScreenshot") captureOptions = options;
      return actualSession.send(command, options);
    } },
  };
  t.after(() => actualSession.detach().catch(() => {}));
  const metrics = await actualSession.send("Page.getLayoutMetrics");
  assert.ok(dom.width > metrics.cssContentSize.width);
  assert.ok(dom.height < metrics.cssContentSize.height);
  const screenshot = await captureFullPagePng(
    isolated,
    dom.width,
    dom.height,
    new AbortController().signal,
  );
  assert.equal(captureOptions.captureBeyondViewport, true);
  assert.deepEqual(captureOptions.clip, {
    x: 0,
    y: 0,
    width: dom.width,
    height: metrics.cssContentSize.height,
    scale: 1,
  });
  assert.ok(decodeCapturedPng(
    screenshot.toString("base64"),
    dom.width,
    metrics.cssContentSize.height,
  ).byteLength > 0);
});

test("checkpoint rejects a forced mutation during bounded CDP capture", async (t) => {
  const site = await startSyntheticSite(t);
  const { cdpUrl } = await startIndependentChromium(t, `${site}/application`);
  const attached = await chromium.connectOverCDP(cdpUrl);
  t.after(() => attached.close());
  const page = attached.contexts()[0].pages()[0];
  await page.setContent(`<!doctype html><title>Mutable application</title>
    <style>html,body{margin:0}main{width:1277px;height:4511px;
      background:repeating-linear-gradient(45deg,#fff 0 4px,#dfe8f1 4px 8px)}</style>
    <main><h1>Mutable application</h1><button type=button>Continue</button></main>`, {
    waitUntil: "domcontentloaded",
  });
  const directory = await mkdtemp(path.join(tmpdir(), "mutating-cdp-screenshot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateRoot = path.join(directory, ".qa-private");
  await mkdir(privateRoot, { mode: 0o700 });
  const session = path.join(privateRoot, "qa-session-mutating-cdp");
  const recorder = spawn(process.execPath, [
    "qa/recorder.mjs", "record", "--cdp-url", cdpUrl, "--output", session,
  ], { cwd: root });
  let recorderStderr = "";
  recorder.stderr.setEncoding("utf8");
  recorder.stderr.on("data", (chunk) => { recorderStderr += chunk; });
  t.after(() => stopChild(recorder));
  await waitForFile(path.join(session, "control.json"), 10000);

  const checkpointPromise = runNode([
    "qa/recorder.mjs", "checkpoint", "--session", session,
    "--kind", "application-opened",
  ], 10000);
  const temporaryDeadline = Date.now() + 5000;
  let temporaryObserved = false;
  while (Date.now() < temporaryDeadline) {
    const entries = await readdir(path.join(session, "checkpoints"));
    if (entries.some((entry) => entry.startsWith(".tmp-"))) {
      temporaryObserved = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(temporaryObserved, true);
  await page.locator("main").evaluate((main) => {
    main.dataset.forcedMutation = "1";
  });
  const checkpoint = await checkpointPromise;
  assert.equal(checkpoint.code, 1);
  assert.match(checkpoint.stderr, /checkpoint rejected/);
  assert.deepEqual(await readdir(path.join(session, "checkpoints")), []);
  recorder.kill("SIGTERM");
  assert.deepEqual(await waitForExit(recorder, 5000), { code: 0, signal: null });
  assert.equal(recorderStderr, "");
  await access(path.join(session, "capture-receipt.json"));
  assert.deepEqual(await readdir(path.join(session, "checkpoints")), []);
});
