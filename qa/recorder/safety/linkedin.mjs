import { SENSITIVE_PATTERN } from "./common.mjs";

export function isLinkedInJobsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" &&
      url.port === "" && ["linkedin.com", "www.linkedin.com"].includes(url.hostname) &&
      (url.pathname === "/jobs" || url.pathname.startsWith("/jobs/"));
  } catch {
    return false;
  }
}

export function isDormantLinkedInCaptcha(snapshot) {
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
