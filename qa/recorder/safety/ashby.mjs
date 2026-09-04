import {
  isPassiveRecaptchaResponseControl,
  isSensitivePage,
} from "./common.mjs";

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

export function isAshbyPassiveRecaptchaInspection(snapshots, main) {
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
