import { isSensitivePage } from "./common.mjs";

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

export function isLeverPassiveHcaptchaInspection(snapshots, main) {
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
