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
const SENSITIVE_PATTERN = /(?:\blog[ -]?in\b|\bsign[ -]?in\b|password|passcode|captcha|not a robot|multi[ -]?factor|\bmfa\b|two[ -]?factor|\b2fa\b|2[ -]?step verification|verification code|security code|sms code|recovery code|authenticator app|push notification|verify (?:your )?identity|\b\d{1,2}[ -]?digit code(?: we sent)?|approve (?:this |the )?(?:device|sign[ -]?in)|create (?:an? )?account|account[ -]?creation|register|\botp\b|authentication|security[ -]?key|one[ -]?time[ -]?code)/i;
const MAX_CONTROL_BODY = 4096;
const MAX_EVENTS = 10_000;
const MAX_PENDING_EVENT_OPERATIONS = 8;
const MAX_PENDING_CHECKPOINTS = 2;
const MAX_EVENT_LINE_BYTES = 1024;
const BODY_DEADLINE_MS = 500;
const CAPTURE_DEADLINE_MS = 1000;
const SCREENSHOT_DEADLINE_MS = 5000;
const MAX_CAPTURE_DEVICE_PIXEL_RATIO = 4;
const BROKER_REQUEST_DEADLINE_MS = 1000;
const BROKER_EOF_GRACE_MS = 250;
const BROKER_TERMINATE_GRACE_MS = 1500;
const CHECKPOINT_OPERATION_DEADLINE_MS = 15_000;
const CLIENT_DEADLINE_MS =
  CHECKPOINT_OPERATION_DEADLINE_MS * MAX_PENDING_CHECKPOINTS + 2_000;
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

function pngCrc32(buffer, start, end) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function base64Value(code) {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 97 + 26;
  if (code >= 48 && code <= 57) return code - 48 + 52;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}

function isCanonicalBase64(data) {
  if (data.length === 0 || data.length % 4 !== 0) return false;
  let padding = 0;
  if (data.charCodeAt(data.length - 1) === 61) padding += 1;
  if (data.charCodeAt(data.length - 2) === 61) padding += 1;
  const contentLength = data.length - padding;
  if (contentLength === 0 || contentLength % 4 !== (4 - padding) % 4) return false;
  for (let index = 0; index < contentLength; index += 1) {
    if (base64Value(data.charCodeAt(index)) < 0) return false;
  }
  for (let index = contentLength; index < data.length; index += 1) {
    if (data.charCodeAt(index) !== 61) return false;
  }
  const finalValue = base64Value(data.charCodeAt(contentLength - 1));
  if ((padding === 1 && (finalValue & 0x03) !== 0) ||
      (padding === 2 && (finalValue & 0x0f) !== 0)) return false;
  return true;
}

export function decodeCapturedPng(data, expectedWidth, expectedHeight, maxBytes) {
  const byteLimit = maxBytes ?? CAPTURE_LIMITS.maxScreenshotBytes;
  const fail = () => { throw new RecorderError("invalid screenshot capture"); };
  if (typeof data !== "string" || data.length === 0 ||
      !Number.isSafeInteger(expectedWidth) || expectedWidth <= 0 ||
      !Number.isSafeInteger(expectedHeight) || expectedHeight <= 0 ||
      !Number.isSafeInteger(byteLimit) || byteLimit <= 0 ||
      data.length > Math.ceil(byteLimit / 3) * 4 ||
      !isCanonicalBase64(data)) {
    fail();
  }
  const png = Buffer.from(data, "base64");
  if (png.length > byteLimit || png.toString("base64") !== data || png.length < 45 ||
      !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    fail();
  }
  let offset = 8;
  let sawHeader = false;
  let sawEnd = false;
  while (offset < png.length) {
    if (png.length - offset < 12) fail();
    const length = png.readUInt32BE(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (length > byteLimit || dataEnd < dataStart || chunkEnd > png.length) fail();
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) ||
        pngCrc32(png, offset + 4, dataEnd) !== png.readUInt32BE(dataEnd)) {
      fail();
    }
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13 ||
          png.readUInt32BE(dataStart) !== expectedWidth ||
          png.readUInt32BE(dataStart + 4) !== expectedHeight) fail();
      sawHeader = true;
    } else if (type === "IHDR") {
      fail();
    }
    if (type === "IEND") {
      if (length !== 0 || chunkEnd !== png.length) fail();
      sawEnd = true;
    }
    offset = chunkEnd;
  }
  if (!sawHeader || !sawEnd || offset !== png.length) fail();
  return png;
}

export function validateSafetyRevision(expected, current) {
  if (!Number.isSafeInteger(expected) || expected !== current) {
    throw new RecorderError("unstable page document");
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
  const controls = [
    ...(Array.isArray(snapshot?.controls) ? snapshot.controls : []),
    ...(Array.isArray(snapshot?.securityControls) ? snapshot.securityControls : []),
  ];
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

function isLinkedInJobsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" &&
      url.port === "" && ["linkedin.com", "www.linkedin.com"].includes(url.hostname) &&
      (url.pathname === "/jobs" || url.pathname.startsWith("/jobs/"));
  } catch {
    return false;
  }
}

const PASSIVE_RECAPTCHA_DISCLOSURE = /this\s+site\s+is\s+protected\s+by\s+recaptcha\s+and\s+the\s+google\s+privacy\s+policy\s+and\s+terms\s+of\s+service\s+apply\.?/gi;

function isGreenhouseApplicationUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" &&
      url.port === "" && [
        "boards.greenhouse.io",
        "boards.eu.greenhouse.io",
        "job-boards.greenhouse.io",
      ].includes(url.hostname) && /\/jobs\/\d+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function isPassiveRecaptchaResponseControl(control) {
  return control?.type === "textarea" && control?.role === "textbox" &&
    control?.label === "g-recaptcha-response" &&
    (control?.autocomplete === "" || control?.autocomplete == null);
}

function isGreenhousePassiveRecaptchaMain(snapshot) {
  const value = snapshot?.value;
  if (!value || !isGreenhouseApplicationUrl(value.url)) return false;
  const text = typeof value.text === "string" ? value.text : "";
  const controls = Array.isArray(value.controls) ? value.controls : [];
  const securityControls = Array.isArray(value.securityControls)
    ? value.securityControls
    : [];
  PASSIVE_RECAPTCHA_DISCLOSURE.lastIndex = 0;
  const hasDisclosure = PASSIVE_RECAPTCHA_DISCLOSURE.test(text);
  const hasHiddenResponse = securityControls.some(isPassiveRecaptchaResponseControl) &&
    !controls.some(isPassiveRecaptchaResponseControl);
  if (!hasDisclosure && !hasHiddenResponse) return false;
  PASSIVE_RECAPTCHA_DISCLOSURE.lastIndex = 0;
  return !isSensitivePage({
    ...value,
    text: text.replace(PASSIVE_RECAPTCHA_DISCLOSURE, ""),
    securityControls: securityControls.filter((control) =>
      !isPassiveRecaptchaResponseControl(control)),
  });
}

function isPassiveGreenhouseRecaptchaFrame(snapshot, main) {
  const value = snapshot?.value;
  if (!value || !snapshot.frame?.parentId || snapshot.frame.parentId !== main?.frame?.id) {
    return false;
  }
  let url;
  try {
    url = new URL(typeof value.url === "string" ? value.url : "");
  } catch {
    return false;
  }
  const controls = [
    ...(Array.isArray(value.controls) ? value.controls : []),
    ...(Array.isArray(value.securityControls) ? value.securityControls : []),
  ];
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const text = typeof value.text === "string" ? value.text.trim() : "";
  return url.protocol === "https:" && url.username === "" && url.password === "" &&
    url.port === "" && ["www.google.com", "www.recaptcha.net"].includes(url.hostname) &&
    url.pathname === "/recaptcha/api2/anchor" && title === "reCAPTCHA" &&
    /^(?:Privacy\s*[-|]\s*Terms)?$/.test(text) && controls.length === 0;
}

function isAshbyApplicationUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" &&
      url.port === "" && url.hostname === "jobs.ashbyhq.com" &&
      url.search === "" && url.hash === "" &&
      /^\/[A-Za-z0-9_-]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/application\/?$/i
        .test(url.pathname);
  } catch {
    return false;
  }
}

function isLeverApplicationUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" &&
      url.port === "" && url.hostname === "jobs.lever.co" &&
      url.search === "" && url.hash === "" &&
      /^\/[A-Za-z0-9_-]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/apply\/?$/i
        .test(url.pathname);
  } catch {
    return false;
  }
}

function isWorkdayOptionalSignInUrl(value) {
  try {
    const url = new URL(value);
    const host =
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(wd1|wd5)\.myworkdayjobs\.com$/
        .exec(url.hostname);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
        url.port !== "" || !host || url.search !== "" || url.hash !== "") {
      return false;
    }
    const boundedToken = "[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?";
    const boundedSlug = "[A-Za-z0-9](?:[A-Za-z0-9_-]{0,126}[A-Za-z0-9])?";
    const wd5Path = new RegExp(
      `^/en-US/${boundedToken}/job/${boundedSlug}_JR-\\d{1,18}/?$`,
    );
    const wd1Path = new RegExp(
      `^/en-US/${boundedToken}/job/${boundedToken}/${boundedSlug}_JR\\d{1,18}-\\d{1,18}/?$`,
    );
    return host[1] === "wd5" ? wd5Path.test(url.pathname) : wd1Path.test(url.pathname);
  } catch {
    return false;
  }
}

const WORKDAY_CHOICE_MARKERS = Object.freeze([
  "Start Your Application",
  "Autofill with Resume",
  "Apply Manually",
  "Use My Last Application",
]);
const WORKDAY_MAX_VISIBLE_CONTROLS = 32;
const WORKDAY_MAX_SECURITY_CONTROLS = 48;
const WORKDAY_CONTROL_SHAPES = new Set([
  "button:button",
  "svg:presentation",
  "span:alert",
  "a:button",
  "div:button",
  "div:search",
  "nav:menu",
  "text:textbox",
  "email:textbox",
  "section:dialog",
]);

function isExactWorkdaySignIn(control) {
  return control?.type === "button" && control?.role === "button" &&
    control?.autocomplete === "" && control?.label === "Sign In" &&
    control?.required === false;
}

function hasBoundedWorkdayControls(controls, maximum) {
  return Array.isArray(controls) && controls.length >= 2 && controls.length <= maximum &&
    controls.filter(isExactWorkdaySignIn).length === 1 && controls.every((control) =>
      control?.autocomplete === "" && control?.required === false &&
      WORKDAY_CONTROL_SHAPES.has(`${control?.type ?? ""}:${control?.role ?? ""}`));
}

function isExactWorkdayOptionalSignInInspection(snapshots, main, boundUrl) {
  if (snapshots.length !== 1 || !main?.frame?.id || main.frame.parentId ||
      main.frameVisible !== true) {
    return false;
  }
  const value = main.value;
  if (!value || !isWorkdayOptionalSignInUrl(value.url) ||
      (boundUrl !== undefined && value.url !== boundUrl) ||
      value.controlOverflow !== false || value.securityFrameOverflow !== false ||
      !Array.isArray(value.securityFrames) || value.securityFrames.length !== 0 ||
      !Number.isSafeInteger(value.formCount) || value.formCount < 0 ||
      (boundUrl === undefined && value.formCount !== 0) ||
      !hasBoundedWorkdayControls(value.controls, WORKDAY_MAX_VISIBLE_CONTROLS) ||
      !hasBoundedWorkdayControls(
        value.securityControls,
        WORKDAY_MAX_SECURITY_CONTROLS,
      ) || value.securityControls.length < value.controls.length) {
    return false;
  }
  const text = typeof value.text === "string" ? value.text : "";
  const signIns = text.match(/\bSign\s+In\b/g) ?? [];
  const choiceMarkerCount = WORKDAY_CHOICE_MARKERS.filter((marker) =>
    text.includes(marker)).length;
  if (signIns.length !== 1 || !/\bApply\b/.test(text) ||
      /\bApply\s+Now\b/.test(text) ||
      ![0, WORKDAY_CHOICE_MARKERS.length].includes(choiceMarkerCount)) {
    return false;
  }
  return !isSensitivePage({
    ...value,
    text: text.replace(/\bSign\s+In\b/, ""),
    controls: value.controls.filter((control) => !isExactWorkdaySignIn(control)),
    securityControls: value.securityControls.filter((control) =>
      !isExactWorkdaySignIn(control)),
  });
}

function isExactPassiveResponseControl(control, label, type = "textarea") {
  return control?.type === type && control?.role === "textbox" &&
    control?.autocomplete === "" && control?.label === label &&
    control?.required === false;
}

function hasExactLeverChildResponses(controls) {
  return Array.isArray(controls) && controls.length === 2 &&
    controls.filter((control) =>
      isExactPassiveResponseControl(control, "g-recaptcha-response")).length === 1 &&
    controls.filter((control) =>
      isExactPassiveResponseControl(control, "h-captcha-response")).length === 1;
}

function isExactLeverEnclaveOwner(owner) {
  if (!owner || owner.title !==
      "Widget containing checkbox for hCaptcha security challenge" ||
      owner.visibility !== "hidden" || owner.position !== "fixed" ||
      !Number.isFinite(owner.width) || owner.width <= 0 ||
      !Number.isFinite(owner.height) || owner.height <= 0) {
    return false;
  }
  let url;
  try {
    url = new URL(typeof owner.src === "string" ? owner.src : "");
  } catch {
    return false;
  }
  const path = url.pathname.match(
    /^\/captcha\/v1\/([0-9a-f]{40})\/static\/hcaptcha-enclave\.html$/,
  );
  if (!path || url.protocol !== "https:" || url.username !== "" ||
      url.password !== "" || url.port !== "" ||
      url.hostname !== "newassets.hcaptcha.com" || url.search !== "") {
    return false;
  }
  const params = new URLSearchParams(url.hash.slice(1));
  const keys = [...params.keys()];
  return keys.length === 5 && new Set(keys).size === 5 &&
    params.get("frame") === "enclave" &&
    /^[A-Za-z0-9]+$/.test(params.get("_channel") ?? "") &&
    params.get("_origin") === "https://jobs.lever.co" &&
    params.get("host") === "jobs.lever.co" && params.get("se") === path[1] &&
    ["frame", "_channel", "_origin", "host", "se"].every((key) => params.has(key));
}

function hasExactLeverSecurityFrameOwners(value) {
  if (!Array.isArray(value?.securityFrames) || value.securityFrames.length !== 3 ||
      value.securityFrameOverflow !== false) {
    return false;
  }
  const auxiliary = value.securityFrames.filter((owner) =>
    owner?.src === "" && owner.title === "" && owner.visibility === "hidden" &&
    owner.position === "absolute" && owner.width === 1 && owner.height === 1);
  const enclaves = value.securityFrames.filter(isExactLeverEnclaveOwner);
  return auxiliary.length === 1 && enclaves.length === 2;
}

function hasCaptchaSecurityFrameOwner(value) {
  return Array.isArray(value?.securityFrames) && value.securityFrames.some((owner) =>
    /captcha/i.test(`${owner?.src ?? ""}\n${owner?.title ?? ""}`));
}

function isLeverPassiveHcaptchaInspection(snapshots, main) {
  if (![2, 4].includes(snapshots.length) || !main?.frame?.id || main.frame?.parentId ||
      main.frameVisible !== true) {
    return false;
  }
  const value = main.value;
  if (!value || !isLeverApplicationUrl(value.url) || value.controlOverflow !== false ||
      !Array.isArray(value.controls) || !Array.isArray(value.securityControls) ||
      !hasExactLeverSecurityFrameOwners(value)) {
    return false;
  }
  const hiddenResponses = value.securityControls.filter((control) =>
    isExactPassiveResponseControl(control, "h-captcha-response", "hidden"));
  if (hiddenResponses.length !== 1 || value.controls.some((control) =>
    isExactPassiveResponseControl(control, "h-captcha-response", "hidden"))) {
    return false;
  }
  if (isSensitivePage({
    ...value,
    securityControls: value.securityControls.filter((control) =>
      !isExactPassiveResponseControl(control, "h-captcha-response", "hidden")),
  })) return false;

  const children = snapshots.filter((snapshot) => snapshot !== main);
  const childIds = new Set();
  for (const child of children) {
    if (!child?.frame?.id || child.frame.id === main.frame.id ||
        child.frame.parentId !== main.frame.id || child.frameVisible !== false ||
        childIds.has(child.frame.id)) {
      return false;
    }
    childIds.add(child.frame.id);
  }
  if (childIds.size !== snapshots.length - 1) return false;

  const auxiliary = children.filter(({ value: childValue }) =>
    childValue?.url === "about:blank" && childValue.title === "" &&
    typeof childValue.text === "string" && childValue.text.trim() === "" &&
    Array.isArray(childValue.controls) && childValue.controls.length === 0 &&
    Array.isArray(childValue.securityControls) &&
    childValue.securityControls.length === 0 && childValue.controlOverflow === false);
  const hcaptchaFrames = children.filter(({ value: childValue }) =>
    childValue?.url === "" && childValue.title === "hCaptcha" &&
    typeof childValue.text === "string" && childValue.text.trim() === "" &&
    Array.isArray(childValue.controls) && childValue.controls.length === 0 &&
    hasExactLeverChildResponses(childValue.securityControls) &&
    childValue.controlOverflow === false);
  return auxiliary.length === 1 &&
    (snapshots.length === 2 ? hcaptchaFrames.length === 0 : hcaptchaFrames.length === 2);
}

function isAshbyPassiveRecaptchaInspection(snapshots, main) {
  if (snapshots.length !== 2 || !main?.frame?.id || main.frameVisible !== true) return false;
  const value = main.value;
  if (!value || !isAshbyApplicationUrl(value.url) || value.controlOverflow !== false ||
      !Array.isArray(value.controls) || !Array.isArray(value.securityControls)) {
    return false;
  }
  const controls = value.controls;
  const securityControls = value.securityControls;
  const hiddenResponses = securityControls.filter(isPassiveRecaptchaResponseControl);
  if (hiddenResponses.length !== 1 || controls.some(isPassiveRecaptchaResponseControl)) {
    return false;
  }
  const hasInteractiveChallenge = [...controls, ...securityControls].some((control) =>
    /(?:captcha|challenge|not a robot)/i.test(
      typeof control?.label === "string" ? control.label : "",
    ) && !isPassiveRecaptchaResponseControl(control));
  if (hasInteractiveChallenge) return false;
  if (isSensitivePage({
    ...value,
    securityControls: securityControls.filter((control) =>
      !isPassiveRecaptchaResponseControl(control)),
  })) return false;

  const child = snapshots.find((snapshot) => snapshot !== main);
  const childValue = child?.value;
  return child?.frame?.parentId === main.frame.id && child.frame.id &&
    child.frame.id !== main.frame.id && typeof child.frameVisible === "boolean" &&
    childValue?.url === "about:blank" && typeof childValue.title === "string" &&
    childValue.title.trim() === "" && typeof childValue.text === "string" &&
    childValue.text.trim() === "" && Array.isArray(childValue.controls) &&
    childValue.controls.length === 0 && Array.isArray(childValue.securityControls) &&
    childValue.securityControls.length === 0 && childValue.controlOverflow === false;
}

function isDormantLinkedInCaptcha(snapshot) {
  const value = snapshot?.value;
  if (!value || !snapshot.frame?.parentId || snapshot.frameVisible !== false) return false;
  const url = typeof value.url === "string" ? value.url : "";
  const title = typeof value.title === "string" ? value.title : "";
  const text = typeof value.text === "string" ? value.text : "";
  const controls = [
    ...(Array.isArray(value.controls) ? value.controls : []),
    ...(Array.isArray(value.securityControls) ? value.securityControls : []),
  ];
  const surface = `${url}\n${title}\n${text}\n${controls.map((control) =>
    `${control?.type ?? ""}\n${control?.autocomplete ?? ""}\n${control?.label ?? ""}`
  ).join("\n")}`;
  const captchaOnly = surface.replace(/captcha/gi, "");
  const hasCredentialControl = controls.some((control) => {
    const type = typeof control?.type === "string" ? control.type.toLowerCase() : "";
    const autocomplete = typeof control?.autocomplete === "string"
      ? control.autocomplete.toLowerCase()
      : "";
    const label = typeof control?.label === "string" ? control.label : "";
    return type === "password" ||
      ["current-password", "one-time-code"].includes(autocomplete) ||
      SENSITIVE_PATTERN.test(`${type}\n${autocomplete}\n${label}`.replace(/captcha/gi, ""));
  });
  return /captcha/i.test(surface) &&
    !SENSITIVE_PATTERN.test(captchaOnly) && !hasCredentialControl;
}

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

export class BrokerClient {
  constructor(child, lines) {
    this.child = child;
    this.lines = lines;
    this.nextId = 1;
    this.pending = new Map();
    this.requestQueue = Promise.resolve();
    this.closed = false;
  }

  static async start(root) {
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const child = spawn("python3", ["-m", "qa.recorder_fs", "--root", root], {
      cwd: repositoryRoot,
      detached: process.platform !== "win32",
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
    clearTimeout(this.terminationTimer);
    clearTimeout(this.killTimer);
    this.terminationTimer = undefined;
    this.killTimer = undefined;
    for (const pending of this.pending.values()) {
      pending.reject(new RecorderError("filesystem broker unavailable"));
    }
    this.pending.clear();
  }

  _failClosed() {
    this._failAll();
    this.child.stdin.destroy();
    if (this.child.exitCode === null && !this.terminationTimer) {
      this.terminationTimer = setTimeout(() => {
        if (this.child.exitCode === null) this.child.kill("SIGTERM");
      }, BROKER_EOF_GRACE_MS);
      this.terminationTimer.unref?.();
      this.killTimer = setTimeout(() => {
        if (this.child.exitCode === null) this.child.kill("SIGKILL");
      }, BROKER_EOF_GRACE_MS + BROKER_TERMINATE_GRACE_MS);
      this.killTimer.unref?.();
    }
  }

  _handleLine(line) {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      this._failClosed();
      return;
    }
    const pending = this.pending.get(response?.id);
    if (!pending) {
      this._failClosed();
      return;
    }
    this.pending.delete(response.id);
    if (response.ok === true && Object.hasOwn(response, "result")) {
      pending.resolve(response.result);
    } else {
      pending.reject(new RecorderError("filesystem operation rejected"));
    }
  }

  _requestNow(command, fields) {
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
    }), BROKER_REQUEST_DEADLINE_MS, undefined, () => this._failClosed());
    return operation.finally(() => this.pending.delete(id));
  }

  request(command, fields = {}) {
    if (this.closed || this.child.exitCode !== null) {
      return Promise.reject(new RecorderError("filesystem broker unavailable"));
    }
    const operation = this.requestQueue.then(() => this._requestNow(command, fields));
    this.requestQueue = operation.catch(() => {});
    return operation;
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
    await this.requestQueue.catch(() => {});
    if (this.child.exitCode !== null) {
      this.lines.close();
      return;
    }
    this.closed = true;
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    await withDeadline(new Promise((resolve) => {
      if (this.child.exitCode !== null) resolve();
      else this.child.once("exit", resolve);
    }), 2000).catch(() => {
      this.child.kill("SIGKILL");
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
    const controlSelector = "input,select,textarea,button,[role]";
    const composedParent = (element) => element.parentElement ||
      (element.getRootNode() instanceof ShadowRoot ? element.getRootNode().host : null);
    const roots = new WeakSet();
    const observeRoot = (root) => {
      if (roots.has(root)) return;
      roots.add(root);
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof Element)) continue;
            if (node.shadowRoot) observeRoot(node.shadowRoot);
            for (const child of node.querySelectorAll("*")) {
              if (child.shadowRoot) observeRoot(child.shadowRoot);
            }
          }
        }
        binding(JSON.stringify({ messageType: "document-state" }));
      });
      observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) observeRoot(element.shadowRoot);
      }
    };
    observeRoot(document);
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
    const isVisible = (element) => {
      if (element.matches("input[type=hidden],input[type=password]")) return false;
      for (let current = element; current instanceof Element; current = composedParent(current)) {
        if (current.matches("[hidden],[aria-hidden=true]")) return false;
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" ||
            style.visibility === "collapse" || Number.parseFloat(style.opacity) === 0 ||
            style.contentVisibility === "hidden") return false;
      }
      const rectangle = element.getBoundingClientRect();
      if (rectangle.width <= 0 || rectangle.height <= 0) return false;
      const style = getComputedStyle(element);
      if (style.position === "fixed") {
        return rectangle.bottom > 0 && rectangle.right > 0 &&
          rectangle.top < innerHeight && rectangle.left < innerWidth;
      }
      return rectangle.right + scrollX > 0 && rectangle.bottom + scrollY > 0;
    };
    for (const interactionType of ["click", "change", "input"]) {
      document.addEventListener(interactionType, (event) => {
        if (!event.isTrusted) return;
        const source = event.composedPath().find((node) => node instanceof Element);
        const element = source instanceof Element ? source.closest(controlSelector) : null;
        if (!element || !isVisible(element)) return;
        let label = labelFor(element).slice(0, 256);
        const mutable = [];
        if ("value" in element && typeof element.value === "string" && element.value) {
          mutable.push(element.value);
        }
        if (element instanceof HTMLInputElement && element.files) {
          for (const file of element.files) if (file.name) mutable.push(file.name);
        }
        if (element instanceof HTMLSelectElement) {
          for (const option of element.selectedOptions) {
            if (option.value) mutable.push(option.value);
            if (option.text) mutable.push(option.text);
          }
        }
        const normalizeMutable = (value) => value.normalize("NFKC")
          .toLocaleLowerCase("und").replaceAll("ß", "ss").replaceAll("ς", "σ")
          .replace(/\s+/g, " ").trim();
        const compactMutable = (value) => normalizeMutable(value)
          .replace(/[^\\p{L}\\p{N}]+/gu, "");
        const normalizedLabel = normalizeMutable(label);
        const compactLabel = compactMutable(label);
        const exposesMutable = mutable.some((value) => {
          const normalized = normalizeMutable(value);
          if (!normalized) return false;
          if (normalizedLabel.includes(normalized)) return true;
          const compact = compactMutable(value);
          if (compact.length >= 4 && compactLabel.includes(compact)) return true;
          return compact.length >= 8 && (
            compactLabel.includes(compact.slice(0, 6)) ||
            compactLabel.includes(compact.slice(-6))
          );
        });
        if (exposesMutable) label = "";
        const observed = {
          messageType: "interaction",
          interactionType,
          role: roleFor(element),
          label,
          required: element.matches("[required],[aria-required=true]"),
        };
        queueMicrotask(() => {
          binding(JSON.stringify(observed));
        });
      }, true);
    }
  })()`;
}

function isolatedSnapshotSource(includeStructure) {
  return `(() => {
    const denied = /(?:password|passcode|captcha|multi[ -]?factor|\\bmfa\\b|\\b2fa\\b|2[ -]?step verification|\\botp\\b|authentication|authenticator app|push notification|verify (?:your )?identity|\\b\\d{1,2}[ -]?digit code(?: we sent)?|recovery code|sms code|security code|challenge|security[ -]?key|one[ -]?time[ -]?code|authorization|bearer|cookie|session|csrf|token)/i;
    const controlSelector = "input,select,textarea,button,[role]";
    const composedParent = (element) => element.parentElement ||
      (element.getRootNode() instanceof ShadowRoot ? element.getRootNode().host : null);
    const collectControls = (root, controls = []) => {
      for (const element of root.querySelectorAll("*")) {
        if (element.matches(controlSelector)) controls.push(element);
        if (element.shadowRoot) {
          collectControls(element.shadowRoot, controls);
        }
      }
      return controls;
    };
    let pageText = "";
    const collectPageText = (node) => {
      if (!node || pageText.length >= 8192) return;
      if (node.nodeType === Node.TEXT_NODE) {
        pageText += (pageText ? " " : "") + (node.textContent || "");
        pageText = pageText.slice(0, 8192);
        return;
      }
      if (node instanceof Element && node.matches("script,style,template")) return;
      for (const child of node.childNodes) collectPageText(child);
      if (node instanceof Element && node.shadowRoot) collectPageText(node.shadowRoot);
    };
    const labelFor = (element) => {
      const aria = element.getAttribute("aria-label");
      if (aria) return aria;
      const labelled = element.getAttribute("aria-labelledby");
      if (labelled) {
        const root = element.getRootNode();
        const label = labelled.split(/\\s+/).map((id) =>
          (root.getElementById?.(id) || document.getElementById(id))?.innerText || ""
        ).join(" ").trim();
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
    const isVisible = (element) => {
      if (element.matches("input[type=hidden],input[type=password]")) return false;
      for (let current = element; current instanceof Element; current = composedParent(current)) {
        if (current.matches("[hidden],[aria-hidden=true]")) return false;
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" ||
            style.visibility === "collapse" || Number.parseFloat(style.opacity) === 0 ||
            style.contentVisibility === "hidden") return false;
      }
      const rectangle = element.getBoundingClientRect();
      if (rectangle.width <= 0 || rectangle.height <= 0) return false;
      const elementStyle = getComputedStyle(element);
      if (elementStyle.position === "fixed") {
        return rectangle.bottom > 0 && rectangle.right > 0 &&
          rectangle.top < innerHeight && rectangle.left < innerWidth;
      }
      return rectangle.right + scrollX > 0 && rectangle.bottom + scrollY > 0;
    };
    const elements = collectControls(document);
    const describe = (element) => ({
      type: element instanceof HTMLInputElement ? element.type : element.tagName.toLowerCase(),
      autocomplete: element.getAttribute("autocomplete") || "",
      label: labelFor(element).slice(0, 256),
      role: roleFor(element).slice(0, 64),
      required: element.matches("[required],[aria-required=true]"),
    });
    const securityControls = elements.slice(0, ${CAPTURE_LIMITS.maxControls + 1}).map(describe);
    const visibleElements = elements.filter(isVisible);
    const controls = visibleElements.slice(0, ${CAPTURE_LIMITS.maxControls + 1}).map(describe);
    const formCount = document.querySelectorAll("form").length;
    const iframeOwners = Array.from(document.querySelectorAll("iframe"));
    const securityFrames = iframeOwners.slice(0, 4).map((frame) => {
      const style = getComputedStyle(frame);
      const rectangle = frame.getBoundingClientRect();
      return {
        src: (frame.getAttribute("src") || "").slice(0, 2048),
        title: (frame.getAttribute("title") || "").slice(0, 512),
        visibility: style.visibility,
        position: style.position,
        width: rectangle.width,
        height: rectangle.height,
      };
    });
    collectPageText(document.body);
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
        if (node.shadowRoot) {
          for (const child of node.shadowRoot.childNodes) children += serialize(child);
        }
        const result = "<" + tag + (attributes.length ? " " + attributes.join(" ") : "") + ">" + children + "</" + tag + ">";
        if (result.length > ${CAPTURE_LIMITS.maxHtmlBytes + 1}) structuralOverflow = true;
        return result.slice(0, ${CAPTURE_LIMITS.maxHtmlBytes + 1});
      };
      html = "<!doctype html>" + serialize(document.documentElement);
    }
    return {
      title: document.title.slice(0, 512),
      text: pageText,
      controls,
      securityControls,
      controlOverflow: elements.length > ${CAPTURE_LIMITS.maxControls},
      formCount,
      securityFrames,
      securityFrameOverflow: iframeOwners.length > 3,
      html,
      structuralOverflow,
      width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
      height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
    };
  })()`;
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

async function createIsolatedRecorder(context, page, observe, navigated) {
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
  let eventSafetyQueue = Promise.resolve();
  let pendingEventInspections = 0;
  let pendingEventWrites = 0;
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
    let eventCount = 0;
    let pageSequence = 1;
    const checkpointKinds = [];
    const observe = (observed) => {
      if (!captureEnabled || eventCount >= MAX_EVENTS || !observed ||
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
      eventCount += 1;
      pendingEventWrites += 1;
      const write = writeQueue.then(() => broker.write(
        "append",
        "events.jsonl",
        line,
      )).finally(() => { pendingEventWrites -= 1; });
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
      if (pendingEventInspections + pendingEventWrites >= MAX_PENDING_EVENT_OPERATIONS ||
          eventCount + pendingEventInspections >= MAX_EVENTS) return;
      pendingEventInspections += 1;
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
          pendingEventInspections -= 1;
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
        await withDeadline(writeQueue, CHECKPOINT_OPERATION_DEADLINE_MS, signal);
        throwIfAborted(signal);
        if (shuttingDown) throw new RecorderError("operation canceled");
        validateCheckpointKind(kind);
        if (!lifecycleAllows(checkpointKinds, kind)) {
          throw new RecorderError("invalid checkpoint lifecycle");
        }
        throwIfAborted(signal);
        const captureRevision = safetyRevision;
        const assertCaptureRevision = () =>
          validateSafetyRevision(captureRevision, safetyRevision);
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
            pageSequence,
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
