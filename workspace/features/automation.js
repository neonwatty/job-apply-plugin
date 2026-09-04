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
    employerAccountOverrideRequest,
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
    form.elements.signupEmail.value = "";
    form.elements.signupEmail.placeholder = settings.signupEmailConfigured
      ? "Configured; enter a replacement"
      : "Not configured";
    form.elements.passwordStrategy.value = settings.passwordStrategy;
    $("#automation-revision").textContent = `Revision ${settings.revision}`;
    $("#automation-email-status").textContent = settings.signupEmailConfigured ? "Configured; value remains hidden" : "Not configured";
    const capability = projection.capability;
    const accountFlow = capability.accountFlowAutomation || {};
    const capabilityReason = capability.reasonCode ? capability.reasonCode.replaceAll("_", " ") : capability.state;
    const workday = accountFlow.workdayPasswordAccountReady ? "Reviewed Workday seam ready; live execution disabled" : "Workday account automation unavailable";
    const greenhouse = accountFlow.greenhouseAccountlessClassificationReady ? "ordinary Greenhouse applications are accountless" : "Greenhouse account status unresolved";
    $("#automation-capability").textContent = `${workday} · ${greenhouse} · ${accountFlow.emailOnlyCandidateProfileReady ? "Oracle candidate-profile seam ready" : "Oracle candidate-profile seam unavailable"} · ${capabilityReason}. Settings and recovery remain available here; no live execution control is exposed.`;
    const list = $("#automation-accounts"); list.replaceChildren();
    for (const account of projection.accounts) {
      const card = document.createElement("article"); card.className = "automation-account"; card.setAttribute("role", "listitem");
      const realmLabel = account.adapterId === "oracle-recruiting" ? "Oracle Recruiting site" : "Workday realm";
      const title = document.createElement("h3"); title.textContent = `${realmLabel} · ${account.realmRef.slice(0, 12)}…`;
      const detail = document.createElement("p"); detail.textContent = `${account.lifecycleState.replaceAll("_", " ")} · revision ${account.revision} · ${account.signupEmailOverrideConfigured ? "email override configured" : "global email setting"} · ${String(account.flowKind || "password_candidate_account").replaceAll("_", " ")}`;
      const status = document.createElement("p"); status.textContent = account.credentialRequired === false ? "Email-only candidate profile; no password is created or stored." : (account.providerAssigned ? "Protected credential metadata assigned; value remains inaccessible." : "Credential not provisioned.");
      const form = document.createElement("form"); form.className = "realm-override-form"; form.setAttribute("aria-label", `Edit signup email override for ${realmLabel} ${account.realmRef.slice(0, 12)}`);
      const label = document.createElement("label"); label.textContent = "Signup email override";
      const input = document.createElement("input"); input.type = "email"; input.autocomplete = "email"; input.value = account.signupEmailOverride || ""; input.placeholder = "Use global signup email"; label.append(input);
      const actions = document.createElement("div"); actions.className = "button-row";
      const save = document.createElement("button"); save.type = "submit"; save.className = "button secondary"; save.textContent = "Save override";
      const clear = document.createElement("button"); clear.type = "button"; clear.className = "button secondary"; clear.textContent = "Clear override";
      const feedback = document.createElement("p"); feedback.className = "realm-override-feedback visually-hidden"; feedback.setAttribute("role", "status"); feedback.setAttribute("aria-live", "polite");
      const conflict = document.createElement("div"); conflict.className = "conflict hidden"; conflict.setAttribute("role", "alert"); conflict.tabIndex = -1; conflict.textContent = "This realm changed elsewhere. Nothing was retried. Refresh and review the latest revision.";
      const submit = async (clearValue) => {
        conflict.classList.add("hidden"); feedback.classList.add("visually-hidden");
        if (!clearValue && !input.value.trim()) { feedback.textContent = "Enter an email override or choose Clear override."; feedback.classList.remove("visually-hidden"); return; }
        const request = employerAccountOverrideRequest(account, input.value, clearValue);
        try { await api(request.path, request.options); await refreshAutomation({ quiet: true }); toast(clearValue ? "Realm email override cleared" : "Realm email override saved"); }
        catch (error) {
          if (error.code === "revision_conflict") { conflict.classList.remove("hidden"); conflict.focus(); }
          else { feedback.textContent = error.message; feedback.classList.remove("visually-hidden"); }
        }
      };
      form.addEventListener("submit", (event) => { event.preventDefault(); submit(false); });
      clear.addEventListener("click", () => submit(true)); actions.append(save, clear); form.append(label, actions, feedback, conflict);
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

  async function saveAutomation(event, clearEmail = false) {
    event?.preventDefault(); const current = automationState.projection?.settings; if (!current) return;
    const form = $("#automation-form");
    const patch = {
      enabled: form.elements.enabled.checked,
      automaticAccountCreation: form.elements.automaticAccountCreation.checked,
      passwordStrategy: form.elements.passwordStrategy.value,
    };
    if (clearEmail) patch.signupEmail = null;
    else if (form.elements.signupEmail.value.trim()) patch.signupEmail = form.elements.signupEmail.value.trim();
    try {
      await api("/api/automation/settings", { method: "PATCH", body: JSON.stringify({ patch, expectedRevision: current.revision }) });
      await refreshAutomation({ quiet: true }); toast("Automation settings saved");
    } catch (error) {
      if (error.code === "revision_conflict") { $("#automation-conflict").classList.remove("hidden"); $("#automation-conflict").focus(); }
      else { $("#automation-error").textContent = error.message; $("#automation-error").classList.remove("hidden"); }
    }
  }

  async function copyProfileEmailToAutomation() {
    const settings = automationState.projection?.settings;
    const profileRevision = automationState.projection?.profileRevision;
    if (!settings || !Number.isInteger(profileRevision)) return;
    try {
      await api("/api/automation/settings/copy-profile-email", {
        method: "POST",
        body: JSON.stringify({
          expectedProfileRevision: profileRevision,
          expectedSettingsRevision: settings.revision,
        }),
      });
      await refreshAutomation({ quiet: true });
      toast("Profile email copied once; future profile edits stay independent");
    } catch (error) {
      if (error.code === "revision_conflict") { $("#automation-conflict").classList.remove("hidden"); $("#automation-conflict").focus(); }
      else { $("#automation-error").textContent = error.message; $("#automation-error").classList.remove("hidden"); }
    }
  }

  async function addEmployerRealm(event) {
    event.preventDefault(); const form = event.currentTarget;
    const payload = { url: form.elements.url.value };
    if (form.elements.signupEmailOverride.value.trim()) payload.signupEmailOverride = form.elements.signupEmailOverride.value.trim();
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


  Object.assign(coordinators, { renderAutomation, refreshAutomation, renderAccountOperation, refreshAccountOperation, recoverAccountOperation, saveAutomation, copyProfileEmailToAutomation, addEmployerRealm, renderTrustedFillStatus, approveTrustedFill, loadTrustedFillStatus, revokeTrustedFill });
}
