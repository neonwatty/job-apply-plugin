import { lstat, readdir, realpath } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { RecorderError } from "./errors.mjs";

export const CHECKPOINT_KINDS = Object.freeze([
  "application-opened",
  "step-advanced",
  "validation-observed",
  "review-reached",
  "final-action-boundary",
]);

const CHECKPOINT_KIND_SET = new Set(CHECKPOINT_KINDS);

export const CAPTURE_LIMITS = Object.freeze({
  maxControls: 1_000,
  maxHtmlBytes: 1_048_576,
  maxScreenshotWidth: 4_096,
  maxScreenshotHeight: 16_384,
  maxScreenshotBytes: 8_388_608,
  maxCheckpoints: 100,
  maxSessionBytes: 67_108_864,
});

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

export function validateSafetyRevision(expected, current) {
  if (!Number.isSafeInteger(expected) || expected !== current) {
    throw new RecorderError("unstable page document");
  }
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
