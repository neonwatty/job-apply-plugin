import { test } from "node:test";
import { BrokerClient, EventEmitter, abortCheckpointClient, access, assert, captureFullPagePng, chmod, chromium, commitCheckpoint, createHash, decodeCapturedPng, exerciseRejectedCaptureStates, http, inspectionHasSensitivePage, isSensitivePage, mkdir, mkdtemp, mockCaptureIsolated, once, path, postControl, readFile, readdir, rename, rm, root, runLauncher, runNode, sanitizeObservedControl, sendSlowPartialBody, spawn, startIndependentChromium, startPartialBody, startSyntheticSite, stat, stopChild, symlink, tmpdir, validateCaptureResources, validateCheckpointKind, validateRecorderOptions, validateSafetyRevision, waitForDevToolsActivePort, waitForExit, waitForFile, waitForInitialPageTarget, withTimeout, writeFile } from "./recorder_test_support.mjs";

test("terminal SIGINT lets the recorder finalize before its broker exits", {
  skip: process.platform === "win32",
}, async (t) => {
  const site = await startSyntheticSite(t);
  const { cdpUrl } = await startIndependentChromium(t, `${site}/application`);
  const directory = await mkdtemp(path.join(tmpdir(), "recording-terminal-sigint-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateRoot = path.join(directory, ".qa-private");
  await mkdir(privateRoot, { mode: 0o700 });
  const session = path.join(privateRoot, "qa-session-terminal-sigint");
  const recorder = spawn(process.execPath, [
    "qa/recorder.mjs", "record", "--cdp-url", cdpUrl, "--output", session,
  ], { cwd: root, detached: true });
  let recorderStderr = "";
  recorder.stderr.setEncoding("utf8");
  recorder.stderr.on("data", (chunk) => { recorderStderr += chunk; });
  t.after(() => stopChild(recorder));

  await waitForFile(path.join(session, "control.json"), 10000);
  await new Promise((resolve) => setTimeout(resolve, 100));
  process.kill(-recorder.pid, "SIGINT");
  const exit = await waitForExit(recorder, 5000);

  assert.equal(exit.code, 0);
  assert.equal(recorderStderr, "");
  await access(path.join(session, "capture-receipt.json"));
  await assert.rejects(access(path.join(session, "control.json")));
});

test("recorder inventories open shadow controls and refuses shadow credentials", async (t) => {
  const site = await startSyntheticSite(t);
  const { cdpUrl } = await startIndependentChromium(t, `${site}/application`);
  const attached = await chromium.connectOverCDP(cdpUrl);
  const page = attached.contexts()[0].pages()[0];
  await page.setContent("<!doctype html><main><h1>Application</h1><div id=host></div></main>");
  await page.locator("#host").evaluate((host) => {
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = "<label>Contact email<input type=email required></label>";
  });

  const directory = await mkdtemp(path.join(tmpdir(), "recording-shadow-controls-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateRoot = path.join(directory, ".qa-private");
  await mkdir(privateRoot, { mode: 0o700 });
  const session = path.join(privateRoot, "qa-session-shadow-controls");
  const recorder = spawn(process.execPath, [
    "qa/recorder.mjs", "record", "--cdp-url", cdpUrl, "--output", session,
  ], { cwd: root });
  let recorderStderr = "";
  recorder.stderr.setEncoding("utf8");
  recorder.stderr.on("data", (chunk) => { recorderStderr += chunk; });
  t.after(() => stopChild(recorder));
  await waitForFile(path.join(session, "control.json"), 20000);
  const checkpoint = await runNode([
    "qa/recorder.mjs", "checkpoint", "--session", session,
    "--kind", "application-opened",
  ], 15000);
  assert.equal(checkpoint.code, 0, checkpoint.stderr);
  recorder.kill("SIGTERM");
  await waitForExit(recorder, 5000);
  assert.equal(recorderStderr, "");
  const controls = JSON.parse(await readFile(
    path.join(session, "checkpoints", "0001-application-opened", "controls.json"),
    "utf8",
  ));
  const structuralHtml = await readFile(
    path.join(session, "checkpoints", "0001-application-opened", "page.html"),
    "utf8",
  );
  assert.equal(controls.some((control) =>
    control.role === "textbox" && control.sourceLabel === "Contact email" &&
      control.required === true), true);
  assert.match(structuralHtml, /Contact email/);

  await page.setContent("<!doctype html><main><h1>Application</h1><div id=host></div></main>");
  await page.locator("#host").evaluate((host) => {
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = "<label>Account password<input type=password></label>";
  });
  const refusedSession = path.join(privateRoot, "qa-session-shadow-password");
  const refused = await runNode([
    "qa/recorder.mjs", "record", "--cdp-url", cdpUrl, "--output", refusedSession,
  ], 15000);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /sensitive page refused/);
  await assert.rejects(access(path.join(refusedSession, "events.jsonl")));
  await attached.close();
});

test("qa Chrome launcher exposes recorder-compatible real CDP and persists its profile", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "qa-chrome-real-"));
  const home = path.join(directory, "home");
  const trash = path.join(home, ".Trash");
  const wrapper = path.join(directory, "injected chromium");
  const privateRoot = path.join(root, ".qa-private");
  await mkdir(home, { mode: 0o700 });
  await mkdir(trash, { mode: 0o700 });
  await mkdir(privateRoot, { mode: 0o700, recursive: true });
  const session = await mkdtemp(path.join(privateRoot, "launcher-real-"));
  const executable = chromium.executablePath().replaceAll("'", "'\\''");
  const wrapperSource = `#!/bin/sh\nexec '${executable}' --headless=new --no-sandbox --use-mock-keychain "$@"\n`;
  assert.match(wrapperSource, /--use-mock-keychain/);
  await writeFile(wrapper, wrapperSource);
  await chmod(wrapper, 0o700);
  t.after(async () => {
    await runLauncher(["stop", "--profile", "real-cdp"], home).catch(() => {});
    await rm(directory, { recursive: true, force: true });
    await rm(session, { recursive: true, force: true });
  });

  const first = await runLauncher([
    "start", "--profile", "real-cdp", "--chrome-path", wrapper,
  ], home);
  assert.equal(first.code, 0, first.stderr);
  const ready = JSON.parse(first.stdout);
  assert.match(ready.cdpUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  const attached = await chromium.connectOverCDP(ready.cdpUrl);
  const context = attached.contexts()[0];
  const pages = context.pages();
  const page = pages[0] ?? await context.newPage();
  for (const extra of pages.slice(1)) await extra.close();
  const site = await startSyntheticSite(t);
  await page.goto(`${site}/application`, { waitUntil: "commit", timeout: 10000 });
  await page.setContent(`<!doctype html><main><h1>Apply for this position</h1>
    <label>Contact email<input type=email required></label>
    <button type=button>Continue application</button></main>`);
  await attached.close();

  const recorder = spawn(process.execPath, [
    "qa/recorder.mjs", "record", "--cdp-url", ready.cdpUrl, "--output", session,
  ], { cwd: root });
  let recorderStderr = "";
  recorder.stderr.setEncoding("utf8");
  recorder.stderr.on("data", (chunk) => { recorderStderr += chunk; });
  try {
    await waitForFile(path.join(session, "control.json"), 10000);
  } catch (error) {
    assert.fail(`${error.message}: ${recorderStderr}`);
  }
  recorder.kill("SIGTERM");
  await waitForExit(recorder, 5000);
  assert.equal(recorderStderr, "");

  const marker = path.join(home, ".job-apply-qa", "chrome-profiles", "real-cdp", "persistence-marker");
  await writeFile(marker, "retained");
  const checked = await runLauncher(["check", "--profile", "real-cdp"], home);
  assert.equal(checked.code, 0, checked.stderr);
  const stopped = await runLauncher(["stop", "--profile", "real-cdp"], home);
  assert.equal(stopped.code, 0, stopped.stderr);
  const second = await runLauncher([
    "start", "--profile", "real-cdp", "--chrome-path", wrapper,
  ], home);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(await readFile(marker, "utf8"), "retained");
  assert.notEqual(JSON.parse(second.stdout).cdpUrl, "http://127.0.0.1:0");
  assert.equal((await runLauncher(["stop", "--profile", "real-cdp"], home)).code, 0);
});
