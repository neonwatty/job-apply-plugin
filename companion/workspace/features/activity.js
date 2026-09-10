import * as helpers from "../lib/helpers.js";

export function installActivity(context) {
  const { api, state: stores, dom, coordinators } = context;
  const {
    job: state,
    answer: answerState,
  } = stores;
  const {
    $,
    form,
    dialog,
    statusLabel,
    toast,
  } = dom;
  const {
    activityRefreshCoordinator,
  } = coordinators;
  const {
    shouldUseActivityResponse,
    newestCanonicalJob,
    activityAnnouncement,
  } = helpers;
  const syncReadyHandoff = (...args) => coordinators.syncReadyHandoff(...args);
  const clearPreflightReadiness = (...args) => coordinators.clearPreflightReadiness(...args);
  const refreshAttention = (...args) => coordinators.refreshAttention(...args);
  const showAnswerDetail = (...args) => coordinators.showAnswerDetail(...args);
  const refresh = (...args) => coordinators.refresh(...args);
  const showFormError = (...args) => coordinators.showFormError(...args);
  const renderJobControls = (...args) => coordinators.renderJobControls(...args);
  const formatActivityTime = (value) => {
    if (!value) return "Not recorded";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  };

  function prepareActivity(job) {
    state.activityUnavailable = false;
    $("#application-activity").classList.remove("hidden");
    $("#activity-current-status").className = `status ${job.status}`;
    $("#activity-current-status").textContent = statusLabel(job.status);
    $("#activity-summary").textContent = `Canonical revision ${job.revision}. Loading durable activity…`;
    $("#activity-claim").textContent = "Checking agent attempt health…";
    $("#activity-recovery").classList.add("hidden");
    $("#activity-progress").classList.add("hidden");
    $("#activity-history-list").replaceChildren();
    $("#activity-history-empty").textContent = "No agent activity has been recorded for this job.";
    $("#activity-history-empty").classList.remove("hidden");
  }

  function renderActivityUnavailable(error) {
    const firstFailure = !state.activityUnavailable;
    state.activityUnavailable = true;
    state.activity = null;
    $("#activity-current-status").className = "status";
    $("#activity-current-status").textContent = "Unavailable";
    $("#activity-summary").textContent = `Durable activity could not be refreshed: ${error.message}`;
    $("#activity-claim").textContent = "Agent attempt information is unavailable until refresh succeeds.";
    $("#activity-recovery").textContent = "";
    $("#activity-recovery").classList.add("hidden");
    $("#activity-progress").classList.add("hidden");
    $("#activity-progress-details").replaceChildren();
    $("#activity-pending").replaceChildren();
    $("#activity-pending-wrap").classList.add("hidden");
    $("#activity-history-list").replaceChildren();
    $("#activity-history-empty").textContent = "Application history is unavailable until refresh succeeds.";
    $("#activity-history-empty").classList.remove("hidden");
    syncReadyHandoff();
    if (firstFailure) $("#activity-live").textContent = "Durable application activity is unavailable.";
  }

  function renderAttentionContract(session) {
    const panel = $("#activity-attention-contract");
    const readiness = session?.readiness;
    const handoff = session?.browserHandoff;
    const blockers = session?.blockers || [];
    panel.classList.toggle("hidden", !session || (!readiness && !handoff && blockers.length === 0));
    $("#activity-readiness").textContent = readiness
      ? `Readiness ${statusLabel(readiness.status)} · ${statusLabel(readiness.evidenceKind)} · attempt revision ${readiness.attemptRevision} · observation revision ${readiness.observationRevision}.`
      : "No readiness proof recorded.";
    $("#activity-browser-handoff").textContent = handoff
      ? `Browser handoff ${statusLabel(handoff.state)} · ${handoff.reasonCode} · revision ${handoff.revision}. No URL, tab, or browser state is retained.`
      : "No browser handoff recorded.";
    const list = $("#activity-blockers"); list.replaceChildren();
    for (const blocker of blockers) {
      const row = document.createElement("li"); row.textContent = `${statusLabel(blocker.type)} · ${blocker.code}`; list.append(row);
    }
    const approvalProjectionSignature = session ? JSON.stringify({
      revision: session.revision,
      approvals: session.approvals || [],
      pendingInformation: (session.pendingInformation || []).map((item) => ({
        reference: item.reference, answerKey: item.answerKey,
        answerRevision: item.answerRevision,
        resolutionEligible: item.resolutionEligible,
        answerSensitivity: item.answerSensitivity,
        state: item.state, sensitive: item.sensitive,
        fieldClass: item.fieldClass,
      })),
    }) : null;
    if (session && state.groupedApprovalProjectionSignature === approvalProjectionSignature) return;
    state.groupedApprovalProjectionSignature = approvalProjectionSignature;
    state.groupedApprovalRequestSequence += 1;
    const eligible = (session?.pendingInformation || []).filter((item) => item.answerKey && item.reference);
    const approvalsByReference = new Map(
      (session?.approvals || []).map((approval) => [approval.reference, approval]),
    );
    const holder = $("#activity-approval-fields"); holder.replaceChildren();
    for (const item of eligible) {
      const approval = approvalsByReference.get(item.reference);
      const sensitive = item.sensitive === true || item.state === "sensitive" || ["personal", "high"].includes(item.answerSensitivity);
      const field = document.createElement("fieldset"); field.dataset.reference = item.reference; field.dataset.answerKey = item.answerKey; field.dataset.sensitive = String(sensitive); field.dataset.useAuthority = approval?.useAuthority || (sensitive ? "per_use" : "accepted_record");
      const legend = document.createElement("legend"); legend.textContent = `${statusLabel(item.fieldClass || "general")} field`;
      const current = document.createElement("label"); current.innerHTML = '<input type="checkbox" data-decision="currentUse"> Use the current canonical answer for this field';
      const remember = document.createElement("label"); remember.innerHTML = '<input type="checkbox" data-decision="remember"> Remember this field decision';
      const policy = document.createElement("label"); policy.textContent = "Reuse policy ";
      const select = document.createElement("select"); select.dataset.decision = "policyMode"; select.append(new Option("Strict", "strict"), new Option("Bounded loose", "bounded_loose")); policy.append(select);
      current.querySelector("input").checked = approval?.currentUse === true;
      remember.querySelector("input").checked = approval?.remember === true;
      select.value = approval?.policyMode || "strict";
      field.append(legend, current, remember, policy); holder.append(field);
    }
    $("#activity-grouped-approval").classList.toggle("hidden", eligible.length === 0);
    state.groupedApprovalPreview = null; state.groupedApprovalRequest = null;
    $("#activity-approval-confirm").classList.add("hidden");
    $("#activity-approval-summary").textContent = session?.approvals?.length
      ? `${session.approvals.length} field-specific approval${session.approvals.length === 1 ? "" : "s"} recorded.`
      : "";
  }

  function groupedApprovalDecisions() {
    return [...$("#activity-approval-fields").querySelectorAll("fieldset")].map((field) => {
      const currentUse = field.querySelector('[data-decision="currentUse"]').checked;
      const defaultAuthority = field.dataset.sensitive === "true" ? "per_use" : "accepted_record";
      return {
        reference: field.dataset.reference,
        answerKey: field.dataset.answerKey,
        currentUse,
        remember: field.querySelector('[data-decision="remember"]').checked,
        policyMode: field.querySelector('[data-decision="policyMode"]').value,
        useAuthority: currentUse ? (field.dataset.useAuthority === "none" ? defaultAuthority : field.dataset.useAuthority || defaultAuthority) : "none",
        allowedSensitiveFieldClasses: [],
      };
    });
  }

  function invalidateGroupedApprovalPreview() {
    state.groupedApprovalRequestSequence += 1;
    state.groupedApprovalPreview = null;
    state.groupedApprovalRequest = null;
    $("#activity-approval-confirm").classList.add("hidden");
    $("#activity-approval-summary").textContent =
      "Selections changed. Preview the current decisions again before approval.";
  }

  async function previewGroupedApproval() {
    if (!state.selected || !state.activity?.session) return;
    const requestSequence = ++state.groupedApprovalRequestSequence;
    const jobId = state.selected.id;
    const jobRevision = state.activity.job.revision;
    const sessionRevision = state.activity.session.revision;
    const decisions = groupedApprovalDecisions();
    try {
      const preview = await api(`/api/jobs/${encodeURIComponent(jobId)}/approval-preview`, {
        method: "POST", body: JSON.stringify({
          expectedJobRevision: jobRevision,
          expectedSessionRevision: sessionRevision,
          decisions,
        }),
      });
      if (
        requestSequence !== state.groupedApprovalRequestSequence
        || state.selected?.id !== jobId
        || state.activity?.job?.revision !== jobRevision
        || state.activity?.session?.revision !== sessionRevision
      ) return;
      state.groupedApprovalPreview = preview; state.groupedApprovalRequest = decisions;
      $("#activity-approval-summary").textContent = `${preview.approvals.filter((item) => item.eligible).length} of ${preview.approvals.length} current-use decisions are eligible. Review, then approve this exact preview.`;
      $("#activity-approval-confirm").classList.remove("hidden");
    } catch (error) {
      if (requestSequence === state.groupedApprovalRequestSequence) {
        $("#activity-approval-summary").textContent = error.message;
      }
    }
  }

  async function approveGroupedApproval() {
    const preview = state.groupedApprovalPreview;
    if (!preview || !state.selected || !state.activity?.session) return;
    try {
      await api(`/api/jobs/${encodeURIComponent(state.selected.id)}/approval-approve`, {
        method: "POST", body: JSON.stringify({
          expectedJobRevision: preview.jobRevision,
          expectedSessionRevision: preview.sessionRevision,
          decisions: state.groupedApprovalRequest,
          previewToken: preview.previewToken,
          ownerConfirmed: true,
        }),
      });
      await loadActivity(state.selected.id, { announce: false });
      toast("Exact grouped approval recorded without changing the answer library");
    } catch (error) { $("#activity-approval-summary").textContent = error.message; }
  }

  function renderActivity(activity, announce = true) {
    const listed = state.jobs.find((job) => job.id === state.selected?.id);
    if (state.activeJobsLoaded && !listed) {
      state.readyHandoffProof = null;
      syncReadyHandoff();
      return;
    }
    if (!shouldUseActivityResponse(activity, state.selected, listed, state.latest, state.activity?.job)) return;
    const recovered = state.activityUnavailable;
    state.activityUnavailable = false;
    const previous = state.activityJobId === state.selected?.id ? state.activity : null;
    state.activity = activity; state.activityJobId = state.selected?.id || null;
    const status = activity.job.status;
    $("#activity-current-status").className = `status ${status}`;
    $("#activity-current-status").textContent = statusLabel(status);
    $("#activity-summary").textContent = `Canonical status ${statusLabel(status)} · revision ${activity.job.revision}.`;

    const claimCopy = {
      active: `Agent attempt active. Last heartbeat ${formatActivityTime(activity.claim.heartbeatAt)}; lease ends ${formatActivityTime(activity.claim.expiresAt)}.`,
      expired: `Agent attempt interrupted: its lease expired ${formatActivityTime(activity.claim.expiresAt)}.`,
      interrupted: "Agent attempt interrupted: this in-progress job has no active lease.",
      none: "No agent currently owns this job.",
    };
    $("#activity-claim").textContent = claimCopy[activity.claim.state] || "Agent attempt state unavailable.";
    const recovery = $("#activity-recovery");
    recovery.textContent = activity.claim.recoveryGuidance || "";
    recovery.classList.toggle("hidden", !activity.claim.recoveryGuidance);

    const progress = $("#activity-progress");
    if (activity.session) {
      progress.classList.remove("hidden");
      const details = $("#activity-progress-details"); details.replaceChildren();
      for (const [label, value] of [["State", statusLabel(activity.session.status)], ["Step", activity.session.step || "Not recorded"], ["Started", formatActivityTime(activity.session.createdAt)], ["Updated", formatActivityTime(activity.session.updatedAt)]]) {
        const term = document.createElement("dt"); term.textContent = label;
        const description = document.createElement("dd"); description.textContent = value;
        details.append(term, description);
      }
      const pending = $("#activity-pending"); pending.replaceChildren();
      for (const item of activity.session.pendingInformation || []) {
        const row = document.createElement("li");
        const text = document.createElement("span");
        text.textContent = `${item.question || "Information requested"} · ${statusLabel(item.state || "missing")}${item.sensitive ? " · sensitive" : ""}`;
        const actions = document.createElement("span"); actions.className = "pending-actions";
        const edit = document.createElement("button"); edit.type = "button"; edit.className = "button secondary"; edit.textContent = "Open in Answers";
        edit.dataset.pendingReference = item.reference;
        edit.addEventListener("click", () => openPendingAnswerEditor(item)); actions.append(edit);
        if (item.resolutionEligible && Number.isInteger(item.answerRevision)) {
          const recheck = document.createElement("button"); recheck.type = "button"; recheck.className = "button accent"; recheck.textContent = "Recheck this revision";
          recheck.dataset.pendingReference = item.reference;
          recheck.addEventListener("click", () => recheckPendingAnswer(item, recheck)); actions.append(recheck);
        }
        row.append(text, actions);
        pending.append(row);
      }
      $("#activity-pending-wrap").classList.toggle("hidden", pending.children.length === 0);
      renderAttentionContract(activity.session);
    } else {
      progress.classList.add("hidden");
      renderAttentionContract(null);
    }

    const historyList = $("#activity-history-list"); historyList.replaceChildren();
    for (const event of activity.history) {
      const row = document.createElement("li");
      const summary = document.createElement("strong"); summary.textContent = `${statusLabel(event.event)}${event.status ? ` · ${statusLabel(event.status)}` : ""}`;
      const at = document.createElement("time"); at.dateTime = event.at || ""; at.textContent = formatActivityTime(event.at);
      row.append(summary, at); historyList.append(row);
    }
    $("#activity-history-empty").textContent = "No agent activity has been recorded for this job.";
    $("#activity-history-empty").classList.toggle("hidden", historyList.children.length !== 0);

    if (state.selected && (state.selected.status !== status || state.selected.revision !== activity.job.revision)) {
      $("#dialog-kicker").textContent = `${statusLabel(status).toUpperCase()} · REVISION ${activity.job.revision}`;
      renderJobControls({ ...state.selected, status, revision: activity.job.revision });
    }
    syncReadyHandoff();
    const message = recovered
      ? "Durable application activity is available again."
      : activityAnnouncement(previous, activity);
    if (announce && message) $("#activity-live").textContent = message;
  }

  async function openPendingAnswerEditor(item) {
    if (!dialog.open || !state.selected || !item.reference) return;
    const jobId = state.selected.id;
    const jobDialogGeneration = state.jobDialogGeneration;
    const opener = document.activeElement;
    const requestSequence = ++answerState.detailRequestSequence;
    try {
      const selected = await api(`/api/jobs/${encodeURIComponent(jobId)}/pending-answers/${encodeURIComponent(item.reference)}`);
      if (requestSequence !== answerState.detailRequestSequence || !dialog.open || state.selected?.id !== jobId || state.jobDialogGeneration !== jobDialogGeneration) return;
      showAnswerDetail(selected, opener, jobId, item.reference);
    } catch (error) {
      if (requestSequence === answerState.detailRequestSequence && dialog.open && state.selected?.id === jobId && state.jobDialogGeneration === jobDialogGeneration) showFormError(error.message);
    }
  }

  async function recheckPendingAnswer(item, button) {
    if (!state.selected || !state.activity?.session || !item.reference) return;
    button.disabled = true;
    try {
      const result = await api(`/api/jobs/${encodeURIComponent(state.selected.id)}/resolve-pending-answer`, {
        method: "POST",
        body: JSON.stringify({
          reference: item.reference,
          expectedJobRevision: state.activity.job.revision,
          expectedSessionRevision: state.activity.session.revision,
          expectedAnswerRevision: item.answerRevision,
          ownerConfirmed: true,
        }),
      });
      state.selected = { ...state.selected, status: result.job.status, revision: result.job.revision };
      const index = state.jobs.findIndex((job) => job.id === state.selected.id);
      if (index !== -1) state.jobs[index] = newestCanonicalJob(state.jobs[index], state.selected);
      await Promise.all([loadActivity(state.selected.id), refreshAttention({ quiet: true }), refresh({ quiet: true })]);
      toast(result.ready ? "Question resolved; the exact job is Ready" : "Question resolved; other blockers remain");
    } catch (error) {
      if (error.status === 409 || error.code === "revision_conflict") {
        $("#form-error").textContent = "Canonical state changed. Your job draft is preserved; review the refreshed pending question before rechecking.";
        $("#form-error").classList.remove("hidden");
        await loadActivity(state.selected.id, { announce: false });
      } else {
        $("#form-error").textContent = error.message; $("#form-error").classList.remove("hidden");
      }
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  }

  function loadActivity(jobId = state.selected?.id, { announce = true } = {}) {
    if (!jobId) return Promise.resolve(false);
    return activityRefreshCoordinator.run(
      () => api(`/api/jobs/${encodeURIComponent(jobId)}/activity`),
      (activity) => {
        if (!dialog.open || state.selected?.id !== jobId) return;
        renderActivity(activity, announce);
      },
      (error) => {
        if (!dialog.open || state.selected?.id !== jobId) return;
        if (error.status === 404 || error.code === "not_found") {
          state.preflightRequestSequence += 1;
          clearPreflightReadiness({ hidePanel: false });
        }
        renderActivityUnavailable(error);
      },
    );
  }

  function jobButton(id) { return document.querySelector(`[data-id="${CSS.escape(id)}"]`); }
  function rememberOpener(jobId = null, opener = null) {
    state.opener = opener || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    state.openerJobId = jobId;
    state.focusAfterClose = null;
    state.focusAfterCloseJobId = null;
  }
  function closeJobDialog(destination = null, destinationJobId = null) {
    state.focusAfterClose = destination;
    state.focusAfterCloseJobId = destinationJobId || destination?.dataset?.id || null;
    dialog.close();
  }


  Object.assign(coordinators, { formatActivityTime, prepareActivity, renderActivityUnavailable, renderAttentionContract, groupedApprovalDecisions, invalidateGroupedApprovalPreview, previewGroupedApproval, approveGroupedApproval, renderActivity, openPendingAnswerEditor, recheckPendingAnswer, loadActivity, jobButton, rememberOpener, closeJobDialog });
}
