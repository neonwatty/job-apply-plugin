import * as apiHelpers from "../lib/api.js";

export function installAutomation(context) {
  const { api, state: stores, dom, coordinators } = context;
  const {
    job: state,
    automation: automationState,
    accountOperation: accountOperationState,
    trustedFill: trustedFillState,
  } = stores;
  const {
    $,
    form,
    toast,
  } = dom;
  const {
    trustedFillApprovalPacket,
    trustedFillRevokeRequest,
  } = apiHelpers;
  const save = (...args) => coordinators.save(...args);
  function renderAutomation(projection) {
    automationState.projection = projection; automationState.loaded = true;
    const settings = projection.settings;
    const form = $("#automation-form");
    form.elements.enabled.checked = settings.enabled;
    form.elements.automaticAccountCreation.checked = settings.automaticAccountCreation;
    form.elements.passwordStrategy.value = settings.passwordStrategy;
    $("#automation-revision").textContent = `Revision ${settings.revision}`;
    const capability = projection.capability;
    const accountFlow = capability.accountFlowAutomation || {};
    const capabilityReason = capability.reasonCode ? capability.reasonCode.replaceAll("_", " ") : capability.state;
    const workday = accountFlow.workdayPasswordAccountReady ? "Workday Keychain configuration ready" : "Workday account configuration unavailable";
    const greenhouse = accountFlow.greenhouseAccountlessClassificationReady ? "direct Greenhouse applications require no account" : "Greenhouse account status unresolved";
    const myGreenhouse = accountFlow.myGreenhousePasswordlessExecutionReady ? "MyGreenhouse browser sign-in ready" : "MyGreenhouse configuration ready; browser sign-in not observed";
    $("#automation-capability").textContent = `${workday} · ${myGreenhouse} · ${greenhouse} · ${accountFlow.emailOnlyCandidateProfileReady ? "Oracle email-only profile ready" : "Oracle profile unavailable"} · ${capabilityReason}. Configuration readiness is separate from browser-session readiness.`;
    const list = $("#automation-accounts"); list.replaceChildren();
    for (const account of projection.accounts) {
      const card = document.createElement("article"); card.className = "automation-account"; card.setAttribute("role", "listitem");
      const realmLabel = account.adapterId === "oracle-recruiting" ? "Oracle Recruiting site" : account.adapterId === "mygreenhouse" ? "MyGreenhouse global account" : "Workday realm";
      const title = document.createElement("h3"); title.textContent = `${realmLabel} · ${account.realmRef.slice(0, 12)}…`;
      const detail = document.createElement("p"); detail.textContent = `${account.lifecycleState.replaceAll("_", " ")} · revision ${account.revision} · ${account.signupEmailOverrideConfigured ? "contact metadata configured" : "no contact override stored"} · ${String(account.flowKind).replaceAll("_", " ")}`;
      const status = document.createElement("p"); status.textContent = account.adapterId === "workday" ? (account.providerAssigned ? "Saved metadata: Keychain configured · Browser session: not observed" : "Saved metadata: Keychain setup pending · Browser session: not observed") : account.adapterId === "mygreenhouse" ? "Saved metadata: optional global passwordless profile · Browser session: not observed" : "Saved metadata: email-only profile · Browser session: not observed";
      const form = document.createElement("div"); form.className = "realm-override-form";
      const actions = document.createElement("div"); actions.className = "button-row";
      const clear = document.createElement("button"); clear.type = "button"; clear.className = "button secondary"; clear.textContent = "Clear contact metadata"; clear.disabled = !account.signupEmailOverrideConfigured;
      const feedback = document.createElement("p"); feedback.className = "realm-override-feedback visually-hidden"; feedback.setAttribute("role", "status"); feedback.setAttribute("aria-live", "polite");
      const conflict = document.createElement("div"); conflict.className = "conflict hidden"; conflict.setAttribute("role", "alert"); conflict.tabIndex = -1; conflict.textContent = "This realm changed elsewhere. Nothing was retried. Refresh and review the latest revision.";
      const submit = async () => {
        conflict.classList.add("hidden"); feedback.classList.add("visually-hidden");
        try { await api(`/api/employer-accounts/${encodeURIComponent(account.realmRef)}`, { method: "PATCH", body: JSON.stringify({ patch: { signupEmailOverride: null }, expectedRevision: account.revision }) }); await refreshAutomation({ quiet: true }); toast("Contact metadata cleared"); }
        catch (error) {
          if (error.code === "revision_conflict") { conflict.classList.remove("hidden"); conflict.focus(); }
          else { feedback.textContent = error.message; feedback.classList.remove("visually-hidden"); }
        }
      };
      clear.addEventListener("click", submit); actions.append(clear); form.append(actions, feedback, conflict);
      card.append(title, detail, status, form); list.append(card);
    }
    if (!projection.accounts.length) {
      const empty = document.createElement("p"); empty.className = "empty-state compact-empty"; empty.textContent = "No employer realms recorded yet."; list.append(empty);
    }
  }

  async function refreshAutomation({ quiet = false } = {}) {
    try {
      const projection = await api("/api/automation"); renderAutomation(projection);
      $("#automation-error").classList.add("hidden"); $("#automation-conflict").classList.add("hidden");
      if (!quiet) toast("Automation controls refreshed");
    } catch (error) {
      $("#automation-error").textContent = error.message; $("#automation-error").classList.remove("hidden");
    }
  }

  function renderAccountOperation(status) {
    accountOperationState.status = status;
    const pending = status?.status === "recovery_required";
    $("#account-operation-status").textContent = pending
      ? `Recovery required · ${status.operation.stage.replaceAll("_", " ")} · realm ${status.operation.realmRef.slice(0, 12)}…`
      : "No protected account operation is pending.";
    $("#account-operation-recover").disabled = !pending;
  }

  async function refreshAccountOperation() {
    try { renderAccountOperation(await api("/api/account-operation")); $("#account-operation-error").classList.add("hidden"); }
    catch (error) { $("#account-operation-error").textContent = error.message; $("#account-operation-error").classList.remove("hidden"); }
  }

  async function recoverAccountOperation() {
    try {
      const result = await api("/api/account-operation/recover", { method: "POST", body: "{}" });
      renderAccountOperation({ status: "idle", operation: null }); await refreshAutomation({ quiet: true });
      toast(result.recovered ? "Stranded account operation marked ambiguous" : "No stranded operation found");
    } catch (error) { $("#account-operation-error").textContent = error.message; $("#account-operation-error").classList.remove("hidden"); }
  }

  async function saveAutomation(event) {
    event?.preventDefault(); const current = automationState.projection?.settings; if (!current) return;
    const form = $("#automation-form");
    const patch = {
      enabled: form.elements.enabled.checked,
      automaticAccountCreation: form.elements.automaticAccountCreation.checked,
      passwordStrategy: form.elements.passwordStrategy.value,
    };
    try {
      await api("/api/automation/settings", { method: "PATCH", body: JSON.stringify({ patch, expectedRevision: current.revision }) });
      await refreshAutomation({ quiet: true }); toast("Automation settings saved");
    } catch (error) {
      if (error.code === "revision_conflict") { $("#automation-conflict").classList.remove("hidden"); $("#automation-conflict").focus(); }
      else { $("#automation-error").textContent = error.message; $("#automation-error").classList.remove("hidden"); }
    }
  }

  async function addEmployerRealm(event) {
    event.preventDefault(); const form = event.currentTarget;
    const payload = { url: form.elements.url.value };
    try {
      await api("/api/employer-accounts", { method: "POST", body: JSON.stringify(payload) });
      form.reset(); await refreshAutomation({ quiet: true }); toast("Resolved employer realm added");
    } catch (error) {
      $("#automation-error").textContent = error.message; $("#automation-error").classList.remove("hidden");
    }
  }

  function renderTrustedFillStatus(status) {
    trustedFillState.status = status;
    const node = $("#trusted-fill-status");
    if (!status || status.status === "missing") node.textContent = "No approval exists for this job.";
    else node.textContent = `${status.status.replaceAll("_", " ")} · approval revision ${status.approvalRevision} · expires ${status.expiresAt}`;
    $("#trusted-fill-revoke").disabled = status?.status !== "active";
  }

  async function approveTrustedFill(event) {
    event.preventDefault(); const form = event.currentTarget;
    const allowedOperations = [...form.querySelectorAll('input[name="allowedOperations"]:checked')].map((item) => item.value);
    const packet = trustedFillApprovalPacket({
      jobId: form.elements.jobId.value, expectedJobRevision: form.elements.expectedJobRevision.value,
      realmRef: form.elements.realmRef.value, answerRefs: form.elements.answerRefs.value,
      observedQuestionFingerprint: form.elements.observedQuestionFingerprint.value,
      observedControlFingerprint: form.elements.observedControlFingerprint.value,
      formFingerprint: form.elements.formFingerprint.value, allowedOperations,
      durationMinutes: form.elements.durationMinutes.value,
    });
    if (!allowedOperations.length) { $("#trusted-fill-error").textContent = "Select at least one non-final operation."; $("#trusted-fill-error").classList.remove("hidden"); return; }
    try {
      const status = await api("/api/trusted-fill/approve", { method: "POST", body: JSON.stringify(packet) });
      $("#trusted-fill-status-form").elements.jobId.value = packet.jobId; renderTrustedFillStatus(status);
      $("#trusted-fill-error").classList.add("hidden"); toast("Exact Trusted Fill packet approved");
    } catch (error) { $("#trusted-fill-error").textContent = error.message; $("#trusted-fill-error").classList.remove("hidden"); }
  }

  async function loadTrustedFillStatus(event) {
    event?.preventDefault(); const jobId = $("#trusted-fill-status-form").elements.jobId.value.trim();
    try { renderTrustedFillStatus(await api(`/api/trusted-fill/${encodeURIComponent(jobId)}`)); $("#trusted-fill-error").classList.add("hidden"); }
    catch (error) { $("#trusted-fill-error").textContent = error.message; $("#trusted-fill-error").classList.remove("hidden"); }
  }

  async function revokeTrustedFill() {
    const request = trustedFillRevokeRequest(trustedFillState.status);
    try { renderTrustedFillStatus(await api(request.path, request.options)); $("#trusted-fill-conflict").classList.add("hidden"); toast("Trusted Fill approval revoked"); }
    catch (error) {
      if (error.code === "revision_conflict") { $("#trusted-fill-conflict").classList.remove("hidden"); $("#trusted-fill-conflict").focus(); }
      else { $("#trusted-fill-error").textContent = error.message; $("#trusted-fill-error").classList.remove("hidden"); }
    }
  }


  Object.assign(coordinators, { renderAutomation, refreshAutomation, renderAccountOperation, refreshAccountOperation, recoverAccountOperation, saveAutomation, addEmployerRealm, renderTrustedFillStatus, approveTrustedFill, loadTrustedFillStatus, revokeTrustedFill });
}
