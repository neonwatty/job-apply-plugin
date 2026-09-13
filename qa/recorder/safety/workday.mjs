import { isSensitivePage } from "./common.mjs";

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

export function isExactWorkdayOptionalSignInInspection(snapshots, main, boundUrl) {
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
