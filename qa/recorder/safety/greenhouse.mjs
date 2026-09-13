import {
  isPassiveRecaptchaResponseControl,
  isSensitivePage,
} from "./common.mjs";

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

export function isGreenhousePassiveRecaptchaMain(snapshot) {
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

export function isPassiveGreenhouseRecaptchaFrame(snapshot, main) {
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
