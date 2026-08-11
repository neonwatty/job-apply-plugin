#!/usr/bin/env node

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

export const CHECKPOINT_KINDS = Object.freeze([
  "application-opened",
  "step-advanced",
  "validation-observed",
  "review-reached",
  "final-action-boundary",
]);

const CHECKPOINT_KIND_SET = new Set(CHECKPOINT_KINDS);
const SENSITIVE_PATTERN = /(?:\blog[ -]?in\b|\bsign[ -]?in\b|password|passcode|captcha|multi[ -]?factor|\bmfa\b|two[ -]?factor|verification code|create (?:an? )?account|account[ -]?creation|register)/i;
const MAX_CONTROL_BODY = 4096;
const MAX_EVENTS = 10_000;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

export class RecorderError extends Error {}

export function sanitizeObservedControl(observed) {
  const sourceLabel = typeof observed?.label === "string"
    ? observed.label.slice(0, 256)
    : "";
  const role = typeof observed?.role === "string"
    ? observed.role.slice(0, 64)
    : "unknown";
  return {
    role,
    sourceLabel,
    required: observed?.required === true,
  };
}

export function validateCheckpointKind(kind) {
  if (typeof kind !== "string" || !CHECKPOINT_KIND_SET.has(kind)) {
    throw new RecorderError("invalid checkpoint kind");
  }
  return kind;
}

export function isSensitivePage(snapshot) {
  const url = typeof snapshot?.url === "string" ? snapshot.url : "";
  const title = typeof snapshot?.title === "string" ? snapshot.title : "";
  const text = typeof snapshot?.text === "string" ? snapshot.text.slice(0, 8192) : "";
  const controls = Array.isArray(snapshot?.controls) ? snapshot.controls : [];
  if (SENSITIVE_PATTERN.test(`${url}\n${title}\n${text}`)) return true;
  return controls.some((control) => {
    const type = typeof control?.type === "string" ? control.type : "";
    const label = typeof control?.label === "string" ? control.label : "";
    return type.toLowerCase() === "password" || SENSITIVE_PATTERN.test(label);
  });
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") {
    return true;
  }
  return net.isIP(normalized) === 4 && normalized.startsWith("127.");
}

async function inspectOutput(output) {
  const absolute = path.resolve(output);
  const parent = path.dirname(absolute);
  if (path.basename(parent) !== ".qa-private" || path.dirname(absolute) === absolute) {
    throw new RecorderError("unsafe session directory");
  }
  let parentReal;
  try {
    const parentStat = await lstat(parent);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      throw new RecorderError("unsafe session directory");
    }
    parentReal = await realpath(parent);
  } catch {
    throw new RecorderError("unsafe session directory");
  }
  if (path.basename(parentReal) !== ".qa-private") {
    throw new RecorderError("unsafe session directory");
  }
  try {
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new RecorderError("unsafe session directory");
    }
    if ((await readdir(absolute)).length !== 0) {
      throw new RecorderError("unsafe session directory");
    }
  } catch (error) {
    if (error instanceof RecorderError) throw error;
    if (error?.code !== "ENOENT") throw new RecorderError("unsafe session directory");
  }
  return absolute;
}

async function inspectExistingSession(session) {
  if (typeof session !== "string" || !session) {
    throw new RecorderError("missing checkpoint arguments");
  }
  const absolute = path.resolve(session);
  const parent = path.dirname(absolute);
  if (path.basename(parent) !== ".qa-private") {
    throw new RecorderError("unsafe session directory");
  }
  try {
    const parentReal = await realpath(parent);
    const sessionStat = await lstat(absolute);
    const sessionReal = await realpath(absolute);
    if (path.basename(parentReal) !== ".qa-private" || sessionStat.isSymbolicLink() ||
        !sessionStat.isDirectory() || path.dirname(sessionReal) !== parentReal) {
      throw new RecorderError("unsafe session directory");
    }
  } catch (error) {
    if (error instanceof RecorderError) throw error;
    throw new RecorderError("unsafe session directory");
  }
  return absolute;
}

export async function validateRecorderOptions(options) {
  if (!options || typeof options.cdpUrl !== "string" ||
      typeof options.output !== "string" || !options.cdpUrl || !options.output) {
    throw new RecorderError("missing recorder arguments");
  }
  let endpoint;
  try {
    endpoint = new URL(options.cdpUrl);
  } catch {
    throw new RecorderError("invalid CDP endpoint");
  }
  if (endpoint.protocol !== "http:" || !endpoint.port ||
      endpoint.username || endpoint.password || endpoint.pathname !== "/" ||
      endpoint.search || endpoint.hash || !isLoopbackHostname(endpoint.hostname)) {
    throw new RecorderError("invalid CDP endpoint");
  }
  return {
    cdpUrl: endpoint.href.replace(/\/$/, ""),
    output: await inspectOutput(options.output),
  };
}

function parseFlags(args, names) {
  if (args.length !== names.length * 2) throw new RecorderError("missing recorder arguments");
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!names.includes(flag) || Object.hasOwn(result, flag) || !value) {
      throw new RecorderError("invalid recorder arguments");
    }
    result[flag] = value;
  }
  if (Object.keys(result).length !== names.length) {
    throw new RecorderError("missing recorder arguments");
  }
  return result;
}

function privateJson(filename, value) {
  return writeFile(filename, `${JSON.stringify(value)}\n`, { mode: FILE_MODE, flag: "wx" });
}

function pageInstaller() {
  if (globalThis.__qaRecorderInstalled) return;
  Object.defineProperty(globalThis, "__qaRecorderInstalled", { value: true });
  const sensitive = () => {
    const summary = `${location.href}\n${document.title}\n${document.body?.innerText?.slice(0, 8192) ?? ""}`;
    return /(?:\blog[ -]?in\b|\bsign[ -]?in\b|password|passcode|captcha|multi[ -]?factor|\bmfa\b|two[ -]?factor|verification code|create (?:an? )?account|account[ -]?creation|register)/i.test(summary) ||
      Boolean(document.querySelector('input[type="password"]'));
  };
  const labelFor = (element) => {
    const aria = element.getAttribute("aria-label");
    if (aria) return aria;
    const labelled = element.getAttribute("aria-labelledby");
    if (labelled) {
      const label = labelled.split(/\s+/).map((id) => document.getElementById(id)?.innerText ?? "").join(" ").trim();
      if (label) return label;
    }
    if (element.labels?.length) {
      return Array.from(element.labels).map((label) => label.innerText).join(" ").trim();
    }
    if (element instanceof HTMLButtonElement) return element.innerText.trim();
    return element.getAttribute("name") || element.getAttribute("placeholder") || "Unlabelled control";
  };
  const roleFor = (element) => {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;
    if (element instanceof HTMLButtonElement) return "button";
    if (element instanceof HTMLSelectElement) return "combobox";
    if (element instanceof HTMLTextAreaElement) return "textbox";
    if (element instanceof HTMLInputElement) {
      if (element.type === "checkbox") return "checkbox";
      if (element.type === "radio") return "radio";
      if (element.type === "file") return "file";
      return "textbox";
    }
    return "control";
  };
  for (const interactionType of ["click", "change", "input"]) {
    document.addEventListener(interactionType, (event) => {
      if (sensitive()) return;
      const element = event.target instanceof Element
        ? event.target.closest("input,select,textarea,button,[role]")
        : null;
      if (!element || (element instanceof HTMLInputElement && element.type === "password")) return;
      globalThis.__qaRecorderObserve({
        interactionType,
        role: roleFor(element),
        label: labelFor(element),
        required: element.matches("[required],[aria-required=true]"),
      }).catch(() => {});
    }, true);
  }
}

async function snapshotPage(page) {
  return page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll("input,select,textarea,button,[role]"));
    const labelFor = (element) => {
      const aria = element.getAttribute("aria-label");
      if (aria) return aria;
      const labelled = element.getAttribute("aria-labelledby");
      if (labelled) {
        const value = labelled.split(/\s+/).map((id) => document.getElementById(id)?.innerText ?? "").join(" ").trim();
        if (value) return value;
      }
      if (element.labels?.length) return Array.from(element.labels).map((item) => item.innerText).join(" ").trim();
      if (element instanceof HTMLButtonElement) return element.innerText.trim();
      return element.getAttribute("name") || element.getAttribute("placeholder") || "Unlabelled control";
    };
    const roleFor = (element) => {
      if (element.getAttribute("role")) return element.getAttribute("role");
      if (element instanceof HTMLButtonElement) return "button";
      if (element instanceof HTMLSelectElement) return "combobox";
      if (element instanceof HTMLTextAreaElement) return "textbox";
      if (element instanceof HTMLInputElement) {
        if (element.type === "checkbox") return "checkbox";
        if (element.type === "radio") return "radio";
        if (element.type === "file") return "file";
        return "textbox";
      }
      return "control";
    };
    return {
      url: location.href,
      title: document.title,
      text: document.body?.innerText?.slice(0, 8192) ?? "",
      controls: controls.map((element) => ({
        type: element instanceof HTMLInputElement ? element.type : element.tagName.toLowerCase(),
        label: labelFor(element),
        role: roleFor(element),
        required: element.matches("[required],[aria-required=true]"),
      })),
    };
  });
}

function ordinaryPages(browser) {
  return browser.contexts().flatMap((context) => context.pages()).filter((page) => {
    try {
      const protocol = new URL(page.url()).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  });
}

function lifecycleAllows(kinds, kind) {
  if (kinds.length === 0) return kind === "application-opened";
  const last = kinds.at(-1);
  if (last === "final-action-boundary") return false;
  if (kind === "application-opened") return false;
  if (kind === "final-action-boundary") return last === "review-reached";
  if (last === "review-reached") return false;
  return kind === "step-advanced" || kind === "validation-observed" || kind === "review-reached";
}

async function sha256File(filename) {
  return createHash("sha256").update(await readFile(filename)).digest("hex");
}

async function sourceFileMap(session, checkpointNames) {
  const relativePaths = ["events.jsonl", "recording-summary.json"];
  for (const checkpointName of checkpointNames) {
    for (const basename of ["page.html", "page.png", "controls.json", "checkpoint.json"]) {
      relativePaths.push(`checkpoints/${checkpointName}/${basename}`);
    }
  }
  const entries = await Promise.all(relativePaths.sort().map(async (relative) => [
    relative,
    await sha256File(path.join(session, ...relative.split("/"))),
  ]));
  return Object.fromEntries(entries);
}

function authorizedRequest(request, port, token) {
  if (request.socket.remoteAddress !== "127.0.0.1" &&
      request.socket.remoteAddress !== "::ffff:127.0.0.1") return false;
  if (request.headers.host !== `127.0.0.1:${port}` ||
      request.headers.origin !== `http://127.0.0.1:${port}` ||
      request.headers["content-type"] !== "application/json") return false;
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_CONTROL_BODY) throw new RecorderError("invalid control request");
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RecorderError("invalid control request");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RecorderError("invalid control request");
  }
  return body;
}

async function runRecord(rawOptions) {
  const options = await validateRecorderOptions(rawOptions);
  let browser;
  let server;
  let controlPath;
  let clean = false;
  try {
    browser = await chromium.connectOverCDP(options.cdpUrl);
    const pages = ordinaryPages(browser);
    if (pages.length !== 1) throw new RecorderError("ordinary page selection required");
    const page = pages[0];
    const initialSnapshot = await snapshotPage(page);
    if (isSensitivePage(initialSnapshot)) throw new RecorderError("sensitive page refused");

    await mkdir(options.output, { mode: DIRECTORY_MODE, recursive: true });
    await chmod(options.output, DIRECTORY_MODE);
    await mkdir(path.join(options.output, "checkpoints"), { mode: DIRECTORY_MODE });
    const eventsPath = path.join(options.output, "events.jsonl");
    await writeFile(eventsPath, "", { mode: FILE_MODE, flag: "wx" });
    let eventCount = 0;
    let pageSequence = 1;
    let writeQueue = Promise.resolve();
    const checkpointKinds = [];
    const checkpointNames = [];

    await page.exposeBinding("__qaRecorderObserve", (_source, observed) => {
      if (eventCount >= MAX_EVENTS || !observed ||
          !["click", "change", "input"].includes(observed.interactionType)) return;
      const control = sanitizeObservedControl(observed);
      if (!control.sourceLabel || control.role === "unknown") return;
      eventCount += 1;
      const event = {
        timestamp: new Date().toISOString(),
        pageSequence,
        interactionType: observed.interactionType,
        ...control,
      };
      writeQueue = writeQueue.then(() => appendFile(eventsPath, `${JSON.stringify(event)}\n`, { mode: FILE_MODE }));
      return writeQueue;
    });
    await page.addInitScript(pageInstaller);
    await page.evaluate(pageInstaller);
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) pageSequence += 1;
    });

    const writeCheckpoint = async (kind) => {
      validateCheckpointKind(kind);
      if (!lifecycleAllows(checkpointKinds, kind)) throw new RecorderError("invalid checkpoint lifecycle");
      await writeQueue;
      const snapshot = await snapshotPage(page);
      if (isSensitivePage(snapshot)) throw new RecorderError("sensitive page refused");
      const sequence = checkpointKinds.length + 1;
      const checkpointName = `${String(sequence).padStart(4, "0")}-${kind}`;
      const checkpointDirectory = path.join(options.output, "checkpoints", checkpointName);
      await mkdir(checkpointDirectory, { mode: DIRECTORY_MODE });
      const controls = snapshot.controls
        .filter((control) => control.type !== "password")
        .map(sanitizeObservedControl);
      const html = await page.content();
      const screenshot = await page.screenshot({ fullPage: true });
      await Promise.all([
        writeFile(path.join(checkpointDirectory, "page.html"), html, { mode: FILE_MODE, flag: "wx" }),
        writeFile(path.join(checkpointDirectory, "page.png"), screenshot, { mode: FILE_MODE, flag: "wx" }),
        privateJson(path.join(checkpointDirectory, "controls.json"), controls),
        privateJson(path.join(checkpointDirectory, "checkpoint.json"), {
          kind,
          sequence,
          timestamp: new Date().toISOString(),
          pageSequence,
        }),
      ]);
      checkpointKinds.push(kind);
      checkpointNames.push(checkpointName);
    };

    const token = randomBytes(32).toString("base64url");
    let stopRequested;
    const stopPromise = new Promise((resolve) => { stopRequested = resolve; });
    server = http.createServer(async (request, response) => {
      const port = server.address().port;
      const reject = (status = 400) => {
        response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        response.end('{"error":"request rejected"}\n');
      };
      if (request.method !== "POST" || !["/checkpoint", "/stop"].includes(request.url) ||
          !authorizedRequest(request, port, token)) {
        request.resume();
        reject(403);
        return;
      }
      try {
        const body = await readRequestBody(request);
        if (request.url === "/checkpoint") {
          if (Object.keys(body).length !== 1 || !Object.hasOwn(body, "kind")) {
            throw new RecorderError("invalid control request");
          }
          await writeCheckpoint(body.kind);
        } else {
          if (Object.keys(body).length !== 0) throw new RecorderError("invalid control request");
          stopRequested();
        }
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end('{"ok":true}\n');
      } catch {
        reject(400);
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    controlPath = path.join(options.output, "control.json");
    await privateJson(controlPath, { port, token });

    const signalPromise = new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    await Promise.race([signalPromise, stopPromise]);
    clean = true;
    await writeQueue;
    await privateJson(path.join(options.output, "recording-summary.json"), {
      checkpointKinds,
    });
    const receipt = {
      recorderVersion: "1.0.0",
      captureMonth: new Date().toISOString().slice(0, 7),
      captureId: randomBytes(18).toString("base64url"),
      sourceFiles: await sourceFileMap(options.output, checkpointNames),
    };
    await privateJson(path.join(options.output, "capture-receipt.json"), receipt);
  } finally {
    if (controlPath) await rm(controlPath, { force: true }).catch(() => {});
    if (server) await new Promise((resolve) => server.close(resolve)).catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (!clean) {
      // Private evidence is intentionally retained for manual inspection.
    }
  }
}

async function runCheckpoint(rawSession, rawKind) {
  const session = await inspectExistingSession(rawSession);
  const kind = validateCheckpointKind(rawKind);
  let control;
  try {
    const controlFile = path.join(session, "control.json");
    const controlStat = await lstat(controlFile);
    if (controlStat.isSymbolicLink() || !controlStat.isFile()) throw new Error();
    control = JSON.parse(await readFile(controlFile, "utf8"));
    if (!control || typeof control !== "object" || Array.isArray(control) ||
        Object.keys(control).sort().join(",") !== "port,token" ||
        !Number.isInteger(control.port) || control.port < 1 || control.port > 65535 ||
        typeof control.token !== "string" || !/^[A-Za-z0-9_-]{32,}$/.test(control.token)) {
      throw new Error();
    }
  } catch {
    throw new RecorderError("recorder unavailable");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(`http://127.0.0.1:${control.port}/checkpoint`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${control.token}`,
        "content-type": "application/json",
        host: `127.0.0.1:${control.port}`,
        origin: `http://127.0.0.1:${control.port}`,
      },
      body: JSON.stringify({ kind }),
      signal: controller.signal,
    });
    if (!response.ok) throw new RecorderError("checkpoint rejected");
  } catch (error) {
    if (error instanceof RecorderError) throw error;
    throw new RecorderError("recorder unavailable");
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const command = process.argv[2];
  if (command === "record") {
    const flags = parseFlags(process.argv.slice(3), ["--cdp-url", "--output"]);
    await runRecord({ cdpUrl: flags["--cdp-url"], output: flags["--output"] });
    return;
  }
  if (command === "checkpoint") {
    const flags = parseFlags(process.argv.slice(3), ["--session", "--kind"]);
    await runCheckpoint(flags["--session"], flags["--kind"]);
    return;
  }
  throw new RecorderError("invalid recorder command");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof RecorderError ? error.message : "recorder failed"}\n`);
    process.exitCode = 1;
  });
}
