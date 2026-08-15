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
  commitCheckpoint,
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

async function startIndependentChromium(t, url) {
  const profile = await mkdtemp(path.join(tmpdir(), "recorder-chrome-"));
  const browserProcess = spawn(chromium.executablePath(), [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    url,
  ], { stdio: "ignore" });
  t.after(async () => {
    await stopChild(browserProcess);
    await rm(profile, { recursive: true, force: true });
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
  await waitForFile(path.join(session, "control.json"), 10000);
  const checkpoint = await runNode([
    "qa/recorder.mjs", "checkpoint", "--session", session,
    "--kind", "application-opened",
  ], 10000);
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
  ], 10000);
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
  await page.locator("#email").fill(privateEmail);
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

  await cdpSession.send("Debugger.pause");
  const firstConcurrent = postControl(control, { kind: "application-opened" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const secondConcurrent = postControl(control, { kind: "step-advanced" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const overflowConcurrent = await postControl(control, { kind: "validation-observed" });
  assert.notEqual(overflowConcurrent.status, 200);
  await cdpSession.send("Debugger.resume");
  const concurrentStatuses = await Promise.all([firstConcurrent, secondConcurrent]);
  assert.deepEqual(concurrentStatuses.map((response) => response.status), [200, 200]);
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
  assert.ok(events.some((event) =>
    event.interactionType === "input" &&
    event.role === "textbox" &&
    event.sourceLabel === "Private Person email" &&
    event.required === true));
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
