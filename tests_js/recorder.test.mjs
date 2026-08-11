import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
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
  isSensitivePage,
  sanitizeObservedControl,
  validateCheckpointKind,
  validateRecorderOptions,
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

async function startSyntheticSite(t) {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (request.url === "/login") {
      response.end("<!doctype html><title>Sign in</title><form><label>Access phrase<input type=password></label></form>");
      return;
    }
    response.end(`<!doctype html><title>Application</title>
      <main><h1>Apply for this position</h1>
      <label>Private Person email<input id=email type=email required></label>
      <label>Resume upload<input id=resume type=file required></label>
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
  for (const text of ["Complete CAPTCHA verification", "Enter your MFA code"]) {
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
  ], 5000);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /recorder unavailable/);
  assert.ok(Date.now() - started < 4000);
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

test("recorder captures sanitized interactions and secure sequential checkpoints", async (t) => {
  const site = await startSyntheticSite(t);
  const { browserProcess, cdpUrl } = await startIndependentChromium(t, `${site}/application`);
  const directory = await mkdtemp(path.join(tmpdir(), "recording-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateRoot = path.join(directory, ".qa-private");
  await mkdir(privateRoot, { mode: 0o700 });
  const session = path.join(privateRoot, "qa-session-app");
  await mkdir(session, { mode: 0o755 });

  const recorder = spawn(process.execPath, [
    "qa/recorder.mjs", "record", "--cdp-url", cdpUrl, "--output", session,
  ], { cwd: root });
  let recorderStderr = "";
  recorder.stderr.setEncoding("utf8");
  recorder.stderr.on("data", (chunk) => { recorderStderr += chunk; });
  t.after(() => stopChild(recorder));
  const controlPath = path.join(session, "control.json");
  await waitForFile(controlPath, 10000);
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

  await page.goto(`${site}/login`);
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

  const cdpSession = await attached.contexts()[0].newCDPSession(page);
  await cdpSession.send("Debugger.enable");
  await cdpSession.send("Debugger.pause");
  await abortCheckpointClient(control, 100);
  await cdpSession.send("Debugger.resume");
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.deepEqual(await readdir(path.join(session, "checkpoints")), []);

  await cdpSession.send("Debugger.pause");
  const firstConcurrent = postControl(control, { kind: "application-opened" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const secondConcurrent = postControl(control, { kind: "step-advanced" });
  await new Promise((resolve) => setTimeout(resolve, 50));
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
  assert.ok(events.length <= 10_000);

  const controls = JSON.parse(controlsText);
  assert.ok(controls.some((control) => control.sourceLabel === "Private Person email"));
  assert.equal(controls.some((control) => control.sourceLabel === "Secret password"), false);

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

test("recorder source has no prohibited browser data capture APIs", async () => {
  const source = await readFile(path.join(root, "qa", "recorder.mjs"), "utf8");
  for (const prohibited of [
    "context.cookies(", "storageState(", "response.body(",
    "localStorage", "sessionStorage", "authorization headers",
    "browser.close(", 'send("Browser.close"',
  ]) {
    assert.equal(source.includes(prohibited), false, prohibited);
  }
});
