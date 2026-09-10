import * as apiHelpers from "../lib/api.js";
import * as helpers from "../lib/helpers.js";

export function installBindings(context) {
  const { api, state: stores, dom, coordinators } = context;
  const {
    job: state,
    factGroup: factGroupState,
    resume: resumeState,
    answer: answerState,
    trash: trashState,
  } = stores;
  const {
    $,
    form,
    dialog,
    toast,
    setConnection,
    token,
  } = dom;
  const {
    activityRefreshCoordinator,
  } = coordinators;
  const {
    ApiError,
  } = apiHelpers;
  const {
    canRefreshAnswerDraft,
    canApplyAnswerReveal,
    canApplyAnswerDialogResponse,
    answerApiPath,
    tagsFromInput,
    typedDeletePhrase,
    lifecycleErrorText,
  } = helpers;
  const clearPreflightReadiness = (...args) => coordinators.clearPreflightReadiness(...args);
  const refreshOverview = (...args) => coordinators.refreshOverview(...args);
  const renderDegradedBoot = (...args) => coordinators.renderDegradedBoot(...args);
  const copyInvocation = (...args) => coordinators.copyInvocation(...args);
  const applyFactView = (...args) => coordinators.applyFactView(...args);
  const refreshFactGroups = (...args) => coordinators.refreshFactGroups(...args);
  const openFactGroup = (...args) => coordinators.openFactGroup(...args);
  const saveFactGroup = (...args) => coordinators.saveFactGroup(...args);
  const deleteFactGroup = (...args) => coordinators.deleteFactGroup(...args);
  const addRepeaterItem = (...args) => coordinators.addRepeaterItem(...args);
  const markFactDirty = (...args) => coordinators.markFactDirty(...args);
  const refreshProfile = (...args) => coordinators.refreshProfile(...args);
  const saveFacts = (...args) => coordinators.saveFacts(...args);
  const resolveFactConflicts = (...args) => coordinators.resolveFactConflicts(...args);
  const renderTrash = (...args) => coordinators.renderTrash(...args);
  const refreshTrash = (...args) => coordinators.refreshTrash(...args);
  const openTrashDelete = (...args) => coordinators.openTrashDelete(...args);
  const submitTrashDelete = (...args) => coordinators.submitTrashDelete(...args);
  const refreshAutomation = (...args) => coordinators.refreshAutomation(...args);
  const refreshAccountOperation = (...args) => coordinators.refreshAccountOperation(...args);
  const recoverAccountOperation = (...args) => coordinators.recoverAccountOperation(...args);
  const saveAutomation = (...args) => coordinators.saveAutomation(...args);
  const copyProfileEmailToAutomation = (...args) => coordinators.copyProfileEmailToAutomation(...args);
  const addEmployerRealm = (...args) => coordinators.addEmployerRealm(...args);
  const approveTrustedFill = (...args) => coordinators.approveTrustedFill(...args);
  const loadTrustedFillStatus = (...args) => coordinators.loadTrustedFillStatus(...args);
  const revokeTrustedFill = (...args) => coordinators.revokeTrustedFill(...args);
  const showWorkspace = (...args) => coordinators.showWorkspace(...args);
  const navigateWorkspace = (...args) => coordinators.navigateWorkspace(...args);
  const attentionButton = (...args) => coordinators.attentionButton(...args);
  const refreshAttention = (...args) => coordinators.refreshAttention(...args);
  const answerError = (...args) => coordinators.answerError(...args);
  const setAnswerBusy = (...args) => coordinators.setAnswerBusy(...args);
  const refreshAnswers = (...args) => coordinators.refreshAnswers(...args);
  const syncSensitiveConsent = (...args) => coordinators.syncSensitiveConsent(...args);
  const newAnswer = (...args) => coordinators.newAnswer(...args);
  const saveAnswer = (...args) => coordinators.saveAnswer(...args);
  const answerAction = (...args) => coordinators.answerAction(...args);
  const mergeCandidates = (...args) => coordinators.mergeCandidates(...args);
  const openAnswerMerge = (...args) => coordinators.openAnswerMerge(...args);
  const submitAnswerMerge = (...args) => coordinators.submitAnswerMerge(...args);
  const openAnswerCleanup = (...args) => coordinators.openAnswerCleanup(...args);
  const submitAnswerCleanup = (...args) => coordinators.submitAnswerCleanup(...args);
  const resumeError = (...args) => coordinators.resumeError(...args);
  const copyExtractionHandoff = (...args) => coordinators.copyExtractionHandoff(...args);
  const runExtractionAction = (...args) => coordinators.runExtractionAction(...args);
  const refreshResumes = (...args) => coordinators.refreshResumes(...args);
  const renderResumeDialog = (...args) => coordinators.renderResumeDialog(...args);
  const requestFreshForProposal = (...args) => coordinators.requestFreshForProposal(...args);
  const uploadEnvelope = (...args) => coordinators.uploadEnvelope(...args);
  const mutateResume = (...args) => coordinators.mutateResume(...args);
  const mutateResumeFile = (...args) => coordinators.mutateResumeFile(...args);
  const submitProposalReview = (...args) => coordinators.submitProposalReview(...args);
  const render = (...args) => coordinators.render(...args);
  const refresh = (...args) => coordinators.refresh(...args);
  const fillForm = (...args) => coordinators.fillForm(...args);
  const openNew = (...args) => coordinators.openNew(...args);
  const showFormError = (...args) => coordinators.showFormError(...args);
  const hideConflict = (...args) => coordinators.hideConflict(...args);
  const showConflict = (...args) => coordinators.showConflict(...args);
  const save = (...args) => coordinators.save(...args);
  const preflight = (...args) => coordinators.preflight(...args);
  const transition = (...args) => coordinators.transition(...args);
  const renderJobControls = (...args) => coordinators.renderJobControls(...args);
  const invalidateGroupedApprovalPreview = (...args) => coordinators.invalidateGroupedApprovalPreview(...args);
  const previewGroupedApproval = (...args) => coordinators.previewGroupedApproval(...args);
  const approveGroupedApproval = (...args) => coordinators.approveGroupedApproval(...args);
  const loadActivity = (...args) => coordinators.loadActivity(...args);
  const jobButton = (...args) => coordinators.jobButton(...args);
  const closeJobDialog = (...args) => coordinators.closeJobDialog(...args);
  async function pollWorkspace() {
    refreshOverview({ quiet: true }); refreshAttention({ quiet: true });
    if (dialog.open && state.selected) loadActivity();
    await refresh({ quiet: true });
    if (dialog.open && state.selected) {
      const listed = state.jobs.find((job) => job.id === state.selected.id);
      if (state.canonicalStateCurrent && listed?.status === "ready" && !state.preflightPolling) {
        state.preflightPolling = true;
        try {
          await preflight({ clearAtStart: false });
        } finally {
          state.preflightPolling = false;
        }
      }
    }
    if (resumeState.loaded) refreshResumes({ quiet: true });
    if (trashState.loaded) refreshTrash({ quiet: true });
    if (factGroupState.loaded) refreshFactGroups({ quiet: true });
  }

  function ensureWorkspacePolling() {
    if (state.pollIntervalId !== null) return;
    state.pollIntervalId = setInterval(pollWorkspace, 4000);
  }
  function firstListDestination() { return $(".job-card") || $("#new-job"); }

  form.addEventListener("submit", save); form.addEventListener("input", (event) => { if (state.selected && event.target.name) { state.dirty = true; state.dirtyFields.add(event.target.name); } });
  $("#nav-overview").addEventListener("click", () => navigateWorkspace("overview")); $("#nav-jobs").addEventListener("click", () => navigateWorkspace("jobs")); $("#nav-attention").addEventListener("click", () => navigateWorkspace("attention")); $("#nav-facts").addEventListener("click", () => navigateWorkspace("facts")); $("#nav-resumes").addEventListener("click", () => navigateWorkspace("resumes")); $("#nav-answers").addEventListener("click", () => navigateWorkspace("answers")); $("#nav-automation").addEventListener("click", () => navigateWorkspace("automation")); $("#nav-trash").addEventListener("click", () => navigateWorkspace("trash"));
  $("#automation-refresh").addEventListener("click", () => refreshAutomation());
  $("#automation-form").addEventListener("submit", saveAutomation);
  $("#automation-copy-profile-email").addEventListener("click", copyProfileEmailToAutomation);
  $("#automation-clear-email").addEventListener("click", (event) => saveAutomation(event, true));
  $("#account-operation-refresh").addEventListener("click", refreshAccountOperation);
  $("#account-operation-recover").addEventListener("click", recoverAccountOperation);
  $("#realm-form").addEventListener("submit", addEmployerRealm);
  $("#trusted-fill-form").addEventListener("submit", approveTrustedFill);
  $("#trusted-fill-status-form").addEventListener("submit", loadTrustedFillStatus);
  $("#trusted-fill-revoke").addEventListener("click", revokeTrustedFill);
  $("#overview-refresh").addEventListener("click", () => refreshOverview());
  $("#next-step-action").addEventListener("click", (event) => navigateWorkspace(event.currentTarget.dataset.workspace));
  for (const button of document.querySelectorAll(".overview-link")) button.addEventListener("click", () => navigateWorkspace(button.dataset.workspace));
  for (const button of document.querySelectorAll(".copy-invocation")) button.addEventListener("click", () => copyInvocation(button));
  $("#attention-refresh").addEventListener("click", () => refreshAttention());
  $("#trash-refresh").addEventListener("click", () => refreshTrash()); $("#trash-type-filter").addEventListener("change", renderTrash);
  $("#trash-delete-input").addEventListener("input", () => { $("#trash-delete-confirm").disabled = $("#trash-delete-input").value !== typedDeletePhrase(trashState.selected?.type); });
  $("#trash-delete-form").addEventListener("submit", submitTrashDelete);
  $("#trash-conflict-refresh").addEventListener("click", async () => { $("#trash-delete-dialog").close(); await refreshTrash({ quiet: true }); $("#trash-list").focus(); });
  $("#answers-cleanup").addEventListener("click", openAnswerCleanup); $("#answers-refresh").addEventListener("click", () => refreshAnswers()); $("#answer-new").addEventListener("click", newAnswer); $("#answer-search").addEventListener("input", () => refreshAnswers({ reset: true })); $("#answer-view").addEventListener("change", () => refreshAnswers({ reset: true })); $("#answer-state-filter").addEventListener("change", () => refreshAnswers({ reset: true }));
  $("#answers-previous").addEventListener("click", () => { answerState.offset = Math.max(0, answerState.offset - answerState.limit); refreshAnswers(); }); $("#answers-next").addEventListener("click", () => { answerState.offset += answerState.limit; refreshAnswers(); });
  $("#answer-form").addEventListener("submit", saveAnswer); $("#answer-form").addEventListener("input", (event) => { if (event.target.name && event.target.name !== "rememberSensitive") answerState.dirty.add(event.target.name); if (["state", "sensitivity"].includes(event.target.name)) syncSensitiveConsent(); });
  $("#answer-reveal").addEventListener("click", async () => { const requestedKey = answerState.selected.key; const dialogGeneration = answerState.dialogGeneration; setAnswerBusy(true); try { const revealed = await api(answerApiPath(requestedKey, "reveal"), { method: "POST", body: "{}" }); if (!canApplyAnswerDialogResponse(answerState.selected, requestedKey, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open)) return; if (!canApplyAnswerReveal(answerState.selected, requestedKey, revealed)) { answerError("This answer changed identity while its value was being revealed. Nothing was placed in the dialog; close it and review the canonical answer.", true); return; } $("#answer-form").elements.value.value = revealed.value ?? ""; $("#answer-reveal").classList.add("hidden"); toast("Sensitive value revealed for this dialog"); } catch (error) { if (canApplyAnswerDialogResponse(answerState.selected, requestedKey, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open)) answerError(error.message, true); } finally { if (canApplyAnswerDialogResponse(answerState.selected, requestedKey, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open)) setAnswerBusy(false); } });
  $("#answer-merge").addEventListener("click", openAnswerMerge); $("#answer-merge-form").addEventListener("submit", submitAnswerMerge);
  $("#answer-cleanup-form").addEventListener("submit", submitAnswerCleanup);
  $("#answer-cleanup-dialog").addEventListener("close", () => { answerState.cleanupPreview = null; });
  $("#answer-merge-dialog").addEventListener("close", () => { if ($("#answer-merge-dialog").open) return; answerState.mergeRequestSequence += 1; answerState.mergeSource = null; answerState.mergeCandidates = []; });
  $("#answer-accept").addEventListener("click", () => answerAction("accept")); $("#answer-decline").addEventListener("click", () => answerAction("decline")); $("#answer-trash").addEventListener("click", () => { if (confirm("Move this answer to trash?")) answerAction("trash"); }); $("#answer-restore").addEventListener("click", () => answerAction("restore")); $("#answer-delete").addEventListener("click", () => openTrashDelete({ type: "answer", id: answerState.selected.key, revision: answerState.selected.revision, label: answerState.selected.question || answerState.selected.key }, $("#answer-delete")));
  $("#answer-conflict-refresh").addEventListener("click", async () => { const selected = answerState.selected; const dialogGeneration = answerState.dialogGeneration; setAnswerBusy(true); try { const latest = await api(answerApiPath(selected.key)); if (!canApplyAnswerDialogResponse(answerState.selected, selected.key, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open)) return; if (!canRefreshAnswerDraft(selected, latest)) { answerError("This source answer changed identity while its canonical revision was being refreshed. Its preserved draft was not retargeted; close this dialog and review the current answer separately.", true); return; } answerState.selected = latest; $("#answer-conflict").classList.add("hidden"); $("#answer-kicker").textContent = `CANONICAL · REVISION ${answerState.selected.revision} · DRAFT PRESERVED`; toast("Canonical revision refreshed; review your preserved draft"); } catch (error) { if (canApplyAnswerDialogResponse(answerState.selected, selected.key, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open)) answerError(error.message, true); } finally { if (canApplyAnswerDialogResponse(answerState.selected, selected.key, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open)) setAnswerBusy(false); } });
  $("#answer-dialog").addEventListener("close", () => { if ($("#answer-dialog").open) return; setAnswerBusy(false); answerState.dialogGeneration += 1; answerState.mergeRequestSequence += 1; answerState.mergeSource = null; answerState.selected = null; answerState.dirty.clear(); $("#answer-form").elements.value.value = ""; $("#answer-form").elements.rememberSensitive.checked = false; const pendingJobId = answerState.pendingJobId; const pendingReference = answerState.pendingReference; const target = answerState.opener?.isConnected ? answerState.opener : $("#answer-new"); answerState.pendingJobId = null; answerState.pendingReference = null; answerState.opener = null; if (pendingJobId && dialog.open && state.selected?.id === pendingJobId) { Promise.all([loadActivity(pendingJobId, { announce: false }), refreshAttention({ quiet: true })]).finally(() => { const refreshedTarget = pendingReference ? document.querySelector(`[data-pending-reference="${CSS.escape(pendingReference)}"]`) : null; if (dialog.open && state.selected?.id === pendingJobId) (target?.isConnected ? target : refreshedTarget)?.focus(); }); } else target.focus(); });
  $("#resumes-refresh").addEventListener("click", () => refreshResumes());
  $("#resumes-active").addEventListener("click", async () => { resumeState.trash = false; await refreshResumes(); });
  $("#resumes-trash").addEventListener("click", async () => { resumeState.trash = true; await refreshResumes(); });
  $("#resume-import").addEventListener("submit", async (event) => { event.preventDefault(); const current = event.currentTarget; const file = current.elements.file.files[0]; if (!file) return; try { const envelope = await uploadEnvelope(file, { label: current.elements.label.value, tags: tagsFromInput(current.elements.tags.value) }); await api("/api/resumes/import", { method: "POST", body: JSON.stringify(envelope) }); current.reset(); await refresh({ quiet: true }); await refreshResumes({ quiet: true }); toast("Resume imported into managed storage"); } catch (error) { resumeError(error.message); } });
  $("#resume-form").addEventListener("input", (event) => { if (event.target.name === "label" || event.target.name === "tags") resumeState.dirtyMetadata.add(event.target.name); });
  $("#resume-form").addEventListener("submit", async (event) => { event.preventDefault(); const resume = resumeState.selected; const patch = {}; if (resumeState.dirtyMetadata.has("label")) patch.label = event.currentTarget.elements.label.value; if (resumeState.dirtyMetadata.has("tags")) patch.tags = tagsFromInput(event.currentTarget.elements.tags.value); if (!Object.keys(patch).length) { resumeError("Change a metadata field before saving.", true); return; } try { await api(`/api/resumes/${encodeURIComponent(resume.id)}`, { method: "PATCH", body: JSON.stringify({ patch, expectedRevision: resume.revision }) }); resumeState.dirtyMetadata.clear(); await refreshResumes({ quiet: true }); $("#resume-dialog").close(); toast("Resume metadata saved"); } catch (error) { if (error.status === 409) { $("#resume-conflict").classList.remove("hidden"); $("#resume-conflict").focus(); } else resumeError(error.message, true); } });
  $("#resume-replace").addEventListener("click", () => mutateResumeFile("replace"));
  $("#resume-adopt").addEventListener("click", () => mutateResumeFile("adopt"));
  $("#resume-default").addEventListener("click", () => mutateResume("default")); $("#resume-trash-action").addEventListener("click", () => { if (confirm("Move this resume to Trash? Assigned/default resume guards still apply.")) mutateResume("trash"); }); $("#resume-restore").addEventListener("click", () => mutateResume("restore")); $("#resume-delete").addEventListener("click", () => openTrashDelete({ type: "resume", id: resumeState.selected.id, revision: resumeState.selected.revision, label: resumeState.selected.label || resumeState.selected.id }, $("#resume-delete")));
  $("#resume-conflict-refresh").addEventListener("click", async () => { try { const latest = await api(`/api/resumes/${encodeURIComponent(resumeState.selected.id)}`); renderResumeDialog(latest, true); $("#resume-conflict").classList.add("hidden"); $("#resume-form").elements.label.focus(); toast("Canonical revision refreshed; your draft and file selection were preserved"); } catch (error) { resumeError(error.message, true); } });
  $("#resume-extraction-action").addEventListener("click", () => runExtractionAction(resumeState.selected, $("#resume-extraction-action").dataset.action));
  $("#resume-handoff-copy").addEventListener("click", () => copyExtractionHandoff(resumeState.selected.extractionRequest, $("#resume-handoff-fallback")));
  $("#resume-content").addEventListener("click", async () => { const resume = resumeState.selected; try { const response = await fetch(`/api/resumes/${encodeURIComponent(resume.id)}/content`, { headers: { Authorization: `Bearer ${token}` } }); if (!response.ok) { let payload = null; try { payload = await response.json(); } catch {} throw new ApiError(response.status, payload); } if (resume.mediaType?.startsWith("text/plain")) { $("#resume-preview").textContent = await response.text(); $("#preview-dialog").showModal(); } else { const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.target = "_blank"; link.rel = "noopener"; if (resume.mediaType?.includes("wordprocessingml")) link.download = `resume-${resume.id}.docx`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000); } } catch (error) { resumeError(error.message, true); } });
  $("#proposal-keep-all").addEventListener("click", () => { for (const select of $("#proposal-form").querySelectorAll("select[name]")) select.value = "keep_current"; $("#proposal-error").classList.add("hidden"); });
  $("#proposal-request-fresh").addEventListener("click", requestFreshForProposal);
  $("#proposal-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const proposal = resumeState.proposal; const decisions = {}; const replacementConfirmations = {}; const replacementLabels = [];
    for (const select of event.currentTarget.querySelectorAll("select[name]")) if (select.value) decisions[select.name] = select.value;
    if (!Object.keys(decisions).length) { $("#proposal-error").textContent = "Select at least one decision."; $("#proposal-error").classList.remove("hidden"); return; }
    for (const [path, decision] of Object.entries(decisions)) {
      if (decision !== "use_extracted") continue;
      const replacement = proposal.replacementScopes?.[path];
      if (replacement) {
        const checkbox = event.currentTarget.querySelector(`[data-replacement-path="${CSS.escape(path)}"]`);
        if (!checkbox?.checked) { $("#proposal-error").textContent = `Confirm that accepting ${path} replaces ${replacement.path}.`; $("#proposal-error").classList.remove("hidden"); return; }
        replacementConfirmations[path] = replacement.path; replacementLabels.push(`${path} replaces ${replacement.path}`);
      }
      if (["/workHistory", "/education", "/skills"].includes(path)) replacementLabels.push(`${path} replaces the whole collection`);
    }
    const packet = { decisions, replacementConfirmations };
    if (replacementLabels.length) { resumeState.pendingReview = packet; $("#replacement-confirm-copy").textContent = `Using these extracted values replaces the whole current scope: ${replacementLabels.join("; ")}. This cannot preserve individual entries in those scopes.`; $("#replacement-confirm-dialog").showModal(); $("#replacement-confirm-submit").focus(); return; }
    await submitProposalReview(packet);
  });
  $("#replacement-confirm-form").addEventListener("submit", async (event) => { event.preventDefault(); if (resumeState.pendingReview) await submitProposalReview(resumeState.pendingReview); });
  for (const button of document.querySelectorAll("#fact-group-nav > [data-fact-view]")) button.addEventListener("click", () => applyFactView(button.dataset.factView));
  $("#fact-group-new").addEventListener("click", (event) => openFactGroup(null, event.currentTarget));
  $("#fact-group-edit").addEventListener("click", (event) => { const group = factGroupState.items.find((item) => `custom:${item.id}` === factGroupState.selectedView); if (group) openFactGroup(group, event.currentTarget); });
  $("#fact-group-form").addEventListener("submit", saveFactGroup);
  $("#fact-group-delete").addEventListener("click", deleteFactGroup);
  $("#fact-group-dialog").addEventListener("close", () => { factGroupState.editing = null; const target = factGroupState.opener?.isConnected ? factGroupState.opener : $("#fact-group-new"); factGroupState.opener = null; target.focus(); });
  $("#facts-form").addEventListener("input", (event) => { const control = event.target.closest("[data-path]"); if (control) markFactDirty(control); });
  $("#add-work").addEventListener("click", () => addRepeaterItem("/workHistory")); $("#add-education").addEventListener("click", () => addRepeaterItem("/education"));
  $("#facts-save").addEventListener("click", saveFacts); $("#facts-refresh").addEventListener("click", () => refreshProfile());
  $("#facts-use-latest").addEventListener("click", () => resolveFactConflicts(false)); $("#facts-use-mine").addEventListener("click", () => resolveFactConflicts(true));
  $("#new-job").addEventListener("click", openNew); $("#empty-create").addEventListener("click", openNew); $("#refresh").addEventListener("click", () => refresh());
  $("#search").addEventListener("input", render); $("#status-filter").addEventListener("change", render);
  $("#preflight-job").addEventListener("click", preflight); $("#mark-ready").addEventListener("click", async () => { const result = await preflight(); if (result?.ready) transition("ready"); });
  $("#activity-approval-preview").addEventListener("click", previewGroupedApproval); $("#activity-approval-confirm").addEventListener("click", approveGroupedApproval);
  $("#activity-approval-fields").addEventListener("change", invalidateGroupedApprovalPreview);
  $("#trash-job").addEventListener("click", async () => { if (!confirm("Move this job to trash? It will leave this Jobs workspace, but remains recoverable through the canonical store.")) return; try { const id = state.selected.id; await api(`/api/jobs/${encodeURIComponent(id)}/trash`, { method: "POST", body: JSON.stringify({ expectedRevision: state.selected.revision }) }); await refresh({ quiet: true }); closeJobDialog(firstListDestination()); toast("Job moved to trash"); } catch (error) { if (error.code === "revision_conflict") await showConflict(); else showFormError(lifecycleErrorText(error)); } });
  $("#reload-latest").addEventListener("click", () => { if (!state.latest) return; state.selected = state.latest; state.draft = null; fillForm(state.latest); renderJobControls(state.latest); $("#dialog-kicker").textContent = `CANONICAL · REVISION ${state.latest.revision}`; form.elements.role.focus(); toast("Loaded the latest canonical values"); });
  $("#rebase-draft").addEventListener("click", () => { if (!state.latest || !state.draft) return; const latest = state.latest; const draft = state.draft; state.selected = latest; fillForm(latest); renderJobControls(latest); for (const [name, value] of Object.entries(draft)) if (form.elements[name]) form.elements[name].value = value; state.dirtyFields = new Set(Object.keys(draft)); state.dirty = state.dirtyFields.size > 0; state.draft = null; hideConflict(); $("#save-job").focus(); toast("Your edited fields were reapplied to the latest canonical values. Review, then save."); });
  for (const button of document.querySelectorAll("[data-close]")) button.addEventListener("click", () => document.getElementById(button.dataset.close).close());
  $("#bulk-open").addEventListener("click", () => { $("#bulk-results").replaceChildren(); $("#bulk-dialog").showModal(); setTimeout(() => $("#bulk-form").elements.urls.focus(), 0); });
  $("#bulk-form").addEventListener("submit", async (event) => { event.preventDefault(); const urls = event.currentTarget.elements.urls.value.split(/\r?\n/).map((v) => v.trim()).filter(Boolean); try { const data = await api("/api/jobs/bulk", { method: "POST", body: JSON.stringify({ urls }) }); const holder = $("#bulk-results"); holder.replaceChildren(); for (const item of data.results) { const row = document.createElement("div"); row.className = `bulk-result${item.ok ? "" : " bad"}`; row.textContent = item.ok ? `Saved · ${item.url}` : `Not saved · ${item.url} · ${item.error}`; holder.append(row); } await refresh({ quiet: true }); } catch (error) { const row = document.createElement("div"); row.className = "bulk-result bad"; row.textContent = error.message; $("#bulk-results").replaceChildren(row); } });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeJobDialog();
  });
  dialog.addEventListener("close", () => {
    state.jobDialogGeneration += 1;
    state.preflightRequestSequence += 1;
    clearPreflightReadiness();
    activityRefreshCoordinator.invalidate(); state.activity = null; state.activityJobId = null; state.activityUnavailable = false; $("#activity-live").textContent = "";
    state.dirty = false; state.dirtyFields.clear(); state.draft = null; $("#sync-notice").classList.add("hidden");
    const attentionReturnJobId = state.attentionReturnJobId;
    const attentionReturnGeneration = state.navigationGeneration;
    state.attentionReturnJobId = null;
    const destinationJobId = state.focusAfterCloseJobId || state.focusAfterClose?.dataset?.id || state.openerJobId;
    const destinationFallback = state.focusAfterClose || state.opener || $("#new-job");
    state.focusAfterClose = null; state.focusAfterCloseJobId = null; state.opener = null; state.openerJobId = null;
    render();
    queueMicrotask(() => {
      if (dialog.open || document.querySelector("dialog[open]")) return;
      if (attentionReturnJobId) {
        refreshAttention({ quiet: true }).then(() => {
          if (attentionReturnGeneration !== state.navigationGeneration) return;
          showWorkspace("attention").then(() => (attentionButton(attentionReturnJobId) || $("#nav-attention")).focus());
        });
        return;
      }
      const currentDestination = (destinationJobId ? jobButton(destinationJobId) : null)
        || (destinationFallback?.isConnected ? destinationFallback : null)
        || $("#new-job");
      const active = document.activeElement;
      const unrelatedInteractiveFocus = active instanceof HTMLElement
        && active.isConnected
        && active !== currentDestination
        && active !== destinationFallback
        && !active.closest("dialog:not([open])")
        && active.matches("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable='true'], [tabindex]:not([tabindex='-1'])");
      if (unrelatedInteractiveFocus) return;
      currentDestination?.focus();
    });
  });
  $("#resume-dialog").addEventListener("close", () => { const destination = resumeState.opener?.isConnected ? resumeState.opener : $("#resumes-refresh"); resumeState.selected = null; resumeState.opener = null; setTimeout(() => destination?.focus(), 0); });
  $("#trash-delete-dialog").addEventListener("close", () => { const destination = trashState.opener?.isConnected ? trashState.opener : $("#nav-trash"); trashState.selected = null; trashState.opener = null; setTimeout(() => destination?.focus(), 0); });

  Object.assign(coordinators, { pollWorkspace, ensureWorkspacePolling, firstListDestination });

  if (!token) {
    setConnection(false, "Workspace token missing — restart with the printed URL");
    $("#overview-live").textContent = "Open the complete URL printed by the workspace launcher.";
  } else {
    (async () => {
      try {
        const boot = await api("/api/boot");
        if (boot.status !== "ready") { renderDegradedBoot(boot); return; }
        ensureWorkspacePolling();
        await Promise.all([refreshOverview({ quiet: true }), refresh({ quiet: true }), refreshAttention({ quiet: true }), refreshTrash({ quiet: true })]);
      } catch (error) {
        setConnection(false, error.message);
        $("#overview-live").textContent = `Workspace startup failed: ${error.message}`;
      }
    })();
  }

}
