import { test } from "node:test";
import { BrokerClient, EventEmitter, abortCheckpointClient, access, assert, captureFullPagePng, chmod, chromium, commitCheckpoint, createHash, decodeCapturedPng, exerciseRejectedCaptureStates, http, inspectionHasSensitivePage, isSensitivePage, mkdir, mkdtemp, mockCaptureIsolated, once, path, postControl, readFile, readdir, rename, rm, root, runLauncher, runNode, sanitizeObservedControl, sendSlowPartialBody, spawn, startIndependentChromium, startPartialBody, startSyntheticSite, stat, stopChild, symlink, tmpdir, validateCaptureResources, validateCheckpointKind, validateRecorderOptions, validateSafetyRevision, waitForDevToolsActivePort, waitForExit, waitForFile, waitForInitialPageTarget, withTimeout, writeFile } from "./recorder_test_support.mjs";

test("record starts on the revised Workday job and choice shapes without source metadata", async (t) => {
  const site = await startSyntheticSite(t);
  const { cdpUrl } = await startIndependentChromium(t, `${site}/application`);
  const attached = await chromium.connectOverCDP(cdpUrl);
  t.after(() => attached.close());
  const context = attached.contexts()[0];
  const page = context.pages()[0];
  const canonical =
    "https://fictional.wd5.myworkdayjobs.com/en-US/fictional-site/job/Fictional-Role_JR-000001";
  const wd1Canonical =
    "https://fictional.wd1.myworkdayjobs.com/en-US/fictional-site/job/fictional-location/Fictional-Role_JR000001-1";
  let variant = "job";
  await context.route("https://*.myworkdayjobs.com/**", (route) => {
    const additions = {
      job: "",
      dialog: "",
      credential: '<label>Password<input type="password" autocomplete="current-password"></label>',
      account: "<p>Create an account to continue</p>",
      challenge: "<p>Complete CAPTCHA verification</p>",
      alternate: '<button type="button">Apply with Profile</button>',
      "apply-now": "",
      manual: '<form><label>Contact Email<input type="email"></label></form>',
    };
    const visibleShell = [
      '<button type="button">Sign In</button>',
      `<a role="button">${variant === "apply-now" ? "Apply Now" : "Apply"}</a>`,
      ...Array.from({ length: 5 }, (_, index) =>
        `<button type="button">Ordinary action ${index}</button>`),
      ...Array.from({ length: 5 }, () =>
        '<svg role="presentation" width="1" height="1"></svg>'),
      '<span role="alert">Ordinary status</span>',
      ...Array.from({ length: 4 }, () => '<div role="button">Ordinary action</div>'),
      '<div role="search">Ordinary search</div>',
      '<nav role="menu">Ordinary menu</nav>',
      ...Array.from({ length: 7 }, () => '<input type="text">'),
    ].join("\n");
    const hiddenShell = [
      ...Array.from({ length: 5 }, () => '<button type="button" hidden>Ordinary</button>'),
      ...Array.from({ length: 5 }, () => '<svg role="presentation" hidden></svg>'),
      ...Array.from({ length: 5 }, () => '<div role="button" hidden></div>'),
    ].join("\n");
    const manual = variant === "alternate" ? "" : '<button type="button">Apply Manually</button>';
    const choiceDialog = variant === "job" || variant === "manual" ? "" : `
      <section role="dialog" aria-label="Start Your Application">
        <h2>Start Your Application</h2>
        <button type="button">Autofill with Resume</button>
        ${manual}
        <button type="button">Use My Last Application</button>
        ${additions[variant]}
      </section>`;
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><title>Fictional Role</title><main>
        <h1>Fictional Role</h1>
        ${visibleShell}
        ${hiddenShell}
        ${choiceDialog}
        ${variant === "manual" ? additions.manual : ""}
      </main>`,
    });
  });
  const render = async (selectedVariant, url = canonical) => {
    variant = selectedVariant;
    await page.goto(url, { waitUntil: "load" });
    await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
  };

  const directory = await mkdtemp(path.join(tmpdir(), "workday-optional-sign-in-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateRoot = path.join(directory, ".qa-private");
  await mkdir(privateRoot, { mode: 0o700 });

  await render("job", wd1Canonical);
  const wd1Session = path.join(privateRoot, "qa-session-wd1-allowed");
  const wd1Recorder = spawn(process.execPath, [
    "qa/recorder.mjs", "record", "--cdp-url", cdpUrl, "--output", wd1Session,
  ], { cwd: root });
  let wd1Stderr = "";
  wd1Recorder.stderr.setEncoding("utf8");
  wd1Recorder.stderr.on("data", (chunk) => { wd1Stderr += chunk; });
  t.after(() => stopChild(wd1Recorder));
  try {
    await waitForFile(path.join(wd1Session, "control.json"), 10000);
  } catch (error) {
    assert.fail(`${error.message}: ${wd1Stderr}`);
  }
  wd1Recorder.kill("SIGTERM");
  assert.deepEqual(await waitForExit(wd1Recorder, 5000), { code: 0, signal: null });
  assert.equal(wd1Stderr, "");
  const wd1Receipt = await readFile(path.join(wd1Session, "capture-receipt.json"), "utf8");
  assert.doesNotMatch(wd1Receipt, /myworkdayjobs|fictional|JR0/);

  await render("job", canonical);
  const browserShape = await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll(
      "input,select,textarea,button,[role]",
    ));
    const visible = (element) => {
      if (element.matches("input[type=hidden],input[type=password]")) return false;
      for (let current = element; current instanceof Element; current = current.parentElement) {
        if (current.matches("[hidden],[aria-hidden=true]")) return false;
        const style = getComputedStyle(current);
        if (["none"].includes(style.display) ||
            ["hidden", "collapse"].includes(style.visibility) ||
            Number.parseFloat(style.opacity) === 0) return false;
      }
      const rectangle = element.getBoundingClientRect();
      return rectangle.width > 0 && rectangle.height > 0;
    };
    const describe = (element) => ({
      type: element instanceof HTMLInputElement ? element.type : element.tagName.toLowerCase(),
      autocomplete: element.getAttribute("autocomplete") || "",
      label: element.getAttribute("aria-label") ||
        (element instanceof HTMLButtonElement ? element.innerText.trim() :
          element.getAttribute("name") || element.getAttribute("placeholder") ||
          "Unlabelled control"),
      role: element.getAttribute("role") ||
        (element instanceof HTMLButtonElement ? "button" :
          element instanceof HTMLInputElement ? "textbox" : "control"),
      required: element.matches("[required],[aria-required=true]"),
    });
    return {
      url: location.href,
      title: document.title,
      text: document.body.innerText,
      controls: elements.filter(visible).map(describe),
      securityControls: elements.map(describe),
      controlOverflow: false,
      formCount: document.querySelectorAll("form").length,
      securityFrames: [],
      securityFrameOverflow: false,
    };
  });
  assert.equal(browserShape.controls.length, 26);
  assert.equal(browserShape.securityControls.length, 41);
  assert.equal(browserShape.controls.find((item) => item.type === "a")?.label,
    "Unlabelled control");
  assert.equal(inspectionHasSensitivePage([{
    frame: { id: "main" },
    frameVisible: true,
    value: browserShape,
  }]), false, JSON.stringify(browserShape));
  const allowedSession = path.join(privateRoot, "qa-session-allowed");
  const recorder = spawn(process.execPath, [
    "qa/recorder.mjs", "record", "--cdp-url", cdpUrl, "--output", allowedSession,
  ], { cwd: root });
  let recorderStderr = "";
  recorder.stderr.setEncoding("utf8");
  recorder.stderr.on("data", (chunk) => { recorderStderr += chunk; });
  t.after(() => stopChild(recorder));
  try {
    await waitForFile(path.join(allowedSession, "control.json"), 10000);
  } catch (error) {
    assert.fail(`${error.message}: ${recorderStderr}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  const stablePage = async (body) => {
    await page.setContent(`<!doctype html><title>Fictional Role</title><main>${body}</main>`, {
      waitUntil: "domcontentloaded",
    });
    await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
  };
  await stablePage(`
    <h1>Fictional Role</h1>
    <button type="button">Sign In</button>
    <a role="button">Apply</a>
    <button type="button">Ordinary action</button>`);
  const firstCheckpoint = await runNode([
    "qa/recorder.mjs", "checkpoint", "--session", allowedSession,
    "--kind", "application-opened",
  ], 10000);
  assert.equal(firstCheckpoint.code, 0, firstCheckpoint.stderr);

  await stablePage(`
    <h1>Fictional Role</h1>
    <button type="button">Sign In</button>
    <a role="button">Apply</a>
    <section role="dialog" aria-label="Start Your Application">
      <h2>Start Your Application</h2>
      <button type="button">Autofill with Resume</button>
      <button type="button">Apply Manually</button>
      <button type="button">Use My Last Application</button>
    </section>`);
  const choiceCheckpoint = await runNode([
    "qa/recorder.mjs", "checkpoint", "--session", allowedSession,
    "--kind", "step-advanced",
  ], 10000);
  assert.equal(choiceCheckpoint.code, 0, choiceCheckpoint.stderr);

  await stablePage(`
    <h1>Fictional Role</h1>
    <button type="button">Sign In</button>
    <a role="button">Apply</a>
    <button type="button">Ordinary action</button>`);
  const manualCheckpoint = await runNode([
    "qa/recorder.mjs", "checkpoint", "--session", allowedSession,
    "--kind", "validation-observed",
  ], 10000);
  assert.equal(manualCheckpoint.code, 0, manualCheckpoint.stderr);

  await render("dialog", canonical.replace("fictional", "other-tenant"));
  const driftCheckpoint = await runNode([
    "qa/recorder.mjs", "checkpoint", "--session", allowedSession,
    "--kind", "step-advanced",
  ], 10000);
  assert.equal(driftCheckpoint.code, 1);
  assert.match(driftCheckpoint.stderr, /checkpoint rejected/);
  assert.deepEqual(await readdir(path.join(allowedSession, "checkpoints")), [
    "0001-application-opened",
    "0002-step-advanced",
    "0003-validation-observed",
  ]);
  recorder.kill("SIGTERM");
  assert.deepEqual(await waitForExit(recorder, 5000), { code: 0, signal: null });
  assert.equal(recorderStderr, "");

    const persisted = (await Promise.all([
    "capture-receipt.json",
    "recording-summary.json",
    "events.jsonl",
    "checkpoints/0001-application-opened/page.html",
    "checkpoints/0001-application-opened/controls.json",
    "checkpoints/0001-application-opened/checkpoint.json",
    "checkpoints/0002-step-advanced/page.html",
    "checkpoints/0002-step-advanced/controls.json",
    "checkpoints/0002-step-advanced/checkpoint.json",
    "checkpoints/0003-validation-observed/page.html",
    "checkpoints/0003-validation-observed/controls.json",
    "checkpoints/0003-validation-observed/checkpoint.json",
    ].map((filename) => readFile(path.join(allowedSession, filename), "utf8")))).join("\n");
    assert.doesNotMatch(persisted, /myworkdayjobs|fictional\.wd5|JR-000001|\/en-US\/fictional-site\/job/);
  const refusedCases = [
    ["credential", canonical],
    ["account", canonical],
    ["challenge", canonical],
    ["alternate", canonical],
    ["apply-now", canonical],
    ["manual", canonical],
    ["unobserved-tenant-family", canonical.replace("wd5", "wd2")],
    ["host-family", canonical.replace("wd5", "wd4")],
    ["wd1-old-route", canonical.replace("wd5", "wd1")],
    ["wd5-new-route", wd1Canonical.replace("wd1", "wd5")],
    ["wd1-bad-separator", wd1Canonical.replace("_JR000001-1", "_JR-000001-1")],
    ["wd1-extra-segment", wd1Canonical.replace("/Fictional-Role_", "/extra/Fictional-Role_")],
    ["old-requisition", canonical.replace("_JR-000001", "_R000001")],
    ["path-family", canonical.replace("/en-US/fictional-site/job/", "/jobs/job/")],
  ];
  for (const [name, url] of refusedCases) {
    await render([
      "unobserved-tenant-family", "host-family", "wd1-old-route", "wd5-new-route",
      "wd1-bad-separator", "wd1-extra-segment", "old-requisition", "path-family",
    ].includes(name) ? "dialog" : name, url);
    const session = path.join(privateRoot, `qa-session-${name}`);
    const refused = await runNode([
      "qa/recorder.mjs", "record", "--cdp-url", cdpUrl, "--output", session,
    ], 10000);
    assert.equal(refused.code, 1, name);
    assert.match(refused.stderr, /sensitive page refused/, name);
    assert.doesNotMatch(refused.stderr, /myworkdayjobs|fictional|R000001/, name);
    await assert.rejects(access(path.join(session, "capture-receipt.json")));
    await assert.rejects(access(path.join(session, "events.jsonl")));
  }
});
