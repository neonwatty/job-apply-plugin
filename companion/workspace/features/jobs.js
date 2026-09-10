import * as apiHelpers from "../lib/api.js";
import * as helpers from "../lib/helpers.js";

export function installJobs(context) {
  const { api, state: stores, dom, coordinators } = context;
  const {
    job: state,
    jobCardRenderKeys,
  } = stores;
  const {
    $,
    form,
    dialog,
    statusLabel,
    escapeText,
    toast,
    setConnection,
  } = dom;
  const {
    activityRefreshCoordinator,
  } = coordinators;
  const {
    ApiError,
  } = apiHelpers;
  const {
    filterJobs,
    formPatch,
    transitionsFor,
    canMarkReadyFrom,
    newestCanonicalJob,
  } = helpers;
  const freshestKnownJob = (...args) => coordinators.freshestKnownJob(...args);
  const syncReadyHandoff = (...args) => coordinators.syncReadyHandoff(...args);
  const clearPreflightReadiness = (...args) => coordinators.clearPreflightReadiness(...args);
  const prepareActivity = (...args) => coordinators.prepareActivity(...args);
  const loadActivity = (...args) => coordinators.loadActivity(...args);
  const jobButton = (...args) => coordinators.jobButton(...args);
  const rememberOpener = (...args) => coordinators.rememberOpener(...args);
  const closeJobDialog = (...args) => coordinators.closeJobDialog(...args);
  function metrics() {
    $("#metric-active").textContent = state.jobs.length;
    $("#metric-ready").textContent = state.jobs.filter((j) => j.status === "ready").length;
    $("#metric-needs").textContent = state.jobs.filter((j) => j.status === "needs_info").length;
  }

  function render() {
    metrics(); $("#loading").classList.add("hidden");
    if (dialog.open) return;
    const focusedJobId = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.id : null;
    const jobs = filterJobs(state.jobs, $("#search").value, $("#status-filter").value);
    $("#empty").classList.toggle("hidden", jobs.length !== 0);
    $("#job-list").classList.toggle("hidden", jobs.length === 0);
    const list = $("#job-list");
    const existingItems = new Map(
      [...list.querySelectorAll(".job-item")]
        .map((item) => [item.querySelector(".job-card")?.dataset.id, item])
        .filter(([id]) => id),
    );
    const visibleIds = new Set();
    let position = list.firstElementChild;
    for (const job of jobs) {
      visibleIds.add(job.id);
      let item = existingItems.get(job.id);
      let button;
      if (item) {
        button = item.querySelector(".job-card");
      } else {
        item = document.createElement("div"); item.className = "job-item"; item.setAttribute("role", "listitem");
        button = document.createElement("button"); button.type = "button"; button.className = "job-card"; button.dataset.id = job.id;
        button.addEventListener("click", () => openExisting(job.id)); item.append(button);
      }
      const renderKey = JSON.stringify([job.role, job.company, job.location, job.workplaceType, job.priority, job.status]);
      if (jobCardRenderKeys.get(button) !== renderKey) {
        const title = document.createElement("div"); title.className = "job-title";
        const mark = document.createElement("span"); mark.className = "company-mark"; mark.textContent = escapeText(job.company || job.role || "J").slice(0, 1).toUpperCase(); mark.setAttribute("aria-hidden", "true");
        const names = document.createElement("div"); const heading = document.createElement("h3"); heading.textContent = job.role || "Untitled opportunity"; const company = document.createElement("p"); company.textContent = job.company || "Company not set"; names.append(heading, company); title.append(mark, names);
        const location = document.createElement("p"); location.textContent = job.location || job.workplaceType || "Location not set";
        const priority = document.createElement("span"); priority.className = "priority"; priority.textContent = job.priority ? "★".repeat(Math.min(job.priority, 5)) : "—"; priority.setAttribute("aria-label", `Priority ${job.priority || 0}`);
        const status = document.createElement("span"); status.className = `status ${job.status}`; status.textContent = statusLabel(job.status);
        button.replaceChildren(title, location, priority, status);
        jobCardRenderKeys.set(button, renderKey);
      }
      if (item !== position) list.insertBefore(item, position);
      position = item.nextElementSibling;
    }
    for (const [id, item] of existingItems) if (!visibleIds.has(id)) item.remove();
    if (focusedJobId) jobButton(focusedJobId)?.focus();
  }

  function refresh({ quiet = false } = {}) {
    if (state.refreshPromise) return state.refreshPromise;
    state.refreshEpoch += 1;
    state.canonicalStateCurrent = false;
    state.preflightRequestSequence += 1;
    clearPreflightReadiness();
    if (state.preflightError) {
      state.preflightError = null;
      $("#form-error").textContent = "";
      $("#form-error").classList.add("hidden");
    }
    state.refreshPromise = (async () => {
      try {
        const data = await api("/api/state");
        if (state.dirty && state.selected) {
          const latest = data.jobs.find((job) => job.id === state.selected.id);
          if (latest && latest.revision > state.selected.revision) {
            state.latest = latest; $("#sync-notice").textContent = "A canonical job changed while your draft is open. Your draft has not been replaced."; $("#sync-notice").classList.remove("hidden");
          }
        }
        const previousJobs = new Map(state.jobs.map((job) => [job.id, job]));
        state.jobs = data.jobs.map((job) => newestCanonicalJob(previousJobs.get(job.id), job));
        state.activeJobsLoaded = true; state.resumes = data.resumes;
        state.dependencyObservation += 1;
        state.canonicalStateCurrent = true;
        render(); setConnection(true);
        syncReadyHandoff();
        if (!quiet) toast("Jobs refreshed from the canonical store");
      } catch (error) {
        state.canonicalStateCurrent = false;
        setConnection(false, error.message); if (!quiet) showFormError(error.message);
      }
    })().finally(() => { state.refreshPromise = null; });
    return state.refreshPromise;
  }

  function fillResumeOptions(selected) {
    const select = form.elements.resumeId; select.replaceChildren(new Option("Use default resume", ""));
    for (const resume of state.resumes) select.append(new Option(`${resume.label || resume.id}${resume.default ? " · default" : ""}`, resume.id));
    select.value = selected || "";
  }

  function fillForm(job) {
    for (const field of ["url", "role", "company", "location", "workplaceType", "employmentType", "compensation", "notes", "description", "priority"]) form.elements[field].value = job?.[field] ?? (field === "priority" ? 0 : "");
    fillResumeOptions(job?.resumeId); state.dirty = false; state.dirtyFields.clear(); state.preflightError = null; hideConflict(); $("#form-error").classList.add("hidden");
  }

  function openNew() {
    rememberOpener();
    state.jobDialogGeneration += 1;
    state.preflightRequestSequence += 1;
    clearPreflightReadiness();
    state.selected = null; state.latest = null; state.draft = null; fillForm(null); $("#job-dialog-title").textContent = "Capture a job"; $("#dialog-kicker").textContent = "NEW CANONICAL RECORD";
    state.activity = null; state.activityJobId = null; activityRefreshCoordinator.invalidate();
    for (const id of ["trash-job", "preflight-job", "mark-ready", "status-actions", "application-activity", "ready-handoff"]) $("#" + id).classList.add("hidden");
    dialog.showModal(); setTimeout(() => form.elements.url.focus(), 0);
  }

  function openExisting(id, opener = null) {
    const job = state.jobs.find((item) => item.id === id); if (!job) return;
    state.jobDialogGeneration += 1;
    state.preflightRequestSequence += 1;
    clearPreflightReadiness();
    rememberOpener(id, opener);
    state.selected = job; state.latest = null; state.draft = null; fillForm(job); $("#job-dialog-title").textContent = job.role || "Job details"; $("#dialog-kicker").textContent = `${statusLabel(job.status).toUpperCase()} · REVISION ${job.revision}`;
    state.activity = null; state.activityJobId = id; prepareActivity(job); renderJobControls(job); dialog.showModal(); loadActivity(id); if (job.status === "ready") preflight(); setTimeout(() => form.elements.role.focus(), 0);
  }

  function currentValues() { return Object.fromEntries(new FormData(form).entries()); }
  function showFormError(message, preflightError = null) { state.preflightError = preflightError; const node = $("#form-error"); node.textContent = message; node.classList.remove("hidden"); }
  function hideConflict() { $("#conflict").classList.add("hidden"); $("#conflict-latest").replaceChildren(); $("#reload-latest").disabled = false; $("#rebase-draft").disabled = false; }

  async function showConflict() {
    const values = currentValues();
    state.draft = Object.fromEntries([...state.dirtyFields].map((field) => [field, values[field]]));
    const holder = $("#conflict-latest"); holder.replaceChildren();
    $("#reload-latest").disabled = false; $("#rebase-draft").disabled = false;
    try {
      state.latest = await api(`/api/jobs/${encodeURIComponent(state.selected.id)}`);
      syncReadyHandoff();
    } catch (error) {
      state.latest = null;
      const message = document.createElement("p"); message.textContent = `Latest canonical values could not be loaded: ${error.message}. Your draft is still here; try Save again after the connection recovers.`; holder.append(message);
      $("#reload-latest").disabled = true; $("#rebase-draft").disabled = true;
      $("#conflict").classList.remove("hidden"); $("#conflict").focus(); return;
    }
    for (const field of ["url", "role", "company", "location", "workplaceType", "employmentType", "compensation", "notes", "description", "resumeId", "priority", "status", "revision"]) { const span = document.createElement("span"); span.textContent = `${field}: ${state.latest[field] ?? "—"}`; holder.append(span); }
    $("#conflict").classList.remove("hidden"); $("#conflict").focus();
  }

  async function save(event) {
    event.preventDefault(); $("#save-job").disabled = true; $("#form-error").classList.add("hidden");
    try {
      const patch = formPatch(currentValues());
      const job = state.selected
        ? await api(`/api/jobs/${encodeURIComponent(state.selected.id)}`, { method: "PATCH", body: JSON.stringify({ patch, expectedRevision: state.selected.revision }) })
        : await api("/api/jobs", { method: "POST", body: JSON.stringify({ job: patch }) });
      state.selected = job; state.dirty = false; await refresh({ quiet: true }); closeJobDialog(null, job.id); toast("Job saved to the canonical store");
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && state.selected) await showConflict(); else showFormError(error.message);
    } finally { $("#save-job").disabled = false; }
  }

  async function preflight({ clearAtStart = true } = {}) {
    if (!state.selected || !state.canonicalStateCurrent) return null;
    const requestedId = state.selected.id;
    const requestedRevision = freshestKnownJob(requestedId)?.revision;
    const refreshEpoch = state.refreshEpoch;
    const dependencyObservation = state.dependencyObservation;
    const dialogGeneration = state.jobDialogGeneration;
    if (!Number.isInteger(requestedRevision)) return null;
    const requestSequence = ++state.preflightRequestSequence;
    if (clearAtStart) clearPreflightReadiness();
    try {
      const result = await api(`/api/jobs/${encodeURIComponent(requestedId)}/preflight`);
      const current = freshestKnownJob(requestedId);
      if (
        requestSequence !== state.preflightRequestSequence
        || !dialog.open
        || state.selected?.id !== requestedId
        || result.id !== requestedId
        || state.jobDialogGeneration !== dialogGeneration
        || !state.canonicalStateCurrent
        || state.refreshEpoch !== refreshEpoch
        || state.dependencyObservation !== dependencyObservation
        || !current
      ) return null;
      if (current.revision !== requestedRevision || result.revision !== requestedRevision) {
        if (result.revision > current.revision) {
          clearPreflightReadiness({ hidePanel: false });
        }
        return null;
      }
      if (
        state.preflightError?.id === requestedId
        && state.preflightError.requestSequence < requestSequence
      ) {
        state.preflightError = null;
        $("#form-error").textContent = "";
        $("#form-error").classList.add("hidden");
      }
      renderPreflight(result, { dialogGeneration, refreshEpoch, dependencyObservation }); return result;
    } catch (error) {
      if (
        requestSequence === state.preflightRequestSequence
        && dialog.open
        && state.selected?.id === requestedId
        && state.jobDialogGeneration === dialogGeneration
        && state.canonicalStateCurrent
        && state.refreshEpoch === refreshEpoch
        && state.dependencyObservation === dependencyObservation
        && freshestKnownJob(requestedId)?.revision === requestedRevision
      ) {
        clearPreflightReadiness();
        showFormError(error.message, { id: requestedId, requestSequence });
      }
      return null;
    }
  }

  const issueText = { profile_empty: "Complete your applicant profile", resume_missing: "Assign an active resume", resume_file_missing: "The resume file cannot be found", resume_file_changed: "The resume file changed since it was added", role_missing: "Add a role for clearer handoff", company_missing: "Add a company for clearer handoff" };
  function renderPreflight(result, { dialogGeneration, refreshEpoch, dependencyObservation }) {
    const panel = $("#preflight-panel"), body = $("#preflight-results"); body.replaceChildren();
    const summary = document.createElement("p"); summary.textContent = result.ready ? "No blocking issues. This job can be handed to a Job Apply agent." : "Resolve the blocking issues before marking this job ready."; body.append(summary);
    for (const [label, items] of [["Blocking", result.errors], ["Warnings", result.warnings]]) if (items.length) { const h = document.createElement("strong"); h.textContent = label; const ul = document.createElement("ul"); for (const code of items) { const li = document.createElement("li"); li.textContent = issueText[code] || code; ul.append(li); } body.append(h, ul); }
    const current = freshestKnownJob(state.selected?.id);
    const currentStatus = current?.status;
    panel.classList.remove("hidden");
    $("#mark-ready").classList.toggle("hidden", !result.ready || !canMarkReadyFrom(currentStatus));
    state.readyHandoffProof = result.ready && currentStatus === "ready" && result.revision === current?.revision
      ? { id: result.id, revision: result.revision, dialogGeneration, refreshEpoch, dependencyObservation }
      : null;
    syncReadyHandoff();
  }

  async function transition(status, userConfirmed = false, closedOutcome = null) {
    try {
      const activityRevision = state.activityJobId === state.selected.id
        ? state.activity?.job?.revision
        : null;
      const expectedRevision = Math.max(state.selected.revision, activityRevision ?? 0);
      const body = { status, expectedRevision, userConfirmed };
      if (closedOutcome !== null) body.closedOutcome = closedOutcome;
      const updated = await api(`/api/jobs/${encodeURIComponent(state.selected.id)}/transition`, { method: "POST", body: JSON.stringify(body) });
      state.selected = updated; await refresh({ quiet: true }); closeJobDialog(null, updated.id); toast(`Job moved to ${statusLabel(status)}`);
    } catch (error) { if (error.status === 409) await showConflict(); else showFormError(error.message); }
  }

  function renderStatusActions(job) {
    const holder = $("#status-buttons"); holder.replaceChildren();
    for (const status of transitionsFor(job.status)) {
      if (status === "applied") {
        const button = document.createElement("button"); button.type = "button"; button.className = "button secondary"; button.textContent = "Mark applied…"; button.addEventListener("click", () => { if (confirm("Confirm that you personally submitted this application on the third-party site. This workspace does not submit it.")) transition("applied", true); }); holder.append(button);
      } else if (status === "closed") {
        const label = document.createElement("label"); label.className = "close-action"; label.append("Close as ");
        const select = document.createElement("select"); select.setAttribute("aria-label", "Closed outcome");
        for (const [value, text] of [["rejected", "Rejected"], ["withdrawn", "Withdrawn"], ["expired", "Expired"], ["duplicate", "Duplicate"], ["not_interested", "Not interested"]]) select.append(new Option(text, value));
        const button = document.createElement("button"); button.type = "button"; button.className = "button secondary"; button.textContent = "Close job"; button.addEventListener("click", () => transition("closed", false, select.value));
        label.append(select); holder.append(label, button);
      } else {
        const button = document.createElement("button"); button.type = "button"; button.className = "button secondary"; button.textContent = `Move to ${statusLabel(status)}`; button.addEventListener("click", () => transition(status)); holder.append(button);
      }
    }
    $("#status-actions").classList.toggle("hidden", holder.children.length === 0);
  }

  function renderJobControls(job) {
    $("#trash-job").classList.toggle("hidden", job.status === "in_progress");
    $("#preflight-job").classList.remove("hidden");
    $("#mark-ready").classList.toggle("hidden", !canMarkReadyFrom(job.status));
    syncReadyHandoff();
    renderStatusActions(job);
  }


  Object.assign(coordinators, { metrics, render, refresh, fillResumeOptions, fillForm, openNew, openExisting, currentValues, showFormError, hideConflict, showConflict, save, preflight, renderPreflight, transition, renderStatusActions, renderJobControls });
}
