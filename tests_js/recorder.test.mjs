import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";

import {
  BrokerClient,
  captureFullPagePng,
  commitCheckpoint,
  decodeCapturedPng,
  inspectionHasSensitivePage,
  isSensitivePage,
  sanitizeObservedControl,
  validateCheckpointKind,
  validateCaptureResources,
  validateRecorderOptions,
  validateSafetyRevision,
} from "../qa/recorder.mjs";

const root = path.resolve(import.meta.dirname, "..");

function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("process exit timed out")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitForExit(child, 3000);
  } catch {
    child.kill("SIGKILL");
    await waitForExit(child, 3000);
  }
}

async function waitForFile(filename, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(filename);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error("file wait timed out");
}

async function runNode(args, timeoutMs = 5000) {
  const child = spawn(process.execPath, args, { cwd: root });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const { code, signal } = await waitForExit(child, timeoutMs);
  return { code, signal, stdout, stderr };
}

async function runLauncher(args, home, timeoutMs = 15000) {
  const child = spawn("python3", ["scripts/qa-chrome.py", ...args], {
    cwd: root,
    env: { ...process.env, HOME: home },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const { code, signal } = await waitForExit(child, timeoutMs);
  return { code, signal, stdout, stderr };
}

async function startSyntheticSite(t) {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (request.url === "/login") {
      response.end(`<!doctype html><title>Sign in</title><form>
        <label>Sensitive login email<input id=login-email type=email></label>
        <label>Access phrase<input type=password></label>
        <button id=login-button type=button>Sign in securely</button></form>`);
      return;
    }
    response.end(`<!doctype html><title>Application</title>
      <main><h1>Apply for this position</h1>
      <label>Private Person email<input id=email type=email required></label>
      <label>Resume upload<input id=resume type=file required></label>
      <input type=hidden name=csrf_token value=hidden-token-secret>
      <div hidden>cookie=session-cookie-secret</div>
      <script>window.bootstrapAuthorization = "Bearer inline-bearer-secret";</script>
      <button id=continue type=button>Continue application</button></main>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function startIndependentChromium(t, url, extraArgs = []) {
  const profile = await mkdtemp(path.join(tmpdir(), "recorder-chrome-"));
  const browserProcess = spawn(chromium.executablePath(), [
    "--headless=new",
    ...(process.platform === "linux" ? [
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ] : []),
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    ...extraArgs,
    url,
  ], { stdio: "ignore" });
  t.after(async () => {
    await stopChild(browserProcess);
    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  const activePort = path.join(profile, "DevToolsActivePort");
  await waitForFile(activePort, 10000);
  const [port] = (await readFile(activePort, "utf8")).split("\n");
  return {
    browserProcess,
    cdpUrl: `http://127.0.0.1:${port}`,
  };
}

async function postControl(control, body, overrides = {}) {
  const encoded = typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port: control.port,
      path: "/checkpoint",
      method: "POST",
      headers: {
        ...(overrides.omitAuthorization ? {} : {
          authorization: `Bearer ${overrides.token ?? control.token}`,
        }),
        "content-type": overrides.contentType ?? "application/json",
        host: overrides.host ?? `127.0.0.1:${control.port}`,
        origin: overrides.origin ?? `http://127.0.0.1:${control.port}`,
        "content-length": Buffer.byteLength(encoded),
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve({ status: response.statusCode }));
    });
    request.once("error", reject);
    request.end(encoded);
  });
}

function controlHeaders(control, encoded) {
  return {
    authorization: `Bearer ${control.token}`,
    "content-type": "application/json",
    host: `127.0.0.1:${control.port}`,
    origin: `http://127.0.0.1:${control.port}`,
    "content-length": Buffer.byteLength(encoded),
  };
}

async function sendSlowPartialBody(control) {
  const encoded = '{"kind":"application-opened"}';
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port: control.port,
      path: "/checkpoint",
      method: "POST",
      headers: controlHeaders(control, encoded),
    });
    const timer = setTimeout(() => {
      request.destroy();
      reject(new Error("slow body was not bounded"));
    }, 1500);
    const settle = () => {
      clearTimeout(timer);
      resolve();
    };
    request.once("response", (response) => {
      response.resume();
      response.once("end", settle);
    });
    request.once("error", settle);
    request.write(encoded.slice(0, 8));
  });
}

function startPartialBody(control) {
  const encoded = '{"kind":"application-opened"}';
  let resolveSettled;
  const settled = new Promise((resolve) => { resolveSettled = resolve; });
  const request = http.request({
    hostname: "127.0.0.1",
    port: control.port,
    path: "/checkpoint",
    method: "POST",
    headers: controlHeaders(control, encoded),
  });
  request.once("response", (response) => {
    response.resume();
    response.once("end", resolveSettled);
  });
  request.once("error", resolveSettled);
  request.write(encoded.slice(0, 8));
  return settled;
}

async function abortCheckpointClient(control, delayMs = 50) {
  const encoded = '{"kind":"application-opened"}';
  return new Promise((resolve) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port: control.port,
      path: "/checkpoint",
      method: "POST",
      headers: controlHeaders(control, encoded),
    });
    request.once("response", (response) => {
      response.resume();
      response.once("end", resolve);
    });
    request.once("error", resolve);
    request.end(encoded);
    setTimeout(() => request.destroy(), delayMs);
  });
}

test("sanitizeObservedControl retains metadata and strips applicant values", () => {
  assert.deepEqual(
    sanitizeObservedControl({
      role: "textbox",
      label: "Private Person email",
      value: "private@example.invalid",
      checked: true,
      filename: "private-resume.pdf",
      files: ["private-resume.pdf"],
      textContent: "Private Person",
      required: true,
    }),
    {
      role: "textbox",
      sourceLabel: "Private Person email",
      required: true,
    },
  );
});

test("checkpoint kinds are closed and value-free on rejection", () => {
  for (const kind of [
    "application-opened",
    "step-advanced",
    "validation-observed",
    "review-reached",
    "final-action-boundary",
  ]) {
    assert.equal(validateCheckpointKind(kind), kind);
  }
  assert.throws(
    () => validateCheckpointKind("secret-kind"),
    (error) => error.message === "invalid checkpoint kind" &&
      !error.message.includes("secret-kind"),
  );
});

test("checkpoint commit rolls back cancellation after rename and reuses sequence", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "checkpoint-commit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const finalDirectory = path.join(directory, "0001-application-opened");
  const firstTemporary = path.join(directory, ".tmp-first");
  await mkdir(firstTemporary, { mode: 0o700 });
  await writeFile(path.join(firstTemporary, "checkpoint.json"), "first", { mode: 0o600 });
  const controller = new AbortController();
  const lifecycle = [];

  await assert.rejects(commitCheckpoint({
    temporaryDirectory: firstTemporary,
    checkpointDirectory: finalDirectory,
    signal: controller.signal,
    isShuttingDown: () => false,
    updateLifecycle: () => lifecycle.push("application-opened"),
    renameDirectory: async (source, destination) => {
      await rename(source, destination);
      controller.abort();
    },
    removeDirectory: (target) => rm(target, { recursive: true, force: true }),
  }), /operation canceled/);
  await assert.rejects(access(finalDirectory));
  await assert.rejects(access(firstTemporary));
  assert.deepEqual(lifecycle, []);

  const secondTemporary = path.join(directory, ".tmp-second");
  await mkdir(secondTemporary, { mode: 0o700 });
  await writeFile(path.join(secondTemporary, "checkpoint.json"), "second", { mode: 0o600 });
  await commitCheckpoint({
    temporaryDirectory: secondTemporary,
    checkpointDirectory: finalDirectory,
    signal: new AbortController().signal,
    isShuttingDown: () => false,
    updateLifecycle: () => lifecycle.push("application-opened"),
    renameDirectory: rename,
    removeDirectory: (target) => rm(target, { recursive: true, force: true }),
  });
  assert.equal(await readFile(path.join(finalDirectory, "checkpoint.json"), "utf8"), "second");
  assert.deepEqual(lifecycle, ["application-opened"]);
});

test("sensitive page detector rejects login and credential surfaces", () => {
  assert.equal(
    isSensitivePage({
      url: "https://example.test/join",
      title: "Account creation",
      controls: [],
      text: "",
    }),
    true,
  );
  for (const text of [
    "Complete CAPTCHA verification",
    "Enter your MFA code",
    "Approve the authenticator app push notification",
    "Enter the SMS security code",
    "Use a recovery code for 2FA",
    "Verify your identity",
    "Enter the 6-digit code we sent",
  ]) {
    assert.equal(isSensitivePage({
      url: "https://example.test/jobs/1/apply",
      title: "Application",
      controls: [],
      text,
    }), true);
  }
  for (const autocomplete of ["current-password", "one-time-code"]) {
    assert.equal(isSensitivePage({
      url: "https://example.test/jobs/1/apply",
      title: "Application",
      controls: [{ type: "text", label: "Code", autocomplete }],
      text: "",
    }), true);
  }
  for (const text of ["OTP", "Authentication challenge", "Use your security key"]) {
    assert.equal(isSensitivePage({
      url: "https://example.test/jobs/1/apply",
      title: "Application",
      controls: [],
      text,
    }), true);
  }
  assert.equal(
    isSensitivePage({
      url: "https://example.test/jobs/1",
      title: "Sign in to continue",
      controls: [],
      text: "",
    }),
    true,
  );
  assert.equal(
    isSensitivePage({
      url: "https://example.test/jobs/1/apply",
      title: "Application",
      controls: [{ type: "password", label: "Access phrase" }],
      text: "",
    }),
    true,
  );
  assert.equal(
    isSensitivePage({
      url: "https://example.test/jobs/1/apply",
      title: "Application",
      controls: [{ type: "email", label: "Email" }],
      text: "Apply for this position",
    }),
    false,
  );
  assert.equal(
    isSensitivePage({
      url: "https://example.test/jobs/1/apply",
      title: "Application",
      controls: [],
      text: "Solve difficult technical challenges with the engineering team",
    }),
    false,
  );
});

test("Workday permits only a bounded ordinary shell around one optional Sign In", () => {
  const control = (label, overrides = {}) => ({
    type: "button",
    autocomplete: "",
    label,
    role: "button",
    required: false,
    ...overrides,
  });
  const signIn = control("Sign In");
  const applyAnchor = control("Unlabelled control", { type: "a" });
  const ordinaryPairs = [
    ["button", "button"],
    ["svg", "presentation"],
    ["span", "alert"],
    ["a", "button"],
    ["div", "button"],
    ["div", "search"],
    ["nav", "menu"],
    ["text", "textbox"],
  ];
  const ordinary = (index) => {
    const [type, role] = ordinaryPairs[index % ordinaryPairs.length];
    return control(type === "button" ? `Ordinary action ${index}` : "Unlabelled control", {
      type,
      role,
    });
  };
  const controls = [signIn, applyAnchor];
  while (controls.length < 26) controls.push(ordinary(controls.length));
  const securityControls = [...controls];
  while (securityControls.length < 41) securityControls.push(ordinary(securityControls.length));
  const main = {
    frame: { id: "main" },
    frameVisible: true,
    value: {
      url: "https://fictional.wd5.myworkdayjobs.com/en-US/fictional-site/job/Fictional-Role_JR-000001",
      title: "Fictional Role",
      text: "Fictional Role Sign In Apply",
      controls,
      securityControls,
      controlOverflow: false,
      formCount: 0,
      securityFrames: [],
      securityFrameOverflow: false,
    },
  };
  const inspect = (value = main.value, extras = [], boundUrl = undefined) =>
    inspectionHasSensitivePage([{ ...main, value }, ...extras], boundUrl);

  assert.equal(inspect(), false);
  const wd1Value = {
    ...main.value,
    url: "https://fictional.wd1.myworkdayjobs.com/en-US/fictional-site/job/fictional-location/Fictional-Role_JR000001-1",
  };
  assert.equal(inspect(wd1Value), false);
  const choiceControls = [...controls,
    control("Start Your Application", { type: "section", role: "dialog" }),
    control("Autofill with Resume"),
    control("Apply Manually"),
    control("Use My Last Application"),
  ];
  const choiceSecurityControls = [...securityControls, ...choiceControls.slice(-4)];
  assert.equal(inspect({
    ...main.value,
    text: "Fictional Role Sign In Apply Start Your Application Autofill with Resume Apply Manually Use My Last Application",
    controls: choiceControls,
    securityControls: choiceSecurityControls,
  }), false);

  const invalidValues = [
    { ...main.value, url: main.value.url.replace("wd5", "wd2") },
    { ...main.value, url: main.value.url.replace("wd5", "wd4") },
    { ...main.value, url: main.value.url.replace("wd5", "wd6") },
    { ...main.value, url: main.value.url.replace("_JR-000001", "_R000001") },
    { ...main.value, url: main.value.url.replace("_JR-000001", "_JR000001") },
    { ...main.value, url: main.value.url.replace("fictional.wd5", `${"a".repeat(64)}.wd5`) },
    { ...main.value, url: main.value.url.replace("fictional-site", "fictional.site") },
    { ...main.value, url: main.value.url.replace("fictional-site", `${"s".repeat(65)}`) },
    { ...main.value, url: main.value.url.replace("Fictional-Role", "Fictional%2FRole") },
    { ...main.value, url: main.value.url.replace("Fictional-Role", `${"r".repeat(129)}`) },
    { ...main.value, url: `${main.value.url}?source=private` },
    { ...main.value, url: `${main.value.url}#application` },
    { ...wd1Value, url: wd1Value.url.replace("_JR000001-1", "_JR-000001-1") },
    { ...wd1Value, url: wd1Value.url.replace("_JR000001-1", "_JR000001_1") },
    { ...wd1Value, url: wd1Value.url.replace("_JR000001-1", "_JR000001") },
    { ...wd1Value, url: wd1Value.url.replace("_JR000001-1", "_JR000001-") },
    { ...wd1Value, url: wd1Value.url.replace("_JR000001-1", "") },
    { ...wd1Value, url: wd1Value.url.replace("000001-1", `${"1".repeat(19)}-1`) },
    { ...wd1Value, url: wd1Value.url.replace("000001-1", `000001-${"1".repeat(19)}`) },
    { ...wd1Value, url: wd1Value.url.replace("/Fictional-Role_", "/extra/Fictional-Role_") },
    { ...wd1Value, url: `${wd1Value.url}?source=private` },
    { ...wd1Value, url: `${wd1Value.url}#application` },
    { ...wd1Value, url: wd1Value.url.replace("wd1", "wd2") },
    { ...wd1Value, url: wd1Value.url.replace("wd1", "wd5") },
    { ...wd1Value, url: main.value.url.replace("wd5", "wd1") },
    { ...main.value, text: `${main.value.text} Create an account` },
    { ...main.value, text: `${main.value.text} Complete CAPTCHA verification` },
    { ...main.value, text: main.value.text.replace("Apply", "Apply Now") },
    { ...main.value, text: `${main.value.text} Apply Manually` },
    { ...main.value, controls: controls.filter((item) => item !== signIn) },
    { ...main.value, securityControls: securityControls.filter((item) => item !== signIn) },
    { ...main.value, controls: [signIn, ...controls] },
    { ...main.value, securityControls: [signIn, ...securityControls] },
    { ...main.value, securityControls: [...securityControls, {
      type: "password",
      autocomplete: "current-password",
      label: "Password",
      role: "textbox",
      required: true,
    }] },
    { ...main.value, securityControls: securityControls.map((item, index) =>
      index === 2 ? { ...item, type: "section", role: "navigation" } : item) },
    { ...main.value, controls: [...controls, ...Array.from({ length: 7 }, (_, index) =>
      ordinary(100 + index))] },
    { ...main.value, securityControls: [...securityControls,
      ...Array.from({ length: 8 }, (_, index) => ordinary(200 + index))] },
    { ...main.value, securityFrames: [{
      src: "about:blank",
      title: "",
      visibility: "hidden",
      position: "absolute",
      width: 1,
      height: 1,
    }] },
    { ...main.value, securityFrameOverflow: true },
    { ...main.value, controlOverflow: true },
    { ...main.value, formCount: 1 },
  ];
  for (const [index, value] of invalidValues.entries()) {
    assert.equal(inspect(value), true, `invalid Workday shape ${index}`);
  }
  for (const url of [
    main.value.url.replace("fictional", "other-tenant"),
    main.value.url.replace("/fictional-site/", "/other-site/"),
    main.value.url.replace("/Fictional-Role_", "/Other-Role_"),
  ]) {
    assert.equal(inspect({ ...main.value, url }, [], main.value.url), true, url);
  }
  assert.equal(inspect(main.value, [{
    frame: { id: "child", parentId: "main" },
    frameVisible: false,
    value: {
      url: "about:blank",
      title: "",
      text: "",
      controls: [],
      securityControls: [],
      controlOverflow: false,
    },
  }]), true);
});

test("LinkedIn jobs allow only an inert hidden CAPTCHA bootstrap frame", () => {
  const main = {
    frame: { id: "main" },
    frameVisible: true,
    value: {
      url: "https://www.linkedin.com/jobs/view/4450809022/",
      title: "AI Engineer | LinkedIn",
      text: "Solve difficult technical challenges. Easy Apply",
      controls: [{ type: "button", label: "Easy Apply" }],
      securityControls: [],
    },
  };
  const dormantCaptcha = {
    frame: { id: "captcha", parentId: "main" },
    frameVisible: false,
    value: {
      url: "",
      title: "CAPTCHA",
      text: "CAPTCHA",
      controls: [],
      securityControls: [],
    },
  };
  const dormantCaptchaResponse = {
    frame: { id: "captcha-response", parentId: "captcha" },
    frameVisible: false,
    value: {
      url: "https://www.google.com/recaptcha/api2/anchor",
      title: "",
      text: "",
      controls: [{
        type: "textarea",
        autocomplete: "",
        label: "g-recaptcha-response",
      }],
      securityControls: [],
    },
  };

  assert.equal(inspectionHasSensitivePage([
    main,
    dormantCaptcha,
    dormantCaptchaResponse,
  ]), false);
  assert.equal(inspectionHasSensitivePage([
    main,
    { ...dormantCaptcha, frameVisible: true },
  ]), true);
  assert.equal(inspectionHasSensitivePage([
    main,
    dormantCaptcha,
    { ...dormantCaptchaResponse, frameVisible: true },
  ]), true);
  assert.equal(inspectionHasSensitivePage([
    { ...main, value: { ...main.value, url: "https://example.test/jobs/1" } },
    dormantCaptcha,
  ]), true);
  assert.equal(inspectionHasSensitivePage([
    main,
    {
      ...dormantCaptcha,
      value: {
        ...dormantCaptcha.value,
        controls: [{ type: "button", label: "Reload CAPTCHA" }],
      },
    },
  ]), false);
  assert.equal(inspectionHasSensitivePage([
    main,
    {
      ...dormantCaptcha,
      value: {
        ...dormantCaptcha.value,
        controls: [{ type: "password", label: "CAPTCHA response" }],
      },
    },
  ]), true);
  assert.equal(inspectionHasSensitivePage([
    main,
    {
      ...dormantCaptcha,
      value: { ...dormantCaptcha.value, title: "Sign in", text: "Sign in" },
    },
  ]), true);
  assert.equal(inspectionHasSensitivePage([
    {
      ...main,
      value: {
        ...main.value,
        url: "https://www.linkedin.com/checkpoint/challengesV2/opaque",
        title: "Verify your identity",
        text: "Approve this sign-in",
      },
    },
  ]), true);
});

test("Greenhouse jobs allow only passive reCAPTCHA disclosure surfaces", () => {
  const main = {
    frame: { id: "main" },
    frameVisible: true,
    value: {
      url: "https://job-boards.greenhouse.io/tubitv/jobs/7702258",
      title: "Machine Learning Engineer | Tubi",
      text: "Apply for this job. This site is protected by reCAPTCHA and the Google Privacy Policy and Terms of Service apply.",
      controls: [
        { type: "email", label: "Email" },
        { type: "button", label: "Submit application" },
      ],
      securityControls: [],
    },
  };
  const passiveBadge = {
    frame: { id: "recaptcha-badge", parentId: "main" },
    frameVisible: true,
    value: {
      url: "https://www.google.com/recaptcha/api2/anchor?ar=1&k=public-site-key",
      title: "reCAPTCHA",
      text: "Privacy - Terms",
      controls: [],
      securityControls: [],
    },
  };

  assert.equal(inspectionHasSensitivePage([main, passiveBadge]), false);
  const hiddenResponseOnly = {
    ...main,
    value: {
      ...main.value,
      text: "Apply for this job",
      securityControls: [{
        type: "textarea",
        role: "textbox",
        autocomplete: "",
        label: "g-recaptcha-response",
      }],
    },
  };
  assert.equal(inspectionHasSensitivePage([hiddenResponseOnly]), false);
  assert.equal(inspectionHasSensitivePage([{
    ...hiddenResponseOnly,
    value: {
      ...hiddenResponseOnly.value,
      controls: hiddenResponseOnly.value.securityControls,
    },
  }]), true);
  assert.equal(inspectionHasSensitivePage([
    main,
    {
      ...passiveBadge,
      value: {
        ...passiveBadge.value,
        controls: [{ type: "checkbox", label: "I'm not a robot" }],
      },
    },
  ]), true);
  assert.equal(inspectionHasSensitivePage([
    main,
    {
      ...passiveBadge,
      value: {
        ...passiveBadge.value,
        url: "https://www.google.com/recaptcha/api2/bframe?hl=en",
        title: "reCAPTCHA challenge",
        text: "Select all images with traffic lights",
      },
    },
  ]), true);
  assert.equal(inspectionHasSensitivePage([
    {
      ...main,
      value: { ...main.value, text: "Complete CAPTCHA verification to apply" },
    },
    passiveBadge,
  ]), true);
  assert.equal(inspectionHasSensitivePage([
    { ...main, value: { ...main.value, url: "https://example.test/jobs/7702258" } },
    passiveBadge,
  ]), true);
});

test("Ashby applications allow only one passive hidden response and empty child frame", () => {
  const response = {
    type: "textarea",
    role: "textbox",
    autocomplete: "",
    label: "g-recaptcha-response",
  };
  const main = {
    frame: { id: "main" },
    frameVisible: true,
    value: {
      url: "https://jobs.ashbyhq.com/example/00000000-0000-4000-8000-000000000001/application",
      title: "Application",
      text: "Apply for this position",
      controls: [
        { type: "email", role: "textbox", autocomplete: "", label: "Email" },
        { type: "button", role: "button", autocomplete: "", label: "Continue" },
      ],
      securityControls: [
        { type: "email", role: "textbox", autocomplete: "", label: "Email" },
        { type: "button", role: "button", autocomplete: "", label: "Continue" },
        response,
      ],
      controlOverflow: false,
    },
  };
  const emptyChild = {
    frame: { id: "passive", parentId: "main" },
    frameVisible: false,
    value: {
      url: "about:blank",
      title: "",
      text: "",
      controls: [],
      securityControls: [],
      controlOverflow: false,
    },
  };
  const inspect = (mainValue = main.value, childValue = emptyChild.value, extras = []) =>
    inspectionHasSensitivePage([
      { ...main, value: mainValue },
      { ...emptyChild, value: childValue },
      ...extras,
    ]);

  assert.equal(inspect(), false);

  const invalidUrls = [
    "http://jobs.ashbyhq.com/example/00000000-0000-4000-8000-000000000001/application",
    "https://user@jobs.ashbyhq.com/example/00000000-0000-4000-8000-000000000001/application",
    "https://jobs.ashbyhq.com:444/example/00000000-0000-4000-8000-000000000001/application",
    "https://jobs.ashbyhq.com/example/00000000-0000-4000-8000-000000000001/application?source=test",
    "https://jobs.ashbyhq.com/example/00000000-0000-4000-8000-000000000001/application#form",
    "https://jobs.ashbyhq.com/example/00000000-0000-4000-8000-000000000001",
    "https://jobs.ashbyhq.com/application",
    "https://example.test/example/00000000-0000-4000-8000-000000000001/application",
  ];
  for (const url of invalidUrls) {
    assert.equal(inspect({ ...main.value, url }), true, url);
  }

  const invalidMainShapes = [
    {
      ...main.value,
      controls: [...main.value.controls, response],
    },
    {
      ...main.value,
      controls: [...main.value.controls, {
        type: "checkbox", role: "checkbox", autocomplete: "", label: "I'm not a robot",
      }],
    },
    {
      ...main.value,
      controls: [...main.value.controls, {
        type: "button", role: "button", autocomplete: "", label: "Start challenge",
      }],
    },
    {
      ...main.value,
      securityControls: [...main.value.securityControls, response],
    },
    {
      ...main.value,
      securityControls: main.value.securityControls.map((control) =>
        control === response ? { ...response, role: "control" } : control),
    },
    {
      ...main.value,
      securityControls: [...main.value.securityControls, {
        type: "password", role: "textbox", autocomplete: "current-password", label: "Password",
      }],
    },
    { ...main.value, text: "Complete CAPTCHA verification" },
    { ...main.value, text: "Authentication required" },
    { ...main.value, text: "Sign in to continue" },
  ];
  for (const value of invalidMainShapes) {
    assert.equal(inspect(value), true);
  }

  const invalidChildShapes = [
    { ...emptyChild.value, url: "https://example.test/frame" },
    { ...emptyChild.value, title: "Challenge" },
    { ...emptyChild.value, text: "Complete CAPTCHA verification" },
    {
      ...emptyChild.value,
      controls: [{ type: "checkbox", role: "checkbox", label: "I'm not a robot" }],
    },
    {
      ...emptyChild.value,
      securityControls: [{ type: "password", role: "textbox", label: "Password" }],
    },
  ];
  for (const value of invalidChildShapes) {
    assert.equal(inspect(main.value, value), true);
  }

  assert.equal(inspectionHasSensitivePage([main]), true);
  assert.equal(inspect(main.value, emptyChild.value, [{
    frame: { id: "unexpected", parentId: "main" },
    frameVisible: false,
    value: { ...emptyChild.value },
  }]), true);
  assert.equal(inspectionHasSensitivePage([
    main,
    { ...emptyChild, frame: { id: "passive", parentId: "other" } },
  ]), true);
});

test("Lever applications allow only the exact passive hidden hCaptcha bootstrap", () => {
  const textareaResponse = (label) => ({
    type: "textarea",
    role: "textbox",
    autocomplete: "",
    label,
    required: false,
  });
  const gResponse = textareaResponse("g-recaptcha-response");
  const hResponse = textareaResponse("h-captcha-response");
  const mainResponse = {
    ...hResponse,
    type: "hidden",
  };
  const visibleControls = [
    { type: "email", role: "textbox", autocomplete: "email", label: "Email" },
    { type: "button", role: "button", autocomplete: "", label: "Submit application" },
  ];
  const enclaveVersion = "a".repeat(40);
  const enclaveOwner = (channel) => ({
    src: `https://newassets.hcaptcha.com/captcha/v1/${enclaveVersion}/static/hcaptcha-enclave.html` +
      `#frame=enclave&_channel=${channel}&_origin=https%3A%2F%2Fjobs.lever.co` +
      `&host=jobs.lever.co&se=${enclaveVersion}`,
    title: "Widget containing checkbox for hCaptcha security challenge",
    visibility: "hidden",
    position: "fixed",
    width: 300,
    height: 200,
  });
  const auxiliaryOwner = {
    src: "",
    title: "",
    visibility: "hidden",
    position: "absolute",
    width: 1,
    height: 1,
  };
  const securityFrames = [
    auxiliaryOwner,
    enclaveOwner("ChannelOne1"),
    enclaveOwner("ChannelTwo2"),
  ];
  const main = {
    frame: { id: "main" },
    frameVisible: true,
    value: {
      url: "https://jobs.lever.co/example/00000000-0000-4000-8000-000000000001/apply",
      title: "Application",
      text: "Apply for this position",
      controls: visibleControls,
      securityControls: [...visibleControls, mainResponse],
      controlOverflow: false,
      securityFrames,
      securityFrameOverflow: false,
    },
  };
  const auxiliary = {
    frame: { id: "auxiliary", parentId: "main" },
    frameVisible: false,
    value: {
      url: "about:blank",
      title: "",
      text: "",
      controls: [],
      securityControls: [],
      controlOverflow: false,
    },
  };
  const hcaptchaChild = (id) => ({
    frame: { id, parentId: "main" },
    frameVisible: false,
    value: {
      url: "",
      title: "hCaptcha",
      text: "",
      controls: [],
      securityControls: [gResponse, hResponse],
      controlOverflow: false,
    },
  });
  const hcaptchaChildren = [hcaptchaChild("hcaptcha-one"), hcaptchaChild("hcaptcha-two")];
  const children = [auxiliary, ...hcaptchaChildren];
  const inspect = (mainValue = main.value, childValues = [auxiliary], extras = []) =>
    inspectionHasSensitivePage([
      { ...main, value: mainValue },
      ...childValues,
      ...extras,
    ]);

  assert.equal(inspect(), false);
  assert.equal(inspect(main.value, children), false);

  const invalidUrls = [
    "http://jobs.lever.co/example/00000000-0000-4000-8000-000000000001/apply",
    "https://user@jobs.lever.co/example/00000000-0000-4000-8000-000000000001/apply",
    "https://user:secret@jobs.lever.co/example/00000000-0000-4000-8000-000000000001/apply",
    "https://jobs.lever.co:444/example/00000000-0000-4000-8000-000000000001/apply",
    "https://jobs.lever.co/example/00000000-0000-4000-8000-000000000001/apply?source=test",
    "https://jobs.lever.co/example/00000000-0000-4000-8000-000000000001/apply#form",
    "https://www.jobs.lever.co/example/00000000-0000-4000-8000-000000000001/apply",
    "https://jobs.lever.co/example/00000000-0000-4000-8000-000000000001",
    "https://jobs.lever.co/example/apply",
    "https://jobs.lever.co/example/00000000-0000-4000-8000-000000000001/apply/extra",
    "https://example.test/example/00000000-0000-4000-8000-000000000001/apply",
  ];
  for (const url of invalidUrls) {
    assert.equal(inspect({ ...main.value, url }), true, url);
  }

  const invalidMainShapes = [
    { ...main.value, controlOverflow: true },
    { ...main.value, controls: [...visibleControls, mainResponse] },
    { ...main.value, securityControls: visibleControls },
    { ...main.value, securityControls: [...main.value.securityControls, mainResponse] },
    {
      ...main.value,
      securityControls: main.value.securityControls.map((control) =>
        control === mainResponse
          ? { ...mainResponse, label: "g-recaptcha-response" }
          : control),
    },
    {
      ...main.value,
      securityControls: main.value.securityControls.map((control) =>
        control === mainResponse ? { ...mainResponse, type: "textarea" } : control),
    },
    {
      ...main.value,
      securityControls: main.value.securityControls.map((control) =>
        control === mainResponse ? { ...mainResponse, role: "control" } : control),
    },
    {
      ...main.value,
      securityControls: main.value.securityControls.map((control) =>
        control === mainResponse ? { ...mainResponse, autocomplete: "off" } : control),
    },
    {
      ...main.value,
      securityControls: main.value.securityControls.map((control) =>
        control === mainResponse ? { ...mainResponse, required: true } : control),
    },
    {
      ...main.value,
      controls: [...visibleControls, {
        type: "checkbox", role: "checkbox", autocomplete: "", label: "I'm not a robot",
      }],
    },
    {
      ...main.value,
      controls: [...visibleControls, {
        type: "button", role: "button", autocomplete: "", label: "Start CAPTCHA challenge",
      }],
    },
    {
      ...main.value,
      securityControls: [...main.value.securityControls, {
        type: "password", role: "textbox", autocomplete: "current-password", label: "Password",
      }],
    },
    {
      ...main.value,
      controls: [...visibleControls, {
        type: "text", role: "textbox", autocomplete: "one-time-code", label: "Code",
      }],
    },
    { ...main.value, text: "Sign in to continue" },
    { ...main.value, text: "Create an account" },
    { ...main.value, text: "Enter your MFA code" },
    { ...main.value, text: "Complete CAPTCHA verification" },
  ];
  for (const [index, value] of invalidMainShapes.entries()) {
    assert.equal(inspect(value), true, `invalid Lever main shape ${index}`);
  }

  const mutateEnclaveUrl = (mutate) => {
    const url = new URL(enclaveOwner("ChannelOne1").src);
    mutate(url);
    return url.toString();
  };
  const mutateFragment = (name, value) => mutateEnclaveUrl((url) => {
    const params = new URLSearchParams(url.hash.slice(1));
    params.set(name, value);
    url.hash = params.toString();
  });
  const invalidEnclaveUrls = [
    mutateEnclaveUrl((url) => { url.protocol = "http:"; }),
    mutateEnclaveUrl((url) => { url.hostname = "assets.hcaptcha.com"; }),
    mutateEnclaveUrl((url) => { url.pathname = "/captcha/v1/not-a-version/static/hcaptcha-enclave.html"; }),
    mutateEnclaveUrl((url) => { url.pathname = `/captcha/v2/${enclaveVersion}/static/hcaptcha-enclave.html`; }),
    mutateEnclaveUrl((url) => { url.pathname = `/captcha/v1/${"a".repeat(39)}/static/hcaptcha-enclave.html`; }),
    mutateEnclaveUrl((url) => { url.username = "user"; }),
    mutateEnclaveUrl((url) => { url.password = "secret"; }),
    mutateEnclaveUrl((url) => { url.port = "444"; }),
    mutateEnclaveUrl((url) => { url.search = "?source=test"; }),
    mutateFragment("frame", "checkbox"),
    mutateFragment("_channel", "bad-channel"),
    mutateFragment("_origin", "https://example.test"),
    mutateFragment("host", "example.test"),
    mutateFragment("se", "b".repeat(40)),
    mutateEnclaveUrl((url) => {
      const params = new URLSearchParams(url.hash.slice(1));
      params.append("extra", "value");
      url.hash = params.toString();
    }),
  ];
  for (const src of invalidEnclaveUrls) {
    assert.equal(inspect({
      ...main.value,
      securityFrames: [auxiliaryOwner, { ...securityFrames[1], src }, securityFrames[2]],
    }), true, src);
  }

  const invalidOwnerInventories = [
    securityFrames.slice(0, 2),
    [...securityFrames, auxiliaryOwner],
    [auxiliaryOwner, { ...securityFrames[1], visibility: "visible" }, securityFrames[2]],
    [auxiliaryOwner, { ...securityFrames[1], position: "absolute" }, securityFrames[2]],
    [auxiliaryOwner, { ...securityFrames[1], width: 0 }, securityFrames[2]],
    [auxiliaryOwner, { ...securityFrames[1], height: 0 }, securityFrames[2]],
    [auxiliaryOwner, {
      ...securityFrames[1],
      title: "Widget containing hCaptcha challenge",
    }, securityFrames[2]],
    [{ ...auxiliaryOwner, src: "about:blank" }, ...securityFrames.slice(1)],
    [{ ...auxiliaryOwner, title: "Auxiliary" }, ...securityFrames.slice(1)],
    [{ ...auxiliaryOwner, visibility: "visible" }, ...securityFrames.slice(1)],
    [{ ...auxiliaryOwner, position: "fixed" }, ...securityFrames.slice(1)],
    [{ ...auxiliaryOwner, width: 2 }, ...securityFrames.slice(1)],
    [{ ...auxiliaryOwner, height: 0 }, ...securityFrames.slice(1)],
  ];
  for (const frames of invalidOwnerInventories) {
    assert.equal(inspect({ ...main.value, securityFrames: frames }), true);
  }
  assert.equal(inspect({ ...main.value, securityFrames: undefined }), true);
  assert.equal(inspect({ ...main.value, securityFrameOverflow: true }), true);

  const replaceFirstChild = (value, overrides = {}) => [
    auxiliary,
    { ...hcaptchaChildren[0], ...overrides, value },
    hcaptchaChildren[1],
  ];
  const invalidChildValues = [
    { ...hcaptchaChildren[0].value, url: "about:blank" },
    { ...hcaptchaChildren[0].value, url: "https://newassets.hcaptcha.com/captcha/v1/asset.html" },
    { ...hcaptchaChildren[0].value, title: "hCaptcha challenge" },
    { ...hcaptchaChildren[0].value, text: "Select all matching images" },
    { ...hcaptchaChildren[0].value, text: "Sign in to continue" },
    { ...hcaptchaChildren[0].value, controlOverflow: true },
    { ...hcaptchaChildren[0].value, controls: [gResponse, hResponse] },
    { ...hcaptchaChildren[0].value, securityControls: [hResponse] },
    { ...hcaptchaChildren[0].value, securityControls: [gResponse, hResponse, hResponse] },
    {
      ...hcaptchaChildren[0].value,
      securityControls: [{ ...gResponse, role: "control" }, hResponse],
    },
    {
      ...hcaptchaChildren[0].value,
      securityControls: [{ ...gResponse, type: "text" }, hResponse],
    },
    {
      ...hcaptchaChildren[0].value,
      securityControls: [{ ...gResponse, label: "recaptcha-response" }, hResponse],
    },
    {
      ...hcaptchaChildren[0].value,
      securityControls: [gResponse, { ...hResponse, autocomplete: "one-time-code" }],
    },
    {
      ...hcaptchaChildren[0].value,
      securityControls: [gResponse, { ...hResponse, required: true }],
    },
    {
      ...hcaptchaChildren[0].value,
      securityControls: [gResponse, hResponse, {
        type: "password", role: "textbox", autocomplete: "current-password", label: "Password",
      }],
    },
    {
      ...hcaptchaChildren[0].value,
      controls: [{ type: "checkbox", role: "checkbox", label: "I'm not a robot" }],
    },
  ];
  for (const value of invalidChildValues) {
    assert.equal(inspect(main.value, replaceFirstChild(value)), true);
  }

  assert.equal(inspect(main.value, [
    auxiliary,
    { ...hcaptchaChildren[0], frameVisible: true },
    hcaptchaChildren[1],
  ]), true);
  assert.equal(inspect(main.value, [
    auxiliary,
    { ...hcaptchaChildren[0], frame: { id: "hcaptcha-one", parentId: "other" } },
    hcaptchaChildren[1],
  ]), true);
  const invalidAuxiliaryValues = [
    { ...auxiliary.value, url: "" },
    { ...auxiliary.value, title: "Auxiliary" },
    { ...auxiliary.value, text: "Loading" },
    { ...auxiliary.value, controls: [{ type: "button", role: "button", label: "Continue" }] },
    { ...auxiliary.value, securityControls: [hResponse] },
    { ...auxiliary.value, controlOverflow: true },
  ];
  for (const value of invalidAuxiliaryValues) {
    assert.equal(inspect(main.value, [
      { ...auxiliary, value },
      ...hcaptchaChildren,
    ]), true);
  }
  assert.equal(inspect(main.value, [
    { ...auxiliary, frameVisible: true },
    ...hcaptchaChildren,
  ]), true);
  assert.equal(inspect(main.value, hcaptchaChildren), true);
  assert.equal(inspect(main.value, [auxiliary, hcaptchaChildren[0]]), true);
  assert.equal(inspect(main.value, children, [hcaptchaChild("hcaptcha-three")]), true);
  assert.equal(inspect(main.value, children, [{
    frame: { id: "sensitive", parentId: "main" },
    frameVisible: false,
    value: {
      url: "about:blank",
      title: "Sign in",
      text: "Authentication required",
      controls: [],
      securityControls: [],
      controlOverflow: false,
    },
  }]), true);
});

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

test("recorder options require one safe child of .qa-private and loopback CDP", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "recorder-options-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateRoot = path.join(directory, ".qa-private");
  await mkdir(privateRoot, { mode: 0o700 });
  const output = path.join(privateRoot, "qa-session-1");

  const valid = await validateRecorderOptions({
    cdpUrl: "http://127.0.0.1:9222",
    output,
  });
  assert.equal(valid.output, output);

  for (const invalid of [
    {},
    { cdpUrl: "http://example.test:9222", output },
    { cdpUrl: "file:///tmp/socket", output },
    { cdpUrl: "http://127.0.0.1:9222", output: privateRoot },
    {
      cdpUrl: "http://127.0.0.1:9222",
      output: path.join(output, "nested"),
    },
  ]) {
    await assert.rejects(
      validateRecorderOptions(invalid),
      (error) => !error.message.includes(directory) &&
        !error.message.includes("example.test"),
    );
  }

  const nonempty = path.join(privateRoot, "nonempty");
  await mkdir(nonempty);
  await writeFile(path.join(nonempty, "private.txt"), "secret");
  await assert.rejects(validateRecorderOptions({
    cdpUrl: "http://[::1]:9222",
    output: nonempty,
  }), /unsafe session directory/);

  const target = path.join(privateRoot, "target");
  const linked = path.join(privateRoot, "linked");
  await mkdir(target);
  await symlink(target, linked);
  await assert.rejects(validateRecorderOptions({
    cdpUrl: "http://localhost:9222",
    output: linked,
  }), /unsafe session directory/);
});

test("checkpoint client aborts a stalled local request by its deadline", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "checkpoint-timeout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateRoot = path.join(directory, ".qa-private");
  const session = path.join(privateRoot, "qa-session-timeout");
  await mkdir(path.join(session, "checkpoints"), { recursive: true, mode: 0o700 });
  const token = "t".repeat(43);
  let clientDisconnected;
  const disconnected = new Promise((resolve) => { clientDisconnected = resolve; });
  const server = http.createServer((request, response) => {
    request.resume();
    response.once("close", clientDisconnected);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await writeFile(path.join(session, "control.json"), `${JSON.stringify({
    port: server.address().port,
    token,
  })}\n`, { mode: 0o600 });

  const started = Date.now();
  const result = await runNode([
    "qa/recorder.mjs", "checkpoint", "--session", session,
    "--kind", "application-opened",
  ], 34000);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /recorder unavailable/);
  assert.ok(Date.now() - started < 33000);
  await withTimeout(disconnected, 1000, "checkpoint client did not abort");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(await readdir(path.join(session, "checkpoints")), []);
});

test("record refuses a login page before creating private evidence", async (t) => {
  const site = await startSyntheticSite(t);
  const { cdpUrl } = await startIndependentChromium(t, `${site}/login`);
  const directory = await mkdtemp(path.join(tmpdir(), "login-refusal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateRoot = path.join(directory, ".qa-private");
  await mkdir(privateRoot, { mode: 0o700 });
  const session = path.join(privateRoot, "qa-session-login");

  const result = await runNode([
    "qa/recorder.mjs", "record", "--cdp-url", cdpUrl, "--output", session,
  ], 10000);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /sensitive page refused/);
  assert.doesNotMatch(result.stderr, /Sign in|password|127\.0\.0\.1/);
  await assert.rejects(access(path.join(session, "capture-receipt.json")));
  await assert.rejects(access(path.join(session, "events.jsonl")));
});

function mockCaptureIsolated(send, devicePixelRatio = 1, setScriptExecution) {
  const frame = { id: "main-frame", loaderId: "main-loader" };
  const contextId = 17;
  return {
    contexts: new Map([[frame.id, contextId]]),
    allowedContexts: new Set([contextId]),
    session: { send: async (command, options) => {
      if (command === "Page.getFrameTree") return { frameTree: { frame } };
      if (command === "Runtime.evaluate") {
        if (options.expression.includes("setTimeout")) return { result: { value: true } };
        assert.equal(options.contextId, contextId);
        const value = typeof devicePixelRatio === "function" ?
          devicePixelRatio() : devicePixelRatio;
        return { result: { type: "number", value } };
      }
      if (command === "Emulation.setScriptExecutionDisabled") {
        return setScriptExecution?.(options.value) ?? {};
      }
      return send(command, options);
    } },
  };
}

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
  const emailEventRecorded = async () => {
    try {
      const text = await readFile(path.join(session, "events.jsonl"), "utf8");
      return text.trim().split("\n").filter(Boolean).map(JSON.parse)
        .some(expectedEmailEvent);
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

  await page.evaluate(() => {
    const style = document.createElement("style");
    style.id = "css-sensitive-style";
    style.textContent = `@keyframes css-sensitive-flash {
      0%, 48%, 52%, 100% { visibility: hidden }
      49%, 51% { visibility: visible }
    }`;
    document.head.append(style);
    const sensitive = document.createElement("div");
    sensitive.id = "css-transient-sensitive";
    sensitive.textContent = "Verify your identity";
    sensitive.style.animation = "css-sensitive-flash 100ms linear infinite";
    document.body.append(sensitive);
  });
  const cssTransientSensitive = await postControl(control, { kind: "application-opened" });
  assert.notEqual(cssTransientSensitive.status, 200);
  await page.evaluate(() => {
    document.querySelector("#css-transient-sensitive")?.remove();
    document.querySelector("#css-sensitive-style")?.remove();
  });
  assert.deepEqual(await readdir(path.join(session, "checkpoints")), []);

  await page.evaluate(() => {
    setTimeout(() => {
      const input = document.createElement("input");
      input.id = "transient-password";
      input.type = "password";
      document.body.append(input);
      setTimeout(() => input.remove(), 10);
    }, 5);
  });
  const transientSensitive = await postControl(control, { kind: "application-opened" });
  assert.notEqual(transientSensitive.status, 200);
  await page.locator("#transient-password").waitFor({ state: "detached" });
  assert.deepEqual(await readdir(path.join(session, "checkpoints")), []);

  await page.evaluate(() => {
    setTimeout(() => {
      const input = document.createElement("input");
      input.id = "late-password";
      input.type = "password";
      document.body.append(input);
    }, 10);
  });
  const changedDuringCapture = await postControl(control, { kind: "application-opened" });
  assert.notEqual(changedDuringCapture.status, 200);
  await page.locator("#late-password").waitFor();
  await page.locator("#late-password").evaluate((element) => element.remove());
  assert.deepEqual(await readdir(path.join(session, "checkpoints")), []);

  await page.evaluate(() => {
    const container = document.createElement("div");
    container.id = "too-many-controls";
    for (let index = 0; index < 1001; index += 1) {
      container.append(document.createElement("button"));
    }
    document.body.append(container);
  });
  const tooManyControls = await postControl(control, { kind: "application-opened" });
  assert.notEqual(tooManyControls.status, 200);
  await page.locator("#too-many-controls").evaluate((element) => element.remove());
  assert.deepEqual(await readdir(path.join(session, "checkpoints")), []);

  await page.evaluate(() => {
    const oversized = document.createElement("div");
    oversized.id = "oversized-page";
    oversized.style.width = "5000px";
    oversized.style.height = "17000px";
    document.body.append(oversized);
  });
  const oversizedPage = await postControl(control, { kind: "application-opened" });
  assert.notEqual(oversizedPage.status, 200);
  await page.locator("#oversized-page").evaluate((element) => element.remove());
  assert.deepEqual(await readdir(path.join(session, "checkpoints")), []);
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));

  await new Promise((resolve) => setTimeout(resolve, 500));

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
  await attached.close();

  for (const kind of [
    "validation-observed",
    "review-reached",
    "final-action-boundary",
  ]) {
    const result = await runNode([
      "qa/recorder.mjs", "checkpoint", "--session", session, "--kind", kind,
    ], 5000);
    assert.equal(result.code, 0, result.stderr);
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
