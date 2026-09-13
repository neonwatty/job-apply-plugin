import { randomBytes } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { throwIfAborted, withDeadline } from "./broker-client.mjs";
import {
  CAPTURE_DEADLINE_MS,
  captureFullPagePng,
  inspectFrames,
} from "./capture.mjs";
import { RecorderError } from "./errors.mjs";
import {
  sanitizeObservedControl,
  validateCaptureResources,
  validateCheckpointKind,
  validateSafetyRevision,
} from "./resources.mjs";

export const CHECKPOINT_OPERATION_DEADLINE_MS = 15_000;
const MAX_PENDING_CHECKPOINTS = 2;
const CLIENT_DEADLINE_MS =
  CHECKPOINT_OPERATION_DEADLINE_MS * MAX_PENDING_CHECKPOINTS + 2_000;

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

export function createCheckpointWriter({
  broker,
  isolated,
  checkpointKinds,
  getSafetyRevision,
  getPageSequence,
  hasSensitivePage,
  waitForWrites,
  isShuttingDown,
}) {
  return async (kind, requestSignal) => {
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
      await withDeadline(waitForWrites(), CHECKPOINT_OPERATION_DEADLINE_MS, signal);
      throwIfAborted(signal);
      if (isShuttingDown()) throw new RecorderError("operation canceled");
      validateCheckpointKind(kind);
      if (!lifecycleAllows(checkpointKinds, kind)) {
        throw new RecorderError("invalid checkpoint lifecycle");
      }
      throwIfAborted(signal);
      const captureRevision = getSafetyRevision();
      const assertCaptureRevision = () =>
        validateSafetyRevision(captureRevision, getSafetyRevision());
      const inspection = await withDeadline(
        inspectFrames(isolated, true),
        CAPTURE_DEADLINE_MS,
        signal,
      );
      assertCaptureRevision();
      if (hasSensitivePage(inspection.snapshots)) {
        throw new RecorderError("sensitive page refused");
      }
      if (!inspection.main || inspection.main.structuralOverflow ||
          inspection.snapshots.some(({ value }) => value.controlOverflow)) {
        throw new RecorderError("capture resource limit exceeded");
      }
      const controls = inspection.snapshots.flatMap(({ value, frameVisible }) =>
        frameVisible ? value.controls : [])
        .filter((control) => !["password", "hidden"].includes(control.type))
        .map(sanitizeObservedControl);
      const html = inspection.main.html;
      const budget = await broker.request("stat-budget");
      assertCaptureRevision();
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
      assertCaptureRevision();
      if (afterStructure.identity !== inspection.identity ||
          hasSensitivePage(afterStructure.snapshots)) {
        throw new RecorderError("unstable page document");
      }
      const sequence = checkpointKinds.length + 1;
      const checkpointName = `${String(sequence).padStart(4, "0")}-${kind}`;
      const checkpointDirectory = `checkpoints/${checkpointName}`;
      temporaryDirectory = `checkpoints/.tmp-${randomBytes(18).toString("base64url")}`;
      await broker.request("mkdir", { path: temporaryDirectory });
      assertCaptureRevision();
      const screenshot = await captureFullPagePng(
        isolated,
        inspection.main.width,
        inspection.main.height,
        signal,
        async () => {
          assertCaptureRevision();
          const restored = await withDeadline(
            inspectFrames(isolated),
            CAPTURE_DEADLINE_MS,
            signal,
          );
          assertCaptureRevision();
          if (restored.identity !== inspection.identity ||
              hasSensitivePage(restored.snapshots)) {
            throw new RecorderError("unstable page document");
          }
        },
      );
      assertCaptureRevision();
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
      assertCaptureRevision();
      if (afterScreenshot.identity !== inspection.identity ||
          hasSensitivePage(afterScreenshot.snapshots)) {
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
          pageSequence: getPageSequence(),
        }),
      ]);
      assertCaptureRevision();
      const beforeCommit = await withDeadline(
        inspectFrames(isolated),
        CAPTURE_DEADLINE_MS,
        signal,
      );
      assertCaptureRevision();
      if (beforeCommit.identity !== inspection.identity ||
          hasSensitivePage(beforeCommit.snapshots)) {
        throw new RecorderError("unstable page document");
      }
      throwIfAborted(signal);
      if (isShuttingDown()) throw new RecorderError("operation canceled");
      await commitCheckpoint({
        temporaryDirectory,
        checkpointDirectory,
        signal,
        isShuttingDown,
        renameDirectory: (source, destination) => broker.request(
          "rename-no-replace",
          { source, destination },
        ),
        removeDirectory: (target) => broker.request("remove-tree", { path: target }),
        updateLifecycle: () => {
          assertCaptureRevision();
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

export async function runCheckpoint(rawSession, rawKind) {
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
