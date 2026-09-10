import * as helpers from "../lib/helpers.js";

export function installNavigation(context) {
  const { api, state: stores, dom, coordinators } = context;
  const {
    job: state,
    profile: profileState,
    factGroup: factGroupState,
    resume: resumeState,
    answer: answerState,
    trash: trashState,
    attention: attentionState,
    overview: overviewState,
    automation: automationState,
  } = stores;
  const {
    $,
    statusLabel,
    toast,
    setConnection,
  } = dom;
  const {
    attentionRefreshCoordinator,
  } = coordinators;
  const {
    newestCanonicalJob,
    attentionAnnouncement,
    attentionMissingInformationText,
    attentionBlockerSummary,
  } = helpers;
  const refreshOverview = (...args) => coordinators.refreshOverview(...args);
  const refreshFactGroups = (...args) => coordinators.refreshFactGroups(...args);
  const refreshProfile = (...args) => coordinators.refreshProfile(...args);
  const refreshTrash = (...args) => coordinators.refreshTrash(...args);
  const refreshAutomation = (...args) => coordinators.refreshAutomation(...args);
  const refreshAccountOperation = (...args) => coordinators.refreshAccountOperation(...args);
  const refreshAnswers = (...args) => coordinators.refreshAnswers(...args);
  const refreshResumes = (...args) => coordinators.refreshResumes(...args);
  const refresh = (...args) => coordinators.refresh(...args);
  const openExisting = (...args) => coordinators.openExisting(...args);
  const formatActivityTime = (...args) => coordinators.formatActivityTime(...args);
  async function showWorkspace(name) {
    const overview = name === "overview";
    const attention = name === "attention";
    const facts = name === "facts";
    const resumes = name === "resumes";
    const answers = name === "answers";
    const automation = name === "automation";
    const trash = name === "trash";
    $("#overview-workspace").classList.toggle("hidden", !overview); $("#jobs-workspace").classList.toggle("hidden", overview || attention || facts || resumes || answers || automation || trash); $("#attention-workspace").classList.toggle("hidden", !attention); $("#facts-workspace").classList.toggle("hidden", !facts); $("#resumes-workspace").classList.toggle("hidden", !resumes); $("#answers-workspace").classList.toggle("hidden", !answers); $("#automation-workspace").classList.toggle("hidden", !automation); $("#trash-workspace").classList.toggle("hidden", !trash);
    for (const section of ["overview", "jobs", "attention", "facts", "resumes", "answers", "automation", "trash"]) { const active = name === section; $(`#nav-${section}`).classList.toggle("active", active); $(`#nav-${section}`).toggleAttribute("aria-current", active); }
    document.title = `${overview ? "Overview" : attention ? "Needs Attention" : facts ? "Facts" : resumes ? "Resumes" : answers ? "Answers" : automation ? "Automation" : trash ? "Trash" : "Jobs"} · Job Apply Workspace`;
    if (overview && !overviewState.available) await refreshOverview({ quiet: true });
    if (attention && !attentionState.loaded) await refreshAttention();
    if (facts && (!profileState.loaded || !factGroupState.loaded)) await Promise.all([
      profileState.loaded ? Promise.resolve() : refreshProfile({ preserve: false }),
      factGroupState.loaded ? Promise.resolve() : refreshFactGroups({ quiet: true }),
    ]);
    if (resumes && !resumeState.loaded) await refreshResumes();
    if (answers && !answerState.loaded) await refreshAnswers();
    if (automation && !automationState.loaded) await Promise.all([refreshAutomation(), refreshAccountOperation()]);
    if (trash && !trashState.loaded) await refreshTrash();
  }

  function navigateWorkspace(name) {
    state.navigationGeneration += 1;
    attentionState.detailRequestSequence += 1;
    return showWorkspace(name);
  }

  function attentionButton(jobId) { return document.querySelector(`[data-attention-id="${CSS.escape(jobId)}"]`); }

  function renderAttention() {
    const list = $("#attention-list");
    const focusedId = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.attentionId : null;
    list.replaceChildren();
    for (const item of attentionState.items) {
      const wrapper = document.createElement("div"); wrapper.className = "attention-item"; wrapper.setAttribute("role", "listitem");
      const button = document.createElement("button"); button.type = "button"; button.className = "attention-card"; button.dataset.attentionId = item.jobId; button.disabled = attentionState.unavailable;
      const heading = document.createElement("h3"); heading.textContent = "Application attention item";
      const reason = document.createElement("strong"); reason.className = `attention-reason ${item.reasonCode}`; reason.textContent = item.reasonLabel;
      const guidance = document.createElement("p"); guidance.textContent = item.guidance;
      const blockers = item.session?.blockers || [];
      const blockerSummary = document.createElement("p"); blockerSummary.className = "attention-question";
      blockerSummary.textContent = attentionBlockerSummary(item);
      const handoff = document.createElement("p"); handoff.className = "attention-company";
      handoff.textContent = item.session?.browserHandoff ? `Browser handoff: ${statusLabel(item.session.browserHandoff.state)} · ${item.session.browserHandoff.reasonCode}` : "Browser handoff not recorded";
      const metadata = document.createElement("p"); metadata.className = "attention-meta";
      const missing = attentionMissingInformationText(item);
      metadata.textContent = `Priority ${item.priority} · ${statusLabel(item.status)} · since ${formatActivityTime(item.attentionAt)}${missing}`;
      const action = document.createElement("span"); action.className = "attention-action"; action.textContent = attentionState.unavailable ? "Unavailable until refresh" : "Open Job details";
      button.append(heading, reason, guidance, blockerSummary, handoff);
      button.append(metadata, action);
      button.addEventListener("click", () => openAttentionJob(item.jobId, button)); wrapper.append(button); list.append(wrapper);
    }
    $("#attention-count").textContent = `${attentionState.items.length} job${attentionState.items.length === 1 ? "" : "s"}`;
    $("#attention-nav-count").textContent = String(attentionState.items.length);
    $("#attention-loading").classList.add("hidden");
    $("#attention-empty").classList.toggle("hidden", attentionState.items.length !== 0 || attentionState.unavailable);
    list.classList.toggle("hidden", attentionState.items.length === 0);
    list.setAttribute("aria-busy", "false");
    $("#attention-unavailable").classList.toggle("hidden", !attentionState.unavailable);
    if (focusedId) attentionButton(focusedId)?.focus();
  }

  async function refreshAttention({ quiet = false } = {}) {
    if (!attentionState.loaded) { $("#attention-loading").classList.remove("hidden"); $("#attention-list").setAttribute("aria-busy", "true"); }
    return attentionRefreshCoordinator.run(
      () => api("/api/attention"),
      (projection) => {
        const previous = attentionState.loaded ? { items: attentionState.items, snapshotSignature: attentionState.snapshotSignature } : null;
        const recovered = attentionState.unavailable;
        attentionState.items = projection.items; attentionState.snapshotSignature = projection.snapshotSignature; attentionState.loaded = true; attentionState.unavailable = false;
        renderAttention(); setConnection(true);
        const announcement = recovered ? "Needs Attention data is available again." : attentionAnnouncement(previous, projection);
        if (announcement) $("#attention-live").textContent = announcement;
        if (!quiet) toast("Needs Attention refreshed from the canonical store");
      },
      (error) => {
        const firstFailure = !attentionState.unavailable;
        attentionState.unavailable = true; renderAttention(); setConnection(false, error.message);
        if (firstFailure) $("#attention-live").textContent = "Needs Attention data is unavailable. Row actions are disabled.";
      },
    );
  }

  async function openAttentionJob(jobId, opener) {
    if (attentionState.unavailable) return;
    const requestSequence = ++attentionState.detailRequestSequence;
    try {
      const detail = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
      if (requestSequence !== attentionState.detailRequestSequence) return;
      const index = state.jobs.findIndex((item) => item.id === jobId);
      const job = newestCanonicalJob(index === -1 ? null : state.jobs[index], detail);
      if (index === -1) state.jobs.push(job); else state.jobs[index] = job;
      state.attentionReturnJobId = jobId;
      await showWorkspace("jobs");
      openExisting(jobId, opener);
    } catch (error) {
      if (requestSequence !== attentionState.detailRequestSequence) return;
      $("#attention-live").textContent = `Job details could not be opened: ${error.message}`;
    }
  }


  Object.assign(coordinators, { showWorkspace, navigateWorkspace, attentionButton, renderAttention, refreshAttention, openAttentionJob });
}
