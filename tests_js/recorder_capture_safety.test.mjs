import { test } from "node:test";
import { BrokerClient, EventEmitter, abortCheckpointClient, access, assert, captureFullPagePng, chmod, chromium, commitCheckpoint, createHash, decodeCapturedPng, exerciseRejectedCaptureStates, http, inspectionHasSensitivePage, isSensitivePage, mkdir, mkdtemp, mockCaptureIsolated, once, path, postControl, readFile, readdir, rename, rm, root, runLauncher, runNode, sanitizeObservedControl, sendSlowPartialBody, spawn, startIndependentChromium, startPartialBody, startSyntheticSite, stat, stopChild, symlink, tmpdir, validateCaptureResources, validateCheckpointKind, validateRecorderOptions, validateSafetyRevision, waitForDevToolsActivePort, waitForExit, waitForFile, waitForInitialPageTarget, withTimeout, writeFile } from "./recorder_test_support.mjs";

test("record permits only the exact passive Lever hCaptcha browser shape", async (t) => {
  const site = await startSyntheticSite(t);
  const { cdpUrl } = await startIndependentChromium(t, `${site}/application`);
  const attached = await chromium.connectOverCDP(cdpUrl);
  t.after(() => attached.close());
  const context = attached.contexts()[0];
  const page = context.pages()[0];
  const canonical =
    "https://jobs.lever.co/example/00000000-0000-4000-8000-000000000001/apply";
  const enclaveVersion = "a".repeat(40);
  const pendingEnclaveRoutes = [];
  await context.route("https://jobs.lever.co/**", (route) => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html><title>Application</title><main>
      <h1>Apply for this position</h1>
      <label>Email<input type=email autocomplete=email></label>
      <input type=hidden name=h-captcha-response>
      <button type=button>Submit application</button>
    </main>`,
  }));
  await context.route("https://newassets.hcaptcha.com/**", (route) => {
    pendingEnclaveRoutes.push(route);
  });
  const abortPendingEnclaveRoutes = async () => {
    const routes = pendingEnclaveRoutes.splice(0);
    await Promise.all(routes.map((route) => route.abort().catch(() => {})));
  };
  t.after(abortPendingEnclaveRoutes);

  const renderShape = async (variant = "safe") => {
    await abortPendingEnclaveRoutes();
    await page.goto(canonical, { waitUntil: "domcontentloaded" });
    await page.evaluate(async ({ selectedVariant, version }) => {
      const auxiliary = document.createElement("iframe");
      auxiliary.id = "auxiliary";
      auxiliary.style.cssText =
        "visibility:hidden;position:absolute;width:1px;height:1px;border:0";
      document.body.append(auxiliary);

      for (let index = 0; index < 2; index += 1) {
        const frame = document.createElement("iframe");
        frame.id = `hcaptcha-${index + 1}`;
        frame.title = "Widget containing checkbox for hCaptcha security challenge";
        frame.style.cssText = `visibility:${
          selectedVariant === "visible" && index === 0 ? "visible" : "hidden"
        };position:fixed;width:300px;height:200px;border:0`;
        frame.src = "javascript:false";
        document.body.append(frame);
        await new Promise((resolve) => setTimeout(resolve, 20));
        frame.contentDocument.title = "hCaptcha";
        frame.contentDocument.body.innerHTML =
          "<textarea name=g-recaptcha-response hidden></textarea>" +
          "<textarea name=h-captcha-response hidden></textarea>";
        if (selectedVariant === "nonempty" && index === 0) {
          frame.contentDocument.body.append("Choose the matching images");
        }
        frame.src = `https://newassets.hcaptcha.com/captcha/v1/${version}` +
          "/static/hcaptcha-enclave.html#frame=enclave" +
          `&_channel=Channel${index + 1}&_origin=https%3A%2F%2Fjobs.lever.co` +
          `&host=jobs.lever.co&se=${version}`;
      }
      if (selectedVariant === "credential") {
        const password = document.createElement("input");
        password.type = "password";
        password.hidden = true;
        password.autocomplete = "current-password";
        password.setAttribute("aria-label", "Password");
        document.body.append(password);
      }
    }, { selectedVariant: variant, version: enclaveVersion });
    await page.waitForFunction(() => document.querySelectorAll("iframe").length === 3);
  };

  const directory = await mkdtemp(path.join(tmpdir(), "lever-passive-hcaptcha-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateRoot = path.join(directory, ".qa-private");
  await mkdir(privateRoot, { mode: 0o700 });

  await renderShape();
  const cdp = await context.newCDPSession(page);
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const childUrls = (frameTree.childFrames ?? []).map(({ frame }) => frame.url).sort();
  assert.deepEqual(childUrls, ["", "", "about:blank"]);
  await cdp.detach();

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
  const checkpoint = await runNode([
    "qa/recorder.mjs", "checkpoint", "--session", allowedSession,
    "--kind", "application-opened",
  ], 10000);
  assert.equal(checkpoint.code, 0, checkpoint.stderr);
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
  ].map((filename) => readFile(path.join(allowedSession, filename), "utf8")))).join("\n");
  assert.doesNotMatch(persisted, /newassets\.hcaptcha\.com|Channel1|securityFrames/);
  await abortPendingEnclaveRoutes();

  for (const variant of ["visible", "nonempty", "credential"]) {
    await renderShape(variant);
    const session = path.join(privateRoot, `qa-session-${variant}`);
    const refused = await runNode([
      "qa/recorder.mjs", "record", "--cdp-url", cdpUrl, "--output", session,
    ], 10000);
    assert.equal(refused.code, 1, variant);
    assert.match(refused.stderr, /sensitive page refused/, variant);
    assert.doesNotMatch(refused.stderr, /newassets\.hcaptcha\.com|Channel1|securityFrames/);
    await assert.rejects(access(path.join(session, "capture-receipt.json")));
    await assert.rejects(access(path.join(session, "events.jsonl")));
    await abortPendingEnclaveRoutes();
  }
});

test("recorder excludes inert source text but keeps ordinary sensitive text in scope", async (t) => {
  const site = await startSyntheticSite(t);
  const { cdpUrl } = await startIndependentChromium(t, `${site}/application`);
  const attached = await chromium.connectOverCDP(cdpUrl);
  t.after(() => attached.close());
  const page = attached.contexts()[0].pages()[0];
  const directory = await mkdtemp(path.join(tmpdir(), "recording-inert-source-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateRoot = path.join(directory, ".qa-private");
  await mkdir(privateRoot, { mode: 0o700 });

  await page.setContent(`<!doctype html><title>Application</title><main>
    <h1>Apply for this position</h1>
    <script type="application/json">{"authenticationMode":"captcha"}</script>
    <style>.ordinary::after { content: "sign in"; }</style>
    <template><p>Enter the verification code</p></template>
    <label>Contact email<input type="email"></label>
  </main>`);
  const allowedSession = path.join(privateRoot, "qa-session-inert-source");
  const allowed = spawn(process.execPath, [
    "qa/recorder.mjs", "record", "--cdp-url", cdpUrl, "--output", allowedSession,
  ], { cwd: root });
  let allowedStderr = "";
  allowed.stderr.setEncoding("utf8");
  allowed.stderr.on("data", (chunk) => { allowedStderr += chunk; });
  t.after(() => stopChild(allowed));
  await waitForFile(path.join(allowedSession, "control.json"), 10000);
  allowed.kill("SIGTERM");
  assert.deepEqual(await waitForExit(allowed, 5000), { code: 0, signal: null });
  assert.equal(allowedStderr, "");

  const refusedCases = [
    ["visible text", `<!doctype html><title>Application</title>
      <main><p>Authentication required</p></main>`],
    ["CSS-hidden ordinary text", `<!doctype html><title>Application</title>
      <main><p style="display:none">Authentication required</p></main>`],
    ["security control", `<!doctype html><title>Application</title>
      <main><label>Access code<input autocomplete="one-time-code"></label></main>`],
  ];
  for (const [label, markup] of refusedCases) {
    await page.setContent(markup);
    const session = path.join(privateRoot, `qa-session-${label.replaceAll(" ", "-")}`);
    const refused = await runNode([
      "qa/recorder.mjs", "record", "--cdp-url", cdpUrl, "--output", session,
    ], 10000);
    assert.equal(refused.code, 1, label);
    assert.match(refused.stderr, /sensitive page refused/, label);
  }

  await page.setContent("<!doctype html><title>Application</title><main><div id=host></div></main>");
  await page.locator("#host").evaluate((host) => {
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = "<p>Authentication required</p>";
  });
  const shadowSession = path.join(privateRoot, "qa-session-shadow-text");
  const shadowRefused = await runNode([
    "qa/recorder.mjs", "record", "--cdp-url", cdpUrl, "--output", shadowSession,
  ], 10000);
  assert.equal(shadowRefused.code, 1);
  assert.match(shadowRefused.stderr, /sensitive page refused/);

  await page.setContent(`<!doctype html><title>Application</title><main>
    <iframe id="child" srcdoc="<p>Authentication required</p>"></iframe>
  </main>`);
  await page.locator("#child").contentFrame().locator("p").waitFor();
  const frameSession = path.join(privateRoot, "qa-session-child-text");
  const frameRefused = await runNode([
    "qa/recorder.mjs", "record", "--cdp-url", cdpUrl, "--output", frameSession,
  ], 10000);
  assert.equal(frameRefused.code, 1);
  assert.match(frameRefused.stderr, /sensitive page refused/);
});
