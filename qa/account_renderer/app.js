export const OUTCOMES = Object.freeze({ success: "active", reuse: "active", verification: "verification_required", challenge: "verification_required", consent: "verification_required", reset: "reset_required", definitive_failure: "failed_definitive", ambiguity: "ambiguous", restart: "ambiguous" });

export function protectedOutcome(scenario, nativeEffectObserved = false) {
  return { lifecycleState: nativeEffectObserved ? (OUTCOMES[scenario] || "ambiguous") : "pending_native_effect", retryAllowed: false, finalActionAuthorized: false, secureControlCleared: nativeEffectObserved };
}

export function emailOnlyOutcome(scenario, nativeEffectObserved = false) {
  const states = { success: "active", verification: "verification_required", definitive_failure: "failed_definitive", ambiguity: "ambiguous" };
  return { lifecycleState: nativeEffectObserved ? (states[scenario] || "ambiguous") : "pending_native_effect", retryAllowed: false, finalActionAuthorized: false, credentialProviderInvocations: 0, nextActivations: nativeEffectObserved ? 1 : 0, emailRemoved: nativeEffectObserved };
}

if (typeof document !== "undefined") {
  const emailOnly = document.body.dataset.accountMode === "oracle-email-only";
  const secureControl = document.querySelector("#job-apply-secure-control");
  document.querySelector("#password-account").hidden = emailOnly;
  document.querySelector("#simulate").hidden = emailOnly;
  document.querySelector("#email-only-account").hidden = !emailOnly;
  document.querySelector("#simulate").addEventListener("click", () => {
    secureControl.focus();
    document.querySelector("#result").textContent = "Awaiting independently attested native fill and clear.";
  });
  document.querySelector("#job-apply-next-control").addEventListener("click", () => {
    if (!emailOnly) return;
    const email = document.querySelector("#job-apply-email-control");
    const terms = document.querySelector("#job-apply-terms-control");
    if (!email.value || !terms.checked) return;
    email.value = "";
    document.querySelector("#result").textContent = "Candidate-profile Next observed once; application submission remains unavailable.";
  });
}
