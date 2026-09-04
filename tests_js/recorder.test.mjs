import { test } from "node:test";
import { BrokerClient, EventEmitter, abortCheckpointClient, access, assert, captureFullPagePng, chmod, chromium, commitCheckpoint, createHash, decodeCapturedPng, exerciseRejectedCaptureStates, http, inspectionHasSensitivePage, isSensitivePage, mkdir, mkdtemp, mockCaptureIsolated, once, path, postControl, readFile, readdir, rename, rm, root, runLauncher, runNode, sanitizeObservedControl, sendSlowPartialBody, spawn, startIndependentChromium, startPartialBody, startSyntheticSite, stat, stopChild, symlink, tmpdir, validateCaptureResources, validateCheckpointKind, validateRecorderOptions, validateSafetyRevision, waitForDevToolsActivePort, waitForExit, waitForFile, waitForInitialPageTarget, withTimeout, writeFile } from "./recorder_test_support.mjs";

test("shutdown quiesces events and an in-flight checkpoint before hashing", async (t) => {
  const site = await startSyntheticSite(t);
  const { browserProcess, cdpUrl } = await startIndependentChromium(t, `${site}/application`);
  const directory = await mkdtemp(path.join(tmpdir(), "recording-shutdown-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateRoot = path.join(directory, ".qa-private");
  await mkdir(privateRoot, { mode: 0o700 });
  const session = path.join(privateRoot, "qa-session-shutdown");
  const recorder = spawn(process.execPath, [
    "qa/recorder.mjs", "record", "--cdp-url", cdpUrl, "--output", session,
  ], { cwd: root });
  let recorderStderr = "";
  recorder.stderr.setEncoding("utf8");
  recorder.stderr.on("data", (chunk) => { recorderStderr += chunk; });
  t.after(() => stopChild(recorder));
  const controlPath = path.join(session, "control.json");
  await waitForFile(controlPath, 10000);
  const control = JSON.parse(await readFile(controlPath, "utf8"));

  const attached = await chromium.connectOverCDP(cdpUrl);
  const page = attached.contexts()[0].pages()[0];
  for (let index = 0; index < 12; index += 1) {
    await page.locator("#email").fill(`shutdown-race-${index}@example.invalid`);
  }
  const cdpSession = await attached.contexts()[0].newCDPSession(page);
  await cdpSession.send("Debugger.enable");
  await cdpSession.send("Debugger.pause");
  const inFlight = postControl(control, { kind: "application-opened" }).catch(() => ({ status: 0 }));
  const partialBodySettled = startPartialBody(control);
  await new Promise((resolve) => setTimeout(resolve, 100));
  recorder.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await cdpSession.send("Debugger.resume");
  await withTimeout(inFlight, 3000, "in-flight request did not settle");
  await withTimeout(partialBodySettled, 3000, "partial request did not settle");
  await attached.close();
  await waitForExit(recorder, 5000);

  assert.equal(recorderStderr, "");
  assert.equal(browserProcess.exitCode, null);
  await assert.rejects(access(controlPath));
  const checkpointNames = await readdir(path.join(session, "checkpoints"));
  assert.equal(checkpointNames.some((name) => name.startsWith(".tmp-")), false);
  const receipt = JSON.parse(await readFile(path.join(session, "capture-receipt.json"), "utf8"));
  assert.equal(Object.keys(receipt.sourceFiles).length, 2 + checkpointNames.length * 4);
  for (const checkpointName of checkpointNames) {
    assert.deepEqual((await readdir(path.join(session, "checkpoints", checkpointName))).sort(), [
      "checkpoint.json", "controls.json", "page.html", "page.png",
    ]);
  }
  for (const [relative, digest] of Object.entries(receipt.sourceFiles)) {
    const contents = await readFile(path.join(session, ...relative.split("/")));
    assert.equal(createHash("sha256").update(contents).digest("hex"), digest);
  }
  const expectedCheckpointFiles = checkpointNames.flatMap((name) => [
    "checkpoint.json", "controls.json", "page.html", "page.png",
  ].map((basename) => `checkpoints/${name}/${basename}`));
  assert.deepEqual(
    Object.keys(receipt.sourceFiles).sort(),
    ["events.jsonl", "recording-summary.json", ...expectedCheckpointFiles].sort(),
  );
});

test("recording stays anchored when the published session path is swapped", async (t) => {
  const site = await startSyntheticSite(t);
  const { browserProcess, cdpUrl } = await startIndependentChromium(t, `${site}/application`);
  const directory = await mkdtemp(path.join(tmpdir(), "recording-anchor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateRoot = path.join(directory, ".qa-private");
  await mkdir(privateRoot, { mode: 0o700 });
  const session = path.join(privateRoot, "qa-session-anchor");
  const recorder = spawn(process.execPath, [
    "qa/recorder.mjs", "record", "--cdp-url", cdpUrl, "--output", session,
  ], { cwd: root });
  let stderr = "";
  recorder.stderr.setEncoding("utf8");
  recorder.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => stopChild(recorder));
  const controlPath = path.join(session, "control.json");
  await waitForFile(controlPath, 10000);
  const control = JSON.parse(await readFile(controlPath, "utf8"));
  const anchoredParent = path.join(directory, "anchored-private");
  const anchored = path.join(anchoredParent, path.basename(session));
  const target = path.join(directory, "swap-target");
  await mkdir(target, { mode: 0o700 });
  await rename(privateRoot, anchoredParent);
  await symlink(target, privateRoot);

  const checkpoint = await postControl(control, { kind: "application-opened" });
  assert.equal(checkpoint.status, 200);
  recorder.kill("SIGTERM");
  await waitForExit(recorder, 5000);
  assert.equal(stderr, "");
  assert.equal(browserProcess.exitCode, null);
  assert.deepEqual(await readdir(target), []);
  const receipt = JSON.parse(await readFile(path.join(anchored, "capture-receipt.json"), "utf8"));
  for (const [relative, digest] of Object.entries(receipt.sourceFiles)) {
    const contents = await readFile(path.join(anchored, ...relative.split("/")));
    assert.equal(createHash("sha256").update(contents).digest("hex"), digest);
  }
});

test("recorder source has no prohibited browser data capture APIs", async () => {
  const source = await readFile(path.join(root, "qa", "recorder.mjs"), "utf8");
  for (const prohibited of [
    "context.cookies(", "storageState(", "response.body(",
    "localStorage", "sessionStorage", "authorization headers",
    "browser.close(", 'send("Browser.close"', "exposeBinding(", "page.content(",
  ]) {
    assert.equal(source.includes(prohibited), false, prohibited);
  }
});
