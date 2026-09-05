import { test } from "node:test";
import { BrokerClient, EventEmitter, abortCheckpointClient, access, assert, captureFullPagePng, chmod, chromium, commitCheckpoint, createHash, decodeCapturedPng, exerciseRejectedCaptureStates, http, inspectionHasSensitivePage, isSensitivePage, mkdir, mkdtemp, mockCaptureIsolated, once, path, postControl, readFile, readdir, rename, rm, root, runLauncher, runNode, sanitizeObservedControl, sendSlowPartialBody, spawn, startIndependentChromium, startPartialBody, startSyntheticSite, stat, stopChild, symlink, tmpdir, validateCaptureResources, validateCheckpointKind, validateRecorderOptions, validateSafetyRevision, waitForDevToolsActivePort, waitForExit, waitForFile, waitForInitialPageTarget, withTimeout, writeFile } from "./recorder_test_support.mjs";

test("recorder captures sanitized interactions and secure sequential checkpoints", async (t) => {
  const site = await startSyntheticSite(t);
  const crossOriginSite = await startSyntheticSite(t);
  const { browserProcess, cdpUrl } = await startIndependentChromium(t, `${site}/application`);
  const directory = await mkdtemp(path.join(tmpdir(), "recording-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateRoot = path.join(directory, ".qa-private");
  await mkdir(privateRoot, { mode: 0o700 });
  const session = path.join(privateRoot, "qa-session-app");
  await mkdir(session, { mode: 0o700 });

  const recorder = spawn(process.execPath, [
    "qa/recorder.mjs", "record", "--cdp-url", cdpUrl, "--output", session,
  ], { cwd: root });
  let recorderStderr = "";
  recorder.stderr.setEncoding("utf8");
  recorder.stderr.on("data", (chunk) => { recorderStderr += chunk; });
  t.after(() => stopChild(recorder));
  const controlPath = path.join(session, "control.json");
  try {
    await waitForFile(controlPath, 10000);
  } catch (error) {
    assert.fail(`${error.message}: ${recorderStderr}`);
  }
  const controlText = await readFile(controlPath, "utf8");
  const control = JSON.parse(controlText);
  assert.deepEqual(Object.keys(control).sort(), ["port", "token"]);
  assert.match(control.token, /^[A-Za-z0-9_-]{32,}$/);

  const invalidRequests = [
    ["token", () => postControl(control, { kind: "application-opened" }, { token: "wrong" })],
    ["missing token", () => postControl(control, { kind: "application-opened" }, { omitAuthorization: true })],
    ["host", () => postControl(control, { kind: "application-opened" }, { host: "example.test" })],
    ["origin", () => postControl(control, { kind: "application-opened" }, { origin: "http://example.test" })],
    ["content type", () => postControl(control, { kind: "application-opened" }, { contentType: "text/plain" })],
    ["null", () => postControl(control, "null")],
    ["unknown key", () => postControl(control, { kind: "application-opened", extra: true })],
    ["kind", () => postControl(control, { kind: "secret-kind" })],
    ["size", () => postControl(control, `{"kind":"application-opened","padding":"${"x".repeat(70_000)}"}`)],
    ["lifecycle", () => postControl(control, { kind: "review-reached" })],
  ];
  for (const [label, request] of invalidRequests) {
    const response = await request();
    assert.notEqual(response.status, 200, label);
  }
  await sendSlowPartialBody(control);
  assert.deepEqual(await readdir(path.join(session, "checkpoints")), []);

  const attached = await chromium.connectOverCDP(cdpUrl);
  const pages = attached.contexts().flatMap((context) => context.pages());
  assert.equal(pages.length, 1);
  const page = pages[0];
  await page.evaluate((loginUrl) => {
    const frame = document.createElement("iframe");
    frame.id = "sensitive-child";
    frame.src = loginUrl;
    document.body.append(frame);
  }, `${site}/login`);
  await page.locator("#sensitive-child").contentFrame().locator("input[type=password]").waitFor();
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.id = "blocked-by-sensitive-child";
    button.textContent = "Never record while sensitive child";
    document.body.append(button);
  });
  await page.locator("#blocked-by-sensitive-child").click();
  await page.locator("#sensitive-child").contentFrame().locator("#login-email")
    .fill("sensitive-child@example.invalid");
  const childSensitive = await postControl(control, { kind: "application-opened" });
  assert.notEqual(childSensitive.status, 200);
  assert.deepEqual(await readdir(path.join(session, "checkpoints")), []);
  await page.locator("#sensitive-child").evaluate((element) => element.remove());
  await page.locator("#blocked-by-sensitive-child").evaluate((element) => element.remove());

  const mainSpoof = "main-world-binding-spoof-secret";
  await page.evaluate((secret) => {
    globalThis.__qaRecorderObserve?.({
      interactionType: "input",
      role: "textbox",
      label: secret,
      required: true,
    });
  }, mainSpoof);
  const ordinaryChild = await page.evaluateHandle((childUrl) => {
    const frame = document.createElement("iframe");
    frame.id = "ordinary-child";
    frame.src = childUrl;
    document.body.append(frame);
    return frame;
  }, `${crossOriginSite}/application`);
  await page.locator("#ordinary-child").contentFrame().locator("#email").waitFor();
  const childSpoof = "child-world-binding-spoof-secret";
  const childFrame = page.frames().find((frame) =>
    frame !== page.mainFrame() && frame.url() === `${crossOriginSite}/application`);
  await childFrame.evaluate((secret) => {
    globalThis.__qaRecorderObserve?.({
      interactionType: "input",
      role: "textbox",
      label: secret,
      required: true,
    });
  }, childSpoof);
  await ordinaryChild.dispose();
  const privateEmail = "private@example.invalid";
  const privateFilename = path.join(directory, "private-resume.pdf");
  await writeFile(privateFilename, "private uploaded bytes");
  await page.evaluate(() => {
    const label = document.createElement("label");
    label.id = "temporary-secret";
    label.innerHTML = 'Secret password<input id="password" type="password">';
    document.body.append(label);
  });
  await page.locator("#password").fill("never-capture-this");
  await page.locator("#temporary-secret").evaluate((element) => element.remove());
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  const expectedEmailEvent = (event) =>
    event.interactionType === "input" &&
    event.role === "textbox" &&
    event.sourceLabel === "Private Person email" &&
    event.required === true;
  const emailEventRecorded = async (predicate = expectedEmailEvent, afterIndex = 0) => {
    try {
      const text = await readFile(path.join(session, "events.jsonl"), "utf8");
      return text.trim().split("\n").filter(Boolean).map(JSON.parse)
        .some((event, index) => index >= afterIndex && predicate(event));
    } catch {
      return false;
    }
  };
  let capturedExpectedEmail = false;
  for (let attempt = 0; attempt < 4 && !capturedExpectedEmail; attempt += 1) {
    await page.locator("#email").fill("");
    await page.locator("#email").fill(privateEmail);
    const eventDeadline = Date.now() + 1000;
    while (Date.now() < eventDeadline && !capturedExpectedEmail) {
      capturedExpectedEmail = await emailEventRecorded();
      if (!capturedExpectedEmail) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
  assert.equal(capturedExpectedEmail, true);
  await page.locator("#resume").setInputFiles(privateFilename);
  await page.locator("#continue").click();
  await page.evaluate(() => {
    const untrusted = document.createElement("button");
    untrusted.id = "untrusted-event";
    untrusted.textContent = "Untrusted event secret";
    document.body.append(untrusted);
    untrusted.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const hidden = document.createElement("button");
    hidden.id = "hidden-trusted-event";
    hidden.textContent = "Hidden trusted secret";
    hidden.style.cssText = "position:fixed;left:20px;top:20px;opacity:0";
    document.body.append(hidden);
    const valueLeak = document.createElement("label");
    valueLeak.textContent = "Label contains value-leak-secret";
    valueLeak.insertAdjacentHTML("beforeend", '<input id="value-leak" value="value-leak-secret">');
    document.body.append(valueLeak);
    const unicodeLeak = document.createElement("label");
    unicodeLeak.textContent = "ＦＵＬＬＷＩＤＴＨ-ＳＥＣＲＥＴ details";
    unicodeLeak.insertAdjacentHTML("beforeend", '<input id="unicode-value-leak" value="fullwidth-secret">');
    document.body.append(unicodeLeak);
    const partialLeak = document.createElement("label");
    partialLeak.textContent = "Account ending CDEF12";
    partialLeak.insertAdjacentHTML("beforeend", '<input id="partial-value-leak" value="abcdef12">');
    document.body.append(partialLeak);
  });
  await page.locator("#hidden-trusted-event").click({ force: true });
  await page.locator("#value-leak").click();
  await page.locator("#unicode-value-leak").click();
  await page.locator("#partial-value-leak").click();
  await page.evaluate(() => {
    const upload = document.createElement("label");
    upload.textContent = "Upload private-resume.pdf";
    upload.insertAdjacentHTML("beforeend", '<input id="filename-leak" type="file">');
    document.body.append(upload);
    const choice = document.createElement("label");
    choice.textContent = "Choose selected-option-secret";
    choice.insertAdjacentHTML("beforeend", `<select id="selected-option-leak">
      <option value="">Choose</option>
      <option value="selected-option-secret">selected-option-secret</option>
    </select>`);
    document.body.append(choice);
  });
  await page.locator("#filename-leak").setInputFiles(privateFilename);
  await page.locator("#selected-option-leak").selectOption("selected-option-secret");
  const continueBox = await page.locator("#continue").boundingBox();
  const floodSession = await attached.contexts()[0].newCDPSession(page);
  for (let index = 0; index < 200; index += 1) {
    await floodSession.send("Input.dispatchMouseEvent", {
      type: "mousePressed", button: "left", clickCount: 1,
      x: continueBox.x + 2, y: continueBox.y + 2,
    });
    await floodSession.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", button: "left", clickCount: 1,
      x: continueBox.x + 2, y: continueBox.y + 2,
    });
  }
  await floodSession.detach();

  await page.goto(`${site}/login`);
  await page.locator("#login-email").fill("sensitive-main@example.invalid");
  await page.locator("#login-button").click();
  const sensitiveCheckpoint = await runNode([
    "qa/recorder.mjs", "checkpoint", "--session", session,
    "--kind", "application-opened",
  ]);
  assert.equal(sensitiveCheckpoint.code, 1);
  assert.match(sensitiveCheckpoint.stderr, /checkpoint rejected/);
  assert.doesNotMatch(sensitiveCheckpoint.stderr, /Sign in|password|127\.0\.0\.1/);
  assert.deepEqual(await readdir(path.join(session, "checkpoints")), []);
  await page.goto(`${site}/application`);
  const afterNavigationEmail = "after-navigation@example.invalid";
  await page.locator("#email").fill(afterNavigationEmail);

  const invisibleLabels = [
    "Hidden attribute control",
    "ARIA hidden control",
    "Display none control",
    "Visibility hidden control",
    "Zero size control",
    "Offscreen control",
    "Hidden frame control",
    "Nested hidden frame control",
  ];
  const visibleLabels = [
    "Below fold control",
    "Scrollable region control",
  ];
  await page.evaluate(() => {
    const fixture = document.createElement("div");
    fixture.id = "invisible-controls";
    fixture.innerHTML = `
      <label hidden>Hidden attribute control<input></label>
      <div aria-hidden=true><label>ARIA hidden control<input></label></div>
      <label style="display:none">Display none control<input></label>
      <label style="visibility:hidden">Visibility hidden control<input></label>
      <label>Zero size control<input style="width:0;height:0;padding:0;border:0"></label>
      <label style="position:fixed;left:-10000px;top:0">Offscreen control<input></label>
      <div style="height:1400px"></div>
      <label>Below fold control<input></label>
      <div style="width:100px;height:50px;overflow:auto">
        <label style="display:block;margin-left:2000px;width:200px">Scrollable region control<input></label>
      </div>`;
    document.body.append(fixture);
    const frame = document.createElement("iframe");
    frame.id = "hidden-controls-frame";
    frame.hidden = true;
    frame.srcdoc = "<label>Hidden frame control<input id=hidden-frame-input></label>";
    document.body.append(frame);
    const nested = document.createElement("iframe");
    nested.id = "nested-hidden-frame";
    nested.hidden = true;
    nested.srcdoc = `<iframe id="nested-visible-child"
      srcdoc="<label>Nested hidden frame control<input id='nested-hidden-input'></label>"></iframe>`;
    document.body.append(nested);
  });
  await page.locator("#hidden-controls-frame").contentFrame().locator("#hidden-frame-input")
    .waitFor({ state: "attached" });
  await page.locator("#nested-hidden-frame").contentFrame().locator("#nested-visible-child")
    .contentFrame().locator("#nested-hidden-input").waitFor({ state: "attached" });

  const cdpSession = await attached.contexts()[0].newCDPSession(page);
  await cdpSession.send("Debugger.enable");
  await cdpSession.send("Debugger.pause");
  await abortCheckpointClient(control, 100);
  await cdpSession.send("Debugger.resume");
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.deepEqual(await readdir(path.join(session, "checkpoints")), []);

  await exerciseRejectedCaptureStates({ page, control, session });


  await cdpSession.send("Debugger.pause");
  let firstSettled = false;
  let secondSettled = false;
  const firstConcurrent = postControl(control, { kind: "application-opened" });
  firstConcurrent.finally(() => { firstSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const secondConcurrent = postControl(control, { kind: "step-advanced" });
  secondConcurrent.finally(() => { secondSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const overflowConcurrent = await postControl(control, { kind: "validation-observed" });
  assert.equal(overflowConcurrent.status, 400);
  assert.equal(firstSettled, false);
  assert.equal(secondSettled, false);
  await cdpSession.send("Debugger.resume");
  const concurrentStatuses = await Promise.all([firstConcurrent, secondConcurrent]);
  assert.ok(concurrentStatuses.every((response) => [200, 400].includes(response.status)));
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const [index, kind] of ["application-opened", "step-advanced"].entries()) {
    if (concurrentStatuses[index].status === 200) continue;
    const retry = await runNode([
      "qa/recorder.mjs", "checkpoint", "--session", session, "--kind", kind,
    ], 5000);
    assert.equal(retry.code, 0, retry.stderr);
  }
  // Keep the original filled checkpoint state, then record a distinct input on
  // the stable document after frame mutations/checkpoint inspections.
  // Mutating the DOM immediately after fill can correctly invalidate the
  // recorder's asynchronous privacy inspection and discard that interaction.
  const stableNavigationEmail = "stable-navigation@example.invalid";
  // The original input may already match: only newly appended evidence can
  // acknowledge this stable input before the test connection disconnects.
  const previousEvents = (await readFile(path.join(session, "events.jsonl"), "utf8"))
    .trim().split("\n").filter(Boolean).length;
  await page.locator("#email").fill(stableNavigationEmail);
  const postNavigationEvent = (event) => expectedEmailEvent(event) && event.pageSequence >= 2;
  const eventDeadline = Date.now() + 5000;
  while (!(await emailEventRecorded(postNavigationEvent, previousEvents)) && Date.now() < eventDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(await emailEventRecorded(postNavigationEvent, previousEvents), true,
    "post-navigation input must be durably recorded before disconnecting");
  await attached.close();

  for (const kind of [
    "validation-observed",
    "review-reached",
    "final-action-boundary",
  ]) {
    const result = await runNode([
      "qa/recorder.mjs", "checkpoint", "--session", session, "--kind", kind,
    ], 5000);
    assert.equal(result.code, 0, `checkpoint ${kind} must succeed`);
  }
  const duplicate = await runNode([
    "qa/recorder.mjs", "checkpoint", "--session", session,
    "--kind", "final-action-boundary",
  ]);
  assert.equal(duplicate.code, 1);
  assert.doesNotMatch(duplicate.stderr, /final-action-boundary/);

  recorder.kill("SIGTERM");
  await waitForExit(recorder, 5000);
  assert.equal(recorderStderr, "");
  assert.equal(browserProcess.exitCode, null);
  await assert.rejects(access(controlPath));

  const checkpointNames = await readdir(path.join(session, "checkpoints"));
  assert.deepEqual(checkpointNames, [
    "0001-application-opened",
    "0002-step-advanced",
    "0003-validation-observed",
    "0004-review-reached",
    "0005-final-action-boundary",
  ]);
  for (const [index, directoryName] of checkpointNames.entries()) {
    const checkpointDir = path.join(session, "checkpoints", directoryName);
    assert.deepEqual((await readdir(checkpointDir)).sort(), [
      "checkpoint.json", "controls.json", "page.html", "page.png",
    ]);
    const metadata = JSON.parse(await readFile(path.join(checkpointDir, "checkpoint.json"), "utf8"));
    assert.deepEqual(Object.keys(metadata).sort(), ["kind", "pageSequence", "sequence", "timestamp"]);
    assert.equal(metadata.sequence, index + 1);
  }

  const eventsText = await readFile(path.join(session, "events.jsonl"), "utf8");
  const controlsText = await readFile(
    path.join(session, "checkpoints", checkpointNames[0], "controls.json"),
    "utf8",
  );
  const receiptText = await readFile(path.join(session, "capture-receipt.json"), "utf8");
  for (const forbidden of [
    privateEmail,
    afterNavigationEmail,
    stableNavigationEmail,
    "Secret password",
    "private-resume.pdf",
    cdpUrl,
    `${site}/application`,
    control.token,
    mainSpoof,
    childSpoof,
    '"value"',
    '"checked"',
    '"files"',
    '"filename"',
    '"textContent"',
    '"href"',
    '"url"',
  ]) {
    assert.equal(`${eventsText}\n${controlsText}\n${receiptText}`.includes(forbidden), false, forbidden);
  }
  const events = eventsText.trim().split("\n").map(JSON.parse);
  for (const line of eventsText.trim().split("\n")) {
    assert.ok(Buffer.byteLength(line) <= 1024);
  }
  assert.ok(events.some(expectedEmailEvent));
  assert.ok(events.some((event) => event.pageSequence >= 2));
  assert.equal(events.some((event) => event.sourceLabel === "Secret password"), false);
  for (const forbidden of [
    "Never record while sensitive child",
    "Sensitive login email",
    "Sign in securely",
    "Untrusted event secret",
    "Hidden trusted secret",
    "Label contains value-leak-secret",
    "ＦＵＬＬＷＩＤＴＨ-ＳＥＣＲＥＴ details",
    "Account ending CDEF12",
    "Upload private-resume.pdf",
    "Choose selected-option-secret",
  ]) {
    assert.equal(events.some((event) => event.sourceLabel === forbidden), false, forbidden);
  }
  assert.ok(events.length <= 64, `event flood admitted ${events.length}`);

  const controls = JSON.parse(controlsText);
  assert.ok(controls.some((control) => control.sourceLabel === "Private Person email"));
  assert.equal(controls.some((control) => control.sourceLabel === "Secret password"), false);
  for (const label of invisibleLabels) {
    assert.equal(controls.some((control) => control.sourceLabel === label), false, label);
  }
  for (const label of visibleLabels) {
    assert.equal(controls.some((control) => control.sourceLabel === label), true, label);
  }
  const sanitizedHtml = await readFile(
    path.join(session, "checkpoints", checkpointNames[0], "page.html"),
    "utf8",
  );
  for (const forbidden of [
    "hidden-token-secret",
    "session-cookie-secret",
    "inline-bearer-secret",
    "<script",
    "type=\"hidden\"",
    " value=",
  ]) {
    assert.equal(sanitizedHtml.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }

  const receipt = JSON.parse(receiptText);
  assert.deepEqual(Object.keys(receipt).sort(), [
    "captureId", "captureMonth", "recorderVersion", "sourceFiles",
  ]);
  assert.equal(receipt.recorderVersion, "1.0.0");
  assert.equal(receipt.captureMonth, new Date().toISOString().slice(0, 7));
  assert.match(receipt.captureId, /^[A-Za-z0-9_-]+$/);
  assert.equal(Object.keys(receipt.sourceFiles).length, 22);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(session, "recording-summary.json"), "utf8")),
    { checkpointKinds: [
      "application-opened",
      "step-advanced",
      "validation-observed",
      "review-reached",
      "final-action-boundary",
    ] },
  );
  for (const [relative, digest] of Object.entries(receipt.sourceFiles)) {
    assert.match(relative, /^(?:events\.jsonl|recording-summary\.json|checkpoints\/[^/]+\/(?:page\.html|page\.png|controls\.json|checkpoint\.json))$/);
    assert.match(digest, /^[a-f0-9]{64}$/);
    const contents = await readFile(path.join(session, ...relative.split("/")));
    assert.equal(createHash("sha256").update(contents).digest("hex"), digest);
  }

  if (process.platform !== "win32") {
    assert.equal((await stat(session)).mode & 0o777, 0o700);
    for (const relative of Object.keys(receipt.sourceFiles)) {
      assert.equal((await stat(path.join(session, ...relative.split("/")))).mode & 0o777, 0o600);
    }
    assert.equal((await stat(path.join(session, "capture-receipt.json"))).mode & 0o777, 0o600);
  }

  const pythonSource = `
import json, pathlib
from qa.compiler import compile_capture
p = pathlib.Path(${JSON.stringify(path.join(session, "capture-receipt.json"))})
r = json.loads(p.read_text())
c = {"captureId": r["captureId"], "platformFamily": "linkedin-easy-apply", "captureMonth": r["captureMonth"], "sourceDeniedTerms": [], "steps": [
{"checkpoint":"application-opened","controls":[{"kind":"contact.first_name","sourceLabel":"First","required":True},{"kind":"contact.last_name","sourceLabel":"Last","required":True},{"kind":"contact.email","sourceLabel":"Email","required":True},{"kind":"contact.phone","sourceLabel":"Phone","required":True}]},
{"checkpoint":"step-advanced","controls":[{"kind":"resume.file","sourceLabel":"Resume","required":True}]},
{"checkpoint":"review-reached","controls":[],"finalActionObserved":True}]}
compile_capture(c, r, "recorder-compatible-v1")
`.split("\n").map((line) => line.trimStart()).join("\n");
  const python = spawn("python3", ["-c", pythonSource], { cwd: root });
  let pythonStderr = "";
  python.stderr.setEncoding("utf8");
  python.stderr.on("data", (chunk) => { pythonStderr += chunk; });
  const pythonResult = await waitForExit(python, 5000);
  assert.equal(pythonResult.code, 0, pythonStderr);

  const dead = await runNode([
    "qa/recorder.mjs", "checkpoint", "--session", session,
    "--kind", "application-opened",
  ], 3000);
  assert.equal(dead.code, 1);
  assert.match(dead.stderr, /recorder unavailable/);
  assert.doesNotMatch(dead.stderr, new RegExp(control.port));
});
