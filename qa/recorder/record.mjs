import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";

import {
  BrokerClient,
  throwIfAborted,
  withDeadline,
} from "./broker-client.mjs";
import {
  CAPTURE_DEADLINE_MS,
  createIsolatedRecorder,
  inspectFrames,
  inspectionHasSensitivePage,
} from "./capture.mjs";
import { createCheckpointWriter } from "./checkpoint.mjs";
import { RecorderError } from "./errors.mjs";
import { createEventBudget } from "./event-budget.mjs";
import {
  sanitizeObservedControl,
  validateRecorderOptions,
} from "./resources.mjs";
import { isExactWorkdayOptionalSignInInspection } from "./safety/workday.mjs";

const MAX_CONTROL_BODY = 4096;
const MAX_PENDING_CHECKPOINTS = 2;
const MAX_EVENT_LINE_BYTES = 1024;
const BODY_DEADLINE_MS = 500;

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

export async function runRecord(rawOptions) {
  const options = await validateRecorderOptions(rawOptions);
  let server;
  let broker;
  let controlPath;
  let activeToken = null;
  let captureEnabled = false;
  let shuttingDown = false;
  let checkpointQueue = Promise.resolve();
  let writeQueue = Promise.resolve();
  let eventSafetyQueue = Promise.resolve();
  const eventBudget = createEventBudget();
  const eventSafetyController = new AbortController();
  const activeControllers = new Set();
  const activeHandlers = new Set();
  let pendingCheckpointRequests = 0;
  let quiesce;
  try {
    broker = await BrokerClient.start(options.output);
    const browser = await chromium.connectOverCDP(options.cdpUrl);
    const pages = ordinaryPages(browser);
    if (pages.length !== 1) throw new RecorderError("ordinary page selection required");
    const page = pages[0];
    let pageSequence = 1;
    const checkpointKinds = [];
    const observe = (observed) => {
      if (!captureEnabled || eventBudget.atEventLimit() || !observed ||
          !["click", "change", "input"].includes(observed.interactionType)) return;
      const control = sanitizeObservedControl(observed);
      if (!control.sourceLabel || control.role === "unknown") return;
      const event = {
        timestamp: new Date().toISOString(),
        pageSequence,
        interactionType: observed.interactionType,
        ...control,
      };
      const line = `${JSON.stringify(event)}\n`;
      if (Buffer.byteLength(line) > MAX_EVENT_LINE_BYTES) return;
      eventBudget.beginWrite();
      const write = writeQueue.then(() => broker.write(
        "append",
        "events.jsonl",
        line,
      )).finally(() => { eventBudget.endWrite(); });
      writeQueue = write.catch(() => { broker._failClosed(); });
    };
    let isolated;
    let safetyRevision = 0;
    let boundWorkdayUrl;
    const hasSensitivePage = (snapshots) =>
      inspectionHasSensitivePage(snapshots, boundWorkdayUrl);
    const safelyObserve = (observed, executionContextId) => {
      if (observed?.messageType === "document-state") {
        safetyRevision += 1;
        return;
      }
      if (observed?.messageType !== "interaction") return;
      if (!captureEnabled || shuttingDown) return;
      if (!eventBudget.reserveInspection()) return;
      const observedRevision = safetyRevision;
      eventSafetyQueue = eventSafetyQueue.then(async () => {
        try {
          if (!captureEnabled || shuttingDown) return;
          const frameId = [...isolated.contexts].find(([, contextId]) =>
            contextId === executionContextId)?.[0];
          if (!frameId) return;
          const inspection = await withDeadline(
            inspectFrames(isolated),
            CAPTURE_DEADLINE_MS,
            eventSafetyController.signal,
          );
          const sourceFrame = inspection.snapshots.find(({ frame }) => frame.id === frameId);
          if (!captureEnabled || shuttingDown || safetyRevision !== observedRevision ||
              isolated.contexts.get(frameId) !== executionContextId ||
              sourceFrame?.frameVisible !== true ||
              hasSensitivePage(inspection.snapshots)) return;
          observe(observed);
        } finally {
          eventBudget.releaseInspection();
        }
      }).catch(() => {});
    };
    isolated = await createIsolatedRecorder(
      page.context(),
      page,
      safelyObserve,
      (mainFrame) => {
        safetyRevision += 1;
        if (mainFrame) pageSequence += 1;
      },
    );
    const initialInspection = await withDeadline(
      inspectFrames(isolated),
      CAPTURE_DEADLINE_MS,
    );
    if (hasSensitivePage(initialInspection.snapshots)) {
      throw new RecorderError("sensitive page refused");
    }
    const initialMain = initialInspection.snapshots.find(({ frame }) =>
      frame && !frame.parentId);
    if (initialMain && isExactWorkdayOptionalSignInInspection(
      initialInspection.snapshots,
      initialMain,
      undefined,
    )) {
      boundWorkdayUrl = initialMain.value.url;
    }

    await broker.request("mkdir", { path: "checkpoints" });
    await broker.write("write-exclusive", "events.jsonl", "");
    captureEnabled = true;

    const writeCheckpoint = createCheckpointWriter({
      broker,
      isolated,
      checkpointKinds,
      getSafetyRevision: () => safetyRevision,
      getPageSequence: () => pageSequence,
      hasSensitivePage,
      waitForWrites: () => writeQueue,
      isShuttingDown: () => shuttingDown,
    });
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
          if (pendingCheckpointRequests >= MAX_PENDING_CHECKPOINTS) {
            throw new RecorderError("checkpoint queue full");
          }
          pendingCheckpointRequests += 1;
          try {
            await enqueueCheckpoint(body.kind, controller.signal);
          } finally {
            pendingCheckpointRequests -= 1;
          }
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
    const signalPromise = new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    controlPath = path.join(options.output, "control.json");
    await broker.writeJson("write-exclusive", "control.json", { port, token: activeToken });

    let quiescePromise;
    quiesce = () => {
      if (quiescePromise) return quiescePromise;
      quiescePromise = (async () => {
        shuttingDown = true;
        captureEnabled = false;
        eventSafetyController.abort();
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
        await eventSafetyQueue;
        await writeQueue;
        await serverClosed;
      })();
      return quiescePromise;
    };

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
