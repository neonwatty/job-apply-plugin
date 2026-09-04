export const SENSITIVE_PATTERN = /(?:\blog[ -]?in\b|\bsign[ -]?in\b|password|passcode|captcha|not a robot|multi[ -]?factor|\bmfa\b|two[ -]?factor|\b2fa\b|2[ -]?step verification|verification code|security code|sms code|recovery code|authenticator app|push notification|verify (?:your )?identity|\b\d{1,2}[ -]?digit code(?: we sent)?|approve (?:this |the )?(?:device|sign[ -]?in)|create (?:an? )?account|account[ -]?creation|register|\botp\b|authentication|security[ -]?key|one[ -]?time[ -]?code)/i;

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

export function isPassiveRecaptchaResponseControl(control) {
  return control?.type === "textarea" && control?.role === "textbox" &&
    control?.label === "g-recaptcha-response" &&
    (control?.autocomplete === "" || control?.autocomplete == null);
}

export function hasCaptchaSecurityFrameOwner(value) {
  return Array.isArray(value?.securityFrames) && value.securityFrames.some((owner) =>
    /captcha/i.test(`${owner?.src ?? ""}\n${owner?.title ?? ""}`));
}
