import { randomBytes } from "node:crypto";

import { withDeadline } from "./broker-client.mjs";
import { RecorderError } from "./errors.mjs";
import { isolatedInstallerSource, isolatedSnapshotSource } from "./isolated-source.mjs";
import { decodeCapturedPng } from "./png.mjs";
import { validateCaptureResources } from "./resources.mjs";
import {
  hasCaptchaSecurityFrameOwner,
  isSensitivePage,
} from "./safety/common.mjs";
import { isAshbyPassiveRecaptchaInspection } from "./safety/ashby.mjs";
import {
  isGreenhousePassiveRecaptchaMain,
  isPassiveGreenhouseRecaptchaFrame,
} from "./safety/greenhouse.mjs";
import { isLeverPassiveHcaptchaInspection } from "./safety/lever.mjs";
import {
  isDormantLinkedInCaptcha,
  isLinkedInJobsUrl,
} from "./safety/linkedin.mjs";
import { isExactWorkdayOptionalSignInInspection } from "./safety/workday.mjs";

export const CAPTURE_DEADLINE_MS = 1000;
const SCREENSHOT_DEADLINE_MS = 5000;
const MAX_CAPTURE_DEVICE_PIXEL_RATIO = 4;

export function inspectionHasSensitivePage(snapshots, boundWorkdayUrl) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) return true;
  const main = snapshots.find(({ frame }) => frame && !frame.parentId);
  const linkedInJobsPage = main && isLinkedInJobsUrl(main.value?.url) &&
    !isSensitivePage(main.value);
  const greenhousePassiveRecaptcha = main && isGreenhousePassiveRecaptchaMain(main);
  const ashbyPassiveRecaptcha = main &&
    isAshbyPassiveRecaptchaInspection(snapshots, main);
  const leverPassiveHcaptcha = main &&
    isLeverPassiveHcaptchaInspection(snapshots, main);
  const workdayOptionalSignIn = main &&
    isExactWorkdayOptionalSignInInspection(snapshots, main, boundWorkdayUrl);
  if (main && hasCaptchaSecurityFrameOwner(main.value) && !leverPassiveHcaptcha) {
    return true;
  }
  return snapshots.some((snapshot) => {
    if (!isSensitivePage(snapshot.value)) return false;
    if (leverPassiveHcaptcha) return false;
    if (workdayOptionalSignIn && snapshot === main) return false;
    if (ashbyPassiveRecaptcha && snapshot === main) return false;
    if (greenhousePassiveRecaptcha &&
        (snapshot === main || isPassiveGreenhouseRecaptchaFrame(snapshot, main))) {
      return false;
    }
    return !(linkedInJobsPage && snapshot !== main &&
      isDormantLinkedInCaptcha(snapshot));
  });
}

function flattenFrameTree(tree, frames = []) {
  frames.push({
    id: tree.frame.id,
    parentId: tree.frame.parentId,
    loaderId: tree.frame.loaderId,
    url: tree.frame.url,
  });
  for (const child of tree.childFrames ?? []) flattenFrameTree(child, frames);
  return frames;
}

export async function createIsolatedRecorder(context, page, observe, navigated) {
  const session = await context.newCDPSession(page);
  const worldName = `qa-recorder-${randomBytes(18).toString("base64url")}`;
  const bindingName = `__qa_${randomBytes(18).toString("hex")}`;
  const contexts = new Map();
  const allowedContexts = new Set();
  const installer = isolatedInstallerSource(bindingName);
  await session.send("Page.enable");
  await session.send("DOM.enable");
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
    navigated(false);
  });
  session.on("Runtime.executionContextsCleared", () => {
    contexts.clear();
    allowedContexts.clear();
    navigated(false);
  });
  session.on("Runtime.bindingCalled", ({ name, payload, executionContextId }) => {
    if (name !== bindingName || !allowedContexts.has(executionContextId)) return;
    let value;
    try {
      value = JSON.parse(payload);
    } catch {
      return;
    }
    observe(value, executionContextId);
  });
  session.on("Page.frameAttached", ({ frameId }) => {
    navigated(false);
    void install(frameId);
  });
  session.on("Page.frameDetached", ({ frameId }) => {
    const contextId = contexts.get(frameId);
    if (contextId) allowedContexts.delete(contextId);
    contexts.delete(frameId);
    navigated(false);
  });
  session.on("Page.frameStartedLoading", () => navigated(false));
  session.on("Page.frameStoppedLoading", () => navigated(false));
  session.on("Page.frameNavigated", ({ frame }) => {
    const oldContext = contexts.get(frame.id);
    if (oldContext) allowedContexts.delete(oldContext);
    contexts.delete(frame.id);
    navigated(frame.parentId == null);
    void install(frame.id);
  });
  const initial = await session.send("Page.getFrameTree");
  for (const frame of flattenFrameTree(initial.frameTree)) await install(frame.id);
  return { session, contexts, allowedContexts, install };
}

export async function inspectFrames(isolated, includeStructure = false) {
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
    let frameVisible = true;
    if (frame.parentId) {
      const parentContextId = isolated.contexts.get(frame.parentId);
      if (!parentContextId || !isolated.allowedContexts.has(parentContextId)) {
        throw new RecorderError("unstable page document");
      }
      try {
        const owner = await isolated.session.send("DOM.getFrameOwner", { frameId: frame.id });
        const resolved = await isolated.session.send("DOM.resolveNode", {
          backendNodeId: owner.backendNodeId,
          executionContextId: parentContextId,
        });
        const checked = await isolated.session.send("Runtime.callFunctionOn", {
          objectId: resolved.object.objectId,
          returnByValue: true,
          functionDeclaration: `function () {
            for (let current = this; current instanceof Element; current = current.parentElement) {
              if (current.matches("[hidden],[aria-hidden=true]")) return false;
              const style = getComputedStyle(current);
              if (style.display === "none" || style.visibility === "hidden" ||
                  style.visibility === "collapse" || Number.parseFloat(style.opacity) === 0 ||
                  style.contentVisibility === "hidden") return false;
            }
            const rectangle = this.getBoundingClientRect();
            if (rectangle.width <= 0 || rectangle.height <= 0) return false;
            const elementStyle = getComputedStyle(this);
            if (elementStyle.position === "fixed") {
              return rectangle.bottom > 0 && rectangle.right > 0 &&
                rectangle.top < innerHeight && rectangle.left < innerWidth;
            }
            return rectangle.right + scrollX > 0 && rectangle.bottom + scrollY > 0;
          }`,
        });
        frameVisible = checked.result?.value === true;
        await isolated.session.send("Runtime.releaseObject", {
          objectId: resolved.object.objectId,
        }).catch(() => {});
      } catch {
        frameVisible = false;
      }
      const parentSnapshot = snapshots.find(({ frame: candidate }) =>
        candidate.id === frame.parentId);
      frameVisible = frameVisible && parentSnapshot?.frameVisible === true;
    }
    snapshots.push({
      frame,
      frameVisible,
      value: { ...evaluated.result.value, url: frame.url },
    });
  }
  return {
    identity: snapshots.map(({ frame, frameVisible }) =>
      `${frame.id}:${frame.loaderId}:${frameVisible ? 1 : 0}`).sort().join("|"),
    snapshots,
    main: snapshots.find(({ frame }) => frame.id === treeResult.frameTree.frame.id)?.value,
  };
}

async function readTrustedCaptureState(isolated, signal) {
  const treeResult = await withDeadline(
    isolated.session.send("Page.getFrameTree"),
    CAPTURE_DEADLINE_MS,
    signal,
  );
  const frame = treeResult?.frameTree?.frame;
  const contextId = frame?.id && isolated.contexts?.get(frame.id);
  if (typeof frame?.id !== "string" || frame.id.length === 0 ||
      typeof frame.loaderId !== "string" || frame.loaderId.length === 0 ||
      frame.parentId != null || !Number.isSafeInteger(contextId) || contextId <= 0 ||
      !isolated.allowedContexts?.has(contextId)) {
    throw new RecorderError("invalid screenshot capture");
  }
  const evaluated = await withDeadline(
    isolated.session.send("Runtime.evaluate", {
      expression: "globalThis.devicePixelRatio",
      contextId,
      returnByValue: true,
    }),
    CAPTURE_DEADLINE_MS,
    signal,
  );
  const devicePixelRatio = evaluated?.result?.value;
  if (evaluated?.exceptionDetails || evaluated?.result?.type !== "number" ||
      !Number.isFinite(devicePixelRatio) || devicePixelRatio < 1 ||
      devicePixelRatio > MAX_CAPTURE_DEVICE_PIXEL_RATIO) {
    throw new RecorderError("invalid screenshot capture");
  }
  return { frameId: frame.id, loaderId: frame.loaderId, contextId, devicePixelRatio };
}

async function setCaptureScriptExecution(isolated, disabled, signal) {
  await withDeadline(
    isolated.session.send("Emulation.setScriptExecutionDisabled", { value: disabled }),
    CAPTURE_DEADLINE_MS,
    signal,
  );
}

async function restoreCaptureScriptExecution(isolated) {
  let failed = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await setCaptureScriptExecution(isolated, false);
      return failed;
    } catch {
      failed = true;
    }
  }
  // Detaching clears the session-scoped Emulation override when restoration is uncertain.
  isolated.contexts?.clear();
  isolated.allowedContexts?.clear();
  await isolated.session.detach?.().catch(() => {});
  return true;
}

async function waitForRestoredScriptTurn(isolated, captureState, signal) {
  const evaluated = await withDeadline(
    isolated.session.send("Runtime.evaluate", {
      expression: "new Promise((resolve) => setTimeout(resolve, 0))",
      contextId: captureState.contextId,
      awaitPromise: true,
      returnByValue: true,
    }),
    CAPTURE_DEADLINE_MS,
    signal,
  );
  if (evaluated?.exceptionDetails) throw new RecorderError("unstable page document");
}

export async function captureFullPagePng(
  isolated,
  width,
  height,
  signal,
  verifyRestoredPage,
) {
  if (!Number.isSafeInteger(width) || width <= 0 ||
      !Number.isSafeInteger(height) || height <= 0) {
    throw new RecorderError("invalid screenshot capture");
  }
  const captureState = await readTrustedCaptureState(isolated, signal);
  const metrics = await withDeadline(
    isolated.session.send("Page.getLayoutMetrics"),
    CAPTURE_DEADLINE_MS,
    signal,
  );
  const content = metrics?.cssContentSize;
  if (!content || content.x !== 0 || Object.is(content.x, -0) ||
      content.y !== 0 || Object.is(content.y, -0) ||
      !Number.isFinite(content.width) || content.width <= 0 ||
      !Number.isFinite(content.height) || content.height <= 0) {
    throw new RecorderError("invalid screenshot capture");
  }
  const cdpWidth = Math.ceil(content.x + content.width);
  const cdpHeight = Math.ceil(content.y + content.height);
  if (!Number.isSafeInteger(cdpWidth) || cdpWidth <= 0 ||
      !Number.isSafeInteger(cdpHeight) || cdpHeight <= 0) {
    throw new RecorderError("invalid screenshot capture");
  }
  const captureWidth = Math.max(width, cdpWidth);
  const captureHeight = Math.max(height, cdpHeight);
  validateCaptureResources({
    screenshotWidth: captureWidth,
    screenshotHeight: captureHeight,
  });
  const scale = 1 / captureState.devicePixelRatio;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1) {
    throw new RecorderError("invalid screenshot capture");
  }
  let result;
  let captureError;
  let restorationFailed = false;
  try {
    await setCaptureScriptExecution(isolated, true, signal);
    result = await withDeadline(
      isolated.session.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: captureWidth, height: captureHeight, scale },
      }),
      SCREENSHOT_DEADLINE_MS,
      signal,
    );
  } catch (error) {
    captureError = error;
  } finally {
    restorationFailed = await restoreCaptureScriptExecution(isolated);
  }
  if (restorationFailed) throw new RecorderError("invalid screenshot capture");
  if (captureError) throw captureError;
  if (!result || Object.keys(result).length !== 1 ||
      !Object.hasOwn(result, "data")) {
    throw new RecorderError("invalid screenshot capture");
  }
  await waitForRestoredScriptTurn(isolated, captureState, signal);
  const afterMetrics = await withDeadline(
    isolated.session.send("Page.getLayoutMetrics"),
    CAPTURE_DEADLINE_MS,
    signal,
  );
  const afterContent = afterMetrics?.cssContentSize;
  if (!afterContent || afterContent.x !== content.x || afterContent.y !== content.y ||
      afterContent.width !== content.width || afterContent.height !== content.height) {
    throw new RecorderError("unstable page document");
  }
  const afterCaptureState = await readTrustedCaptureState(isolated, signal);
  if (afterCaptureState.frameId !== captureState.frameId ||
      afterCaptureState.loaderId !== captureState.loaderId ||
      afterCaptureState.contextId !== captureState.contextId ||
      afterCaptureState.devicePixelRatio !== captureState.devicePixelRatio) {
    throw new RecorderError("unstable page document");
  }
  if (verifyRestoredPage !== undefined) {
    if (typeof verifyRestoredPage !== "function") {
      throw new RecorderError("invalid screenshot capture");
    }
    await verifyRestoredPage();
  }
  return decodeCapturedPng(result.data, captureWidth, captureHeight);
}
