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

async function waitForDevToolsActivePort(filename, child, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Chromium exited before publishing DevToolsActivePort (code=${child.exitCode}, signal=${child.signalCode})`,
      );
    }
    try {
      const record = await readFile(filename, "utf8");
      const match = /^(\d+)\r?\n\/devtools\/browser\/[A-Za-z0-9._-]+(?:\r?\n)?$/.exec(record);
      const port = match ? Number(match[1]) : 0;
      if (
        Number.isSafeInteger(port)
        && port >= 1
        && port <= 65535
      ) {
        return port;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("DevToolsActivePort wait timed out");
}

async function waitForInitialPageTarget(port, expectedUrl, child, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Chromium exited before publishing its initial page target (code=${child.exitCode}, signal=${child.signalCode})`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        const targets = await response.json();
        if (Array.isArray(targets) && targets.some((target) => target?.type === "page" && target.url === expectedUrl)) return;
      }
    } catch (error) {
      if (error?.name !== "TimeoutError" && error?.cause?.code !== "ECONNREFUSED") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("initial Chromium page target wait timed out");
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
  const port = await waitForDevToolsActivePort(activePort, browserProcess, 10000);
  await waitForInitialPageTarget(port, url, browserProcess, 10000);
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


async function exerciseRejectedCaptureStates({ page, control, session }) {
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
}

export {
  BrokerClient,
  EventEmitter,
  abortCheckpointClient,
  access,
  assert,
  captureFullPagePng,
  chmod,
  chromium,
  commitCheckpoint,
  createHash,
  decodeCapturedPng,
  exerciseRejectedCaptureStates,
  http,
  inspectionHasSensitivePage,
  isSensitivePage,
  mkdir,
  mkdtemp,
  mockCaptureIsolated,
  once,
  path,
  postControl,
  readFile,
  readdir,
  rename,
  rm,
  root,
  runLauncher,
  runNode,
  sanitizeObservedControl,
  sendSlowPartialBody,
  spawn,
  startIndependentChromium,
  startPartialBody,
  startSyntheticSite,
  stat,
  stopChild,
  symlink,
  tmpdir,
  validateCaptureResources,
  validateCheckpointKind,
  validateRecorderOptions,
  validateSafetyRevision,
  waitForDevToolsActivePort,
  waitForExit,
  waitForFile,
  waitForInitialPageTarget,
  withTimeout,
  writeFile,
};
