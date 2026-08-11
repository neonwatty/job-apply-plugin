#!/usr/bin/env node

import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
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
const SENSITIVE_PATTERN = /(?:\blog[ -]?in\b|\bsign[ -]?in\b|password|passcode|captcha|multi[ -]?factor|\bmfa\b|two[ -]?factor|verification code|create (?:an? )?account|account[ -]?creation|register|\botp\b|authentication|challenge|security[ -]?key|one[ -]?time[ -]?code)/i;
const MAX_CONTROL_BODY = 4096;
const MAX_EVENTS = 10_000;
const BODY_DEADLINE_MS = 500;
const CAPTURE_DEADLINE_MS = 1000;
const BROKER_REQUEST_DEADLINE_MS = 1000;
const CHECKPOINT_OPERATION_DEADLINE_MS = 12_000;
const CLIENT_DEADLINE_MS = 14_000;
export const CAPTURE_LIMITS = Object.freeze({
  maxControls: 1_000,
  maxHtmlBytes: 1_048_576,
  maxScreenshotWidth: 4_096,
  maxScreenshotHeight: 16_384,
  maxScreenshotBytes: 8_388_608,
  maxCheckpoints: 100,
  maxSessionBytes: 67_108_864,
});

export class RecorderError extends Error {}

export function validateCaptureResources(resources, limits = CAPTURE_LIMITS) {
  const checks = [
    ["controlCount", "maxControls"],
    ["htmlBytes", "maxHtmlBytes"],
    ["screenshotWidth", "maxScreenshotWidth"],
    ["screenshotHeight", "maxScreenshotHeight"],
    ["screenshotBytes", "maxScreenshotBytes"],
    ["checkpointCount", "maxCheckpoints"],
    ["sessionBytes", "maxSessionBytes"],
  ];
  for (const [resource, limit] of checks) {
    const value = resources[resource] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0 || value > limits[limit]) {
      throw new RecorderError("capture resource limit exceeded");
    }
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new RecorderError("operation canceled");
}

function withDeadline(promise, timeoutMs, signal, onTimeout) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, new RecorderError("operation canceled"));
    const timer = setTimeout(() => {
      try {
        onTimeout?.();
      } finally {
        finish(reject, new RecorderError("operation timed out"));
      }
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

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
    const autocomplete = typeof control?.autocomplete === "string"
      ? control.autocomplete.toLowerCase()
      : "";
    return type.toLowerCase() === "password" ||
      ["current-password", "one-time-code"].includes(autocomplete) ||
      SENSITIVE_PATTERN.test(label);
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

class BrokerClient {
  constructor(child, lines) {
    this.child = child;
    this.lines = lines;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  static async start(root) {
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const child = spawn("python3", ["-m", "qa.recorder_fs", "--root", root], {
      cwd: repositoryRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.resume();
    const lines = readline.createInterface({ input: child.stdout });
    let ready;
    try {
      ready = await withDeadline(new Promise((resolve, reject) => {
        lines.once("line", (line) => {
          try {
            const message = JSON.parse(line);
            if (message?.ready !== true || Object.keys(message).length !== 1) throw new Error();
            resolve();
          } catch {
            reject(new RecorderError("filesystem broker unavailable"));
          }
        });
        child.once("exit", () => reject(new RecorderError("filesystem broker unavailable")));
        child.once("error", () => reject(new RecorderError("filesystem broker unavailable")));
      }), 2000);
    } catch (error) {
      lines.close();
      child.kill("SIGTERM");
      throw error;
    }
    void ready;
    const client = new BrokerClient(child, lines);
    lines.on("line", (line) => client._handleLine(line));
    child.on("exit", () => client._failAll());
    child.on("error", () => client._failAll());
    return client;
  }

  _failAll() {
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(new RecorderError("filesystem broker unavailable"));
    }
    this.pending.clear();
  }

  _handleLine(line) {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      this._failAll();
      return;
    }
    const pending = this.pending.get(response?.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.ok === true && Object.hasOwn(response, "result")) {
      pending.resolve(response.result);
    } else {
      pending.reject(new RecorderError("filesystem operation rejected"));
    }
  }

  request(command, fields = {}) {
    if (this.closed || this.child.exitCode !== null) {
      return Promise.reject(new RecorderError("filesystem broker unavailable"));
    }
    const id = this.nextId++;
    const payload = `${JSON.stringify({ id, command, ...fields })}\n`;
    const operation = withDeadline(new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(payload, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(new RecorderError("filesystem broker unavailable"));
        }
      });
    }), BROKER_REQUEST_DEADLINE_MS);
    return operation.finally(() => this.pending.delete(id));
  }

  write(command, relative, data) {
    return this.request(command, {
      path: relative,
      data: Buffer.from(data).toString("base64"),
    });
  }

  writeJson(command, relative, value) {
    return this.write(command, relative, `${JSON.stringify(value)}\n`);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    await withDeadline(new Promise((resolve) => {
      if (this.child.exitCode !== null) resolve();
      else this.child.once("exit", resolve);
    }), 2000).catch(() => {
      this.child.kill("SIGTERM");
    });
    this.lines.close();
  }
}

function isolatedInstallerSource(bindingName) {
  return `(() => {
    if (globalThis.__qaIsolatedRecorderInstalled) return;
    Object.defineProperty(globalThis, "__qaIsolatedRecorderInstalled", { value: true });
    const binding = globalThis[${JSON.stringify(bindingName)}];
    if (typeof binding !== "function") return;
    const labelFor = (element) => {
      const aria = element.getAttribute("aria-label");
      if (aria) return aria;
      const labelled = element.getAttribute("aria-labelledby");
      if (labelled) {
        const label = labelled.split(/\\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ").trim();
        if (label) return label;
      }
      if (element.labels?.length) return Array.from(element.labels).map((label) => label.innerText).join(" ").trim();
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
    for (const interactionType of ["click", "change", "input"]) {
      document.addEventListener(interactionType, (event) => {
        const element = event.target instanceof Element ? event.target.closest("input,select,textarea,button,[role]") : null;
        if (!element || (element instanceof HTMLInputElement && ["password", "hidden"].includes(element.type))) return;
        binding(JSON.stringify({
          interactionType,
          role: roleFor(element),
          label: labelFor(element),
          required: element.matches("[required],[aria-required=true]"),
        }));
      }, true);
    }
  })()`;
}

function isolatedSnapshotSource(includeStructure) {
  return `(() => {
    const denied = /(?:password|passcode|captcha|multi[ -]?factor|\\bmfa\\b|\\botp\\b|authentication|challenge|security[ -]?key|one[ -]?time[ -]?code|authorization|bearer|cookie|session|csrf|token)/i;
    const labelFor = (element) => {
      const aria = element.getAttribute("aria-label");
      if (aria) return aria;
      const labelled = element.getAttribute("aria-labelledby");
      if (labelled) {
        const label = labelled.split(/\\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ").trim();
        if (label) return label;
      }
      if (element.labels?.length) return Array.from(element.labels).map((label) => label.innerText).join(" ").trim();
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
    const elements = Array.from(document.querySelectorAll("input,select,textarea,button,[role]"));
    const controls = elements.slice(0, ${CAPTURE_LIMITS.maxControls + 1}).map((element) => ({
      type: element instanceof HTMLInputElement ? element.type : element.tagName.toLowerCase(),
      autocomplete: element.getAttribute("autocomplete") || "",
      label: labelFor(element).slice(0, 256),
      role: roleFor(element).slice(0, 64),
      required: element.matches("[required],[aria-required=true]"),
    }));
    let html = "";
    let structuralOverflow = false;
    if (${includeStructure ? "true" : "false"}) {
      const allowed = new Set(["html","body","main","section","article","div","form","fieldset","legend","label","h1","h2","h3","h4","h5","h6","p","span","ul","ol","li","button","input","select","option","textarea"]);
      const allowedAttributes = new Set(["role","aria-label","aria-required","required","type","name","autocomplete"]);
      const escape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
      let nodes = 0;
      const serialize = (node) => {
        if (++nodes > 5000) { structuralOverflow = true; return ""; }
        if (node.nodeType === Node.TEXT_NODE) {
          const text = (node.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 512);
          return !text || denied.test(text) ? "" : escape(text);
        }
        if (!(node instanceof Element)) return "";
        const tag = node.tagName.toLowerCase();
        if (!allowed.has(tag)) return "";
        if (node.matches("[hidden],[aria-hidden=true],input[type=hidden],input[type=password]")) return "";
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") return "";
        const attributes = [];
        for (const attribute of node.attributes) {
          const name = attribute.name.toLowerCase();
          if (!allowedAttributes.has(name) || ["value","checked","selected"].includes(name)) continue;
          if (denied.test(name) || denied.test(attribute.value)) continue;
          attributes.push(attribute.value === "" ? name : name + '=\"' + escape(attribute.value.slice(0, 256)) + '\"');
        }
        let children = "";
        for (const child of node.childNodes) children += serialize(child);
        const result = "<" + tag + (attributes.length ? " " + attributes.join(" ") : "") + ">" + children + "</" + tag + ">";
        if (result.length > ${CAPTURE_LIMITS.maxHtmlBytes + 1}) structuralOverflow = true;
        return result.slice(0, ${CAPTURE_LIMITS.maxHtmlBytes + 1});
      };
      html = "<!doctype html>" + serialize(document.documentElement);
    }
    return {
      title: document.title.slice(0, 512),
      text: (document.body?.innerText || "").slice(0, 8192),
      controls,
      controlOverflow: elements.length > ${CAPTURE_LIMITS.maxControls},
      html,
      structuralOverflow,
      width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
      height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
    };
  })()`;
}

function flattenFrameTree(tree, frames = []) {
  frames.push({ id: tree.frame.id, loaderId: tree.frame.loaderId, url: tree.frame.url });
  for (const child of tree.childFrames ?? []) flattenFrameTree(child, frames);
  return frames;
}

async function createIsolatedRecorder(context, page, observe, navigated) {
  const session = await context.newCDPSession(page);
  const worldName = `qa-recorder-${randomBytes(18).toString("base64url")}`;
  const bindingName = `__qa_${randomBytes(18).toString("hex")}`;
  const contexts = new Map();
  const allowedContexts = new Set();
  const installer = isolatedInstallerSource(bindingName);
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("Runtime.addBinding", { name: bindingName, executionContextName: worldName });
  await session.send("Page.addScriptToEvaluateOnNewDocument", { source: installer, worldName });
  const install = async (frameId) => {
    try {
      const created = await session.send("Page.createIsolatedWorld", {
        frameId,
        worldName,
        grantUniversalAccess: false,
      });
      contexts.set(frameId, created.executionContextId);
      allowedContexts.add(created.executionContextId);
      await session.send("Runtime.evaluate", {
        expression: installer,
        contextId: created.executionContextId,
      });
    } catch {
      // A detach/navigation racing world creation is rejected by the next stable inspection.
    }
  };
  session.on("Runtime.executionContextDestroyed", ({ executionContextId }) => {
    allowedContexts.delete(executionContextId);
    for (const [frameId, contextId] of contexts) {
      if (contextId === executionContextId) contexts.delete(frameId);
    }
  });
  session.on("Runtime.bindingCalled", ({ name, payload, executionContextId }) => {
    if (name !== bindingName || !allowedContexts.has(executionContextId)) return;
    let value;
    try {
      value = JSON.parse(payload);
    } catch {
      return;
    }
    observe(value);
  });
  session.on("Page.frameAttached", ({ frameId }) => void install(frameId));
  session.on("Page.frameNavigated", ({ frame }) => {
    contexts.delete(frame.id);
    navigated(frame.parentId == null);
    void install(frame.id);
  });
  const initial = await session.send("Page.getFrameTree");
  for (const frame of flattenFrameTree(initial.frameTree)) await install(frame.id);
  return { session, contexts, allowedContexts, install };
}

async function inspectFrames(isolated, includeStructure = false) {
  const treeResult = await isolated.session.send("Page.getFrameTree");
  const frames = flattenFrameTree(treeResult.frameTree);
  const frameIds = new Set(frames.map((frame) => frame.id));
  for (const frame of frames) {
    if (!isolated.contexts.has(frame.id)) await isolated.install(frame.id);
  }
  const snapshots = [];
  for (const frame of frames) {
    const contextId = isolated.contexts.get(frame.id);
    if (!contextId || !isolated.allowedContexts.has(contextId) || !frameIds.has(frame.id)) {
      throw new RecorderError("unstable page document");
    }
    const evaluated = await isolated.session.send("Runtime.evaluate", {
      expression: isolatedSnapshotSource(includeStructure && frame.id === treeResult.frameTree.frame.id),
      contextId,
      returnByValue: true,
    });
    if (evaluated.exceptionDetails || !evaluated.result?.value) {
      throw new RecorderError("unstable page document");
    }
    snapshots.push({
      frame,
      value: { ...evaluated.result.value, url: frame.url },
    });
  }
  return {
    identity: frames.map((frame) => `${frame.id}:${frame.loaderId}`).sort().join("|"),
    snapshots,
    main: snapshots.find(({ frame }) => frame.id === treeResult.frameTree.frame.id)?.value,
  };
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

export async function commitCheckpoint({
  temporaryDirectory,
  checkpointDirectory,
  signal,
  isShuttingDown,
  updateLifecycle,
  renameDirectory,
  removeDirectory,
}) {
  if (typeof renameDirectory !== "function" || typeof removeDirectory !== "function") {
    throw new RecorderError("checkpoint commit unavailable");
  }
  let renamed = false;
  try {
    await renameDirectory(temporaryDirectory, checkpointDirectory);
    renamed = true;
    throwIfAborted(signal);
    if (isShuttingDown()) throw new RecorderError("operation canceled");
    updateLifecycle();
  } catch (error) {
    const cleanupTarget = renamed ? checkpointDirectory : temporaryDirectory;
    await removeDirectory(cleanupTarget).catch(() => {});
    throw error;
  }
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

async function readRequestBody(request, signal) {
  const read = (async () => {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      throwIfAborted(signal);
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
  })();
  const destroy = () => request.destroy();
  signal?.addEventListener("abort", destroy, { once: true });
  try {
    return await withDeadline(read, BODY_DEADLINE_MS, signal, destroy);
  } finally {
    signal?.removeEventListener("abort", destroy);
  }
}

async function runRecord(rawOptions) {
  const options = await validateRecorderOptions(rawOptions);
  let server;
  let broker;
  let controlPath;
  let activeToken = null;
  let captureEnabled = false;
  let shuttingDown = false;
  let checkpointQueue = Promise.resolve();
  let writeQueue = Promise.resolve();
  const activeControllers = new Set();
  const activeHandlers = new Set();
  let quiesce;
  try {
    broker = await BrokerClient.start(options.output);
    const browser = await chromium.connectOverCDP(options.cdpUrl);
    const pages = ordinaryPages(browser);
    if (pages.length !== 1) throw new RecorderError("ordinary page selection required");
    const page = pages[0];
    let eventCount = 0;
    let pageSequence = 1;
    const checkpointKinds = [];
    const observe = (observed) => {
      if (!captureEnabled || eventCount >= MAX_EVENTS || !observed ||
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
      writeQueue = writeQueue.then(() => broker.write(
        "append",
        "events.jsonl",
        `${JSON.stringify(event)}\n`,
      ));
    };
    const isolated = await createIsolatedRecorder(
      page.context(),
      page,
      observe,
      (mainFrame) => {
        if (mainFrame) pageSequence += 1;
      },
    );
    const initialInspection = await withDeadline(
      inspectFrames(isolated),
      CAPTURE_DEADLINE_MS,
    );
    if (initialInspection.snapshots.some(({ value }) => isSensitivePage(value))) {
      throw new RecorderError("sensitive page refused");
    }

    await broker.request("mkdir", { path: "checkpoints" });
    await broker.write("write-exclusive", "events.jsonl", "");
    captureEnabled = true;

    const writeCheckpoint = async (kind, requestSignal) => {
      const operationController = new AbortController();
      const cancelOperation = () => operationController.abort();
      requestSignal.addEventListener("abort", cancelOperation, { once: true });
      if (requestSignal.aborted) cancelOperation();
      const operationDeadline = setTimeout(
        cancelOperation,
        CHECKPOINT_OPERATION_DEADLINE_MS,
      );
      const signal = operationController.signal;
      let temporaryDirectory;
      try {
        throwIfAborted(signal);
        if (shuttingDown) throw new RecorderError("operation canceled");
        validateCheckpointKind(kind);
        if (!lifecycleAllows(checkpointKinds, kind)) {
          throw new RecorderError("invalid checkpoint lifecycle");
        }
        await withDeadline(writeQueue, BROKER_REQUEST_DEADLINE_MS, signal);
        throwIfAborted(signal);
        const inspection = await withDeadline(
          inspectFrames(isolated, true),
          CAPTURE_DEADLINE_MS,
          signal,
        );
        if (inspection.snapshots.some(({ value }) => isSensitivePage(value))) {
          throw new RecorderError("sensitive page refused");
        }
        if (!inspection.main || inspection.main.structuralOverflow ||
            inspection.snapshots.some(({ value }) => value.controlOverflow)) {
          throw new RecorderError("capture resource limit exceeded");
        }
        const controls = inspection.snapshots.flatMap(({ value }) => value.controls)
          .filter((control) => !["password", "hidden"].includes(control.type))
          .map(sanitizeObservedControl);
        const html = inspection.main.html;
        const budget = await broker.request("stat-budget");
        validateCaptureResources({
          controlCount: controls.length,
          htmlBytes: Buffer.byteLength(html),
          screenshotWidth: inspection.main.width,
          screenshotHeight: inspection.main.height,
          checkpointCount: checkpointKinds.length + 1,
          sessionBytes: budget.bytes,
        });
        const afterStructure = await withDeadline(
          inspectFrames(isolated),
          CAPTURE_DEADLINE_MS,
          signal,
        );
        if (afterStructure.identity !== inspection.identity ||
            afterStructure.snapshots.some(({ value }) => isSensitivePage(value))) {
          throw new RecorderError("unstable page document");
        }
        const sequence = checkpointKinds.length + 1;
        const checkpointName = `${String(sequence).padStart(4, "0")}-${kind}`;
        const checkpointDirectory = `checkpoints/${checkpointName}`;
        temporaryDirectory = `checkpoints/.tmp-${randomBytes(18).toString("base64url")}`;
        await broker.request("mkdir", { path: temporaryDirectory });
        const screenshot = await withDeadline(
          page.screenshot({ fullPage: true, timeout: CAPTURE_DEADLINE_MS }),
          CAPTURE_DEADLINE_MS,
          signal,
        );
        validateCaptureResources({
          screenshotWidth: inspection.main.width,
          screenshotHeight: inspection.main.height,
          screenshotBytes: screenshot.byteLength,
        });
        const afterScreenshot = await withDeadline(
          inspectFrames(isolated),
          CAPTURE_DEADLINE_MS,
          signal,
        );
        if (afterScreenshot.identity !== inspection.identity ||
            afterScreenshot.snapshots.some(({ value }) => isSensitivePage(value))) {
          throw new RecorderError("unstable page document");
        }
        throwIfAborted(signal);
        await Promise.all([
          broker.write("write-exclusive", `${temporaryDirectory}/page.html`, html),
          broker.write("write-exclusive", `${temporaryDirectory}/page.png`, screenshot),
          broker.writeJson("write-exclusive", `${temporaryDirectory}/controls.json`, controls),
          broker.writeJson("write-exclusive", `${temporaryDirectory}/checkpoint.json`, {
            kind,
            sequence,
            timestamp: new Date().toISOString(),
            pageSequence,
          }),
        ]);
        const beforeCommit = await withDeadline(
          inspectFrames(isolated),
          CAPTURE_DEADLINE_MS,
          signal,
        );
        if (beforeCommit.identity !== inspection.identity ||
            beforeCommit.snapshots.some(({ value }) => isSensitivePage(value))) {
          throw new RecorderError("unstable page document");
        }
        throwIfAborted(signal);
        if (shuttingDown) throw new RecorderError("operation canceled");
        await commitCheckpoint({
          temporaryDirectory,
          checkpointDirectory,
          signal,
          isShuttingDown: () => shuttingDown,
          renameDirectory: (source, destination) => broker.request(
            "rename-no-replace",
            { source, destination },
          ),
          removeDirectory: (target) => broker.request("remove-tree", { path: target }),
          updateLifecycle: () => {
            checkpointKinds.push(kind);
          },
        });
        temporaryDirectory = undefined;
      } catch (error) {
        if (temporaryDirectory) {
          await broker.request("remove-tree", { path: temporaryDirectory }).catch(() => {});
        }
        throw error;
      } finally {
        clearTimeout(operationDeadline);
        requestSignal.removeEventListener("abort", cancelOperation);
      }
    };

    const enqueueCheckpoint = (kind, signal) => {
      const operation = checkpointQueue.then(() => writeCheckpoint(kind, signal));
      checkpointQueue = operation.catch(() => {});
      return operation;
    };

    activeToken = randomBytes(32).toString("base64url");
    let stopRequested;
    const stopPromise = new Promise((resolve) => { stopRequested = resolve; });
    const brokerFailurePromise = new Promise((resolve) => {
      if (broker.child.exitCode !== null) resolve("broker-failed");
      broker.child.once("exit", () => resolve("broker-failed"));
      broker.child.once("error", () => resolve("broker-failed"));
    });
    const handleControlRequest = async (request, response) => {
      const reject = (status = 400) => {
        if (response.destroyed || response.writableEnded) return;
        response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        response.end('{"error":"request rejected"}\n');
      };
      const address = server.address();
      if (shuttingDown || !address) {
        request.resume();
        reject(503);
        return;
      }
      const port = address.port;
      if (request.method !== "POST" || !["/checkpoint", "/stop"].includes(request.url) ||
          !activeToken || !authorizedRequest(request, port, activeToken)) {
        request.resume();
        reject(403);
        return;
      }
      const controller = new AbortController();
      activeControllers.add(controller);
      const cancel = () => controller.abort();
      request.once("aborted", cancel);
      request.once("close", () => {
        if (!request.complete) cancel();
      });
      response.once("close", () => {
        if (!response.writableEnded) cancel();
      });
      try {
        const body = await readRequestBody(request, controller.signal);
        if (request.url === "/checkpoint") {
          if (Object.keys(body).length !== 1 || !Object.hasOwn(body, "kind")) {
            throw new RecorderError("invalid control request");
          }
          await enqueueCheckpoint(body.kind, controller.signal);
        } else {
          if (Object.keys(body).length !== 0) throw new RecorderError("invalid control request");
        }
        throwIfAborted(controller.signal);
        if (shuttingDown) throw new RecorderError("operation canceled");
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end('{"ok":true}\n');
        if (request.url === "/stop") setImmediate(stopRequested);
      } catch {
        reject(400);
      } finally {
        activeControllers.delete(controller);
      }
    };
    server = http.createServer((request, response) => {
      const handler = handleControlRequest(request, response).catch(() => {
        if (!response.destroyed && !response.writableEnded) {
          response.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
          response.end('{"error":"request rejected"}\n');
        }
      });
      activeHandlers.add(handler);
      handler.then(
        () => activeHandlers.delete(handler),
        () => activeHandlers.delete(handler),
      );
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    controlPath = path.join(options.output, "control.json");
    await broker.writeJson("write-exclusive", "control.json", { port, token: activeToken });

    let quiescePromise;
    quiesce = () => {
      if (quiescePromise) return quiescePromise;
      quiescePromise = (async () => {
        shuttingDown = true;
        captureEnabled = false;
        activeToken = null;
        if (controlPath) await broker.request("remove-tree", { path: "control.json" }).catch(() => {});
        const serverClosed = server?.listening
          ? new Promise((resolve) => server.close(resolve))
          : Promise.resolve();
        server?.closeIdleConnections?.();
        for (const controller of activeControllers) controller.abort();
        while (activeHandlers.size > 0) {
          await Promise.allSettled([...activeHandlers]);
        }
        await checkpointQueue;
        await writeQueue;
        await serverClosed;
      })();
      return quiescePromise;
    };

    const signalPromise = new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    const stopReason = await Promise.race([signalPromise, stopPromise, brokerFailurePromise]);
    if (stopReason === "broker-failed") {
      throw new RecorderError("filesystem broker unavailable");
    }
    await quiesce();
    await broker.writeJson("write-exclusive", "recording-summary.json", {
      checkpointKinds,
    });
    const receipt = {
      recorderVersion: "1.0.0",
      captureMonth: new Date().toISOString().slice(0, 7),
      captureId: randomBytes(18).toString("base64url"),
      sourceFiles: await broker.request("hash-source-files"),
    };
    await broker.writeJson("write-exclusive", "capture-receipt.json", receipt);
  } finally {
    shuttingDown = true;
    captureEnabled = false;
    activeToken = null;
    if (controlPath && broker) {
      await broker.request("remove-tree", { path: "control.json" }).catch(() => {});
    }
    for (const controller of activeControllers) controller.abort();
    if (quiesce) await quiesce().catch(() => {});
    else if (server?.listening) await new Promise((resolve) => server.close(resolve)).catch(() => {});
    await broker?.close().catch(() => {});
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
  const timer = setTimeout(() => controller.abort(), CLIENT_DEADLINE_MS);
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
  main().then(
    () => process.exit(0),
    (error) => {
      const message = `${error instanceof RecorderError ? error.message : "recorder failed"}\n`;
      process.stderr.write(message, () => process.exit(1));
    },
  );
}
