import * as helpers from "../lib/helpers.js";

export function installResumes(context) {
  const { api, state: stores, dom, coordinators } = context;
  const {
    job: state,
    profile: profileState,
    resume: resumeState,
  } = stores;
  const {
    $,
    form,
    dialog,
    toast,
  } = dom;
  const {
    pointerValue,
    summarizeProvenance,
    fileToBase64,
    resumeAssignmentText,
    extractionRequestView,
    proposalGroupForPath,
    lifecycleErrorText,
    shouldUseResumeResponse,
  } = helpers;
  const refreshProfile = (...args) => coordinators.refreshProfile(...args);
  const navigateWorkspace = (...args) => coordinators.navigateWorkspace(...args);
  const refresh = (...args) => coordinators.refresh(...args);
  const currentValues = (...args) => coordinators.currentValues(...args);
  function resumeError(message, dialogError = false) { const node = $(dialogError ? "#resume-error" : "#resumes-error"); node.textContent = message; node.classList.remove("hidden"); }

  function assignmentText(resume) {
    return resumeAssignmentText(resume);
  }

  function proposalStatus(resumeId) {
    const items = resumeState.proposals.filter((item) => item.resumeId === resumeId);
    const pending = items.filter((item) => item.status === "pending");
    return { items, text: pending.length ? `${pending.length} pending extraction review${pending.length === 1 ? "" : "s"} · ${pending.reduce((sum, item) => sum + item.pendingCount, 0)} conflicts` : items.length ? "Extraction review complete" : "No extraction proposal" };
  }

  function proposalForRequest(resume) {
    const request = resume.extractionRequest;
    if (request?.proposalId) return resumeState.proposals.find((item) => item.id === request.proposalId) || null;
    return resumeState.proposals.find((item) => item.resumeId === resume.id && item.status === "pending") || null;
  }

  const extractionActionLabels = {
    request: "Request fact extraction", cancel: "Cancel request", review: "Review changes",
    facts: "View facts", retry: "Try again", fresh: "Request fresh extraction",
  };
  const extractionFailureText = {
    content_unreadable: "The resume content could not be read.", unsupported_resume: "This resume format is not supported.",
    extraction_failed: "The agent could not extract facts from this resume.", candidate_invalid: "The extracted facts did not pass validation.",
    interrupted: "The agent workflow was interrupted.",
  };

  function extractionStatusText(resume, view) {
    const request = resume.extractionRequest;
    if (request?.status === "failed") return `${view.label}. ${extractionFailureText[request.failureReason] || "Try again when a Job Apply agent is available."}`;
    if (request?.status === "stale") return `${view.label}. The old request cannot be applied to the new content.`;
    if (request?.status === "requested") return `${view.label}. No agent is assigned until you hand off this request.`;
    return view.label;
  }

  function handoffText(request) {
    return `Use the Job Apply resume workflow to process extraction request ${request.requestId}.`;
  }

  async function copyExtractionHandoff(request, fallback) {
    const value = handoffText(request);
    try { await navigator.clipboard.writeText(value); fallback?.classList.add("hidden"); toast("Agent handoff copied"); }
    catch {
      if (fallback) { const input = fallback.querySelector("input"); input.value = value; fallback.classList.remove("hidden"); input.focus(); input.select(); }
    }
  }

  async function runExtractionAction(resume, action) {
    const request = resume.extractionRequest;
    if (action === "review") { const proposal = proposalForRequest(resume); if (proposal) await openProposal(proposal.id); return; }
    if (action === "facts") { if ($("#resume-dialog").open) $("#resume-dialog").close(); await navigateWorkspace("facts"); $("#profile-readiness").focus(); return; }
    try {
      let path = "/api/resume-extraction-requests"; let body = { resumeId: resume.id, expectedResumeRevision: resume.revision };
      if (action === "cancel") { path += `/${encodeURIComponent(request.requestId)}/cancel`; body = { expectedRevision: request.revision }; }
      if (action === "retry" || (action === "fresh" && request?.status === "stale")) { path += `/${encodeURIComponent(request.requestId)}/retry`; body = { expectedRevision: request.revision, expectedResumeRevision: resume.revision }; }
      const updatedRequest = await api(path, { method: "POST", body: JSON.stringify(body) });
      await refreshResumes({ quiet: true }); if (profileState.loaded) await refreshProfile({ preserve: true });
      const updatedResume = resumeState.items.find((item) => item.id === resume.id);
      if (updatedResume) {
        updatedResume.extractionRequest = updatedRequest;
        renderResumes();
        if (resumeState.selected?.id === resume.id) renderResumeDialog(updatedResume, true);
      }
      toast(action === "request" ? "Request saved. The next active Job Apply agent can extract facts from this resume." : action === "cancel" ? "Extraction request cancelled" : "Fresh extraction request saved");
      return true;
    } catch (error) {
      if (error.status === 409 || error.code === "revision_conflict") {
        if ($("#resume-dialog").open) { $("#resume-conflict").classList.remove("hidden"); $("#resume-conflict").focus(); }
        else { resumeError("This resume or request changed elsewhere. Refresh the canonical library before choosing another action."); $("#resumes-refresh").focus(); }
      } else resumeError(error.message, $("#resume-dialog").open);
      return false;
    }
  }

  function buildExtractionControls(resume) {
    const wrapper = document.createElement("section"); wrapper.className = "resume-extraction"; wrapper.dataset.tone = extractionRequestView(resume.extractionRequest, proposalForRequest(resume)).tone;
    const status = document.createElement("p"); status.className = "extraction-status"; status.setAttribute("role", "status");
    const view = extractionRequestView(resume.extractionRequest, proposalForRequest(resume)); status.textContent = extractionStatusText(resume, view);
    const buttons = document.createElement("div"); buttons.className = "button-row";
    const primary = document.createElement("button"); primary.type = "button"; primary.className = "button primary"; primary.textContent = extractionActionLabels[view.action]; primary.dataset.resumeExtractionAction = resume.id; primary.addEventListener("click", () => runExtractionAction(resume, view.action)); buttons.append(primary);
    if (resume.extractionRequest?.status === "requested") {
      const copy = document.createElement("button"); copy.type = "button"; copy.className = "button secondary"; copy.textContent = "Copy agent handoff";
      const fallback = document.createElement("label"); fallback.className = "clipboard-fallback hidden"; fallback.setAttribute("role", "alert"); fallback.append("Clipboard unavailable. Select and copy this handoff manually. "); const input = document.createElement("input"); input.readOnly = true; input.setAttribute("aria-label", "Extraction request handoff to copy"); fallback.append(input);
      copy.addEventListener("click", () => copyExtractionHandoff(resume.extractionRequest, fallback)); buttons.append(copy); wrapper.append(status, buttons, fallback); return wrapper;
    }
    wrapper.append(status, buttons); return wrapper;
  }

  function renderResumes() {
    $("#resumes-loading").classList.add("hidden");
    $("#resumes-active").classList.toggle("active", !resumeState.trash); $("#resumes-trash").classList.toggle("active", resumeState.trash);
    $("#resume-import").classList.toggle("hidden", resumeState.trash);
    $("#resumes-empty").classList.toggle("hidden", resumeState.items.length !== 0);
    const list = $("#resume-list"); list.replaceChildren();
    for (const resume of resumeState.items) {
      const card = document.createElement("article"); card.className = "resume-card"; card.setAttribute("role", "listitem");
      const heading = document.createElement("h3"); heading.textContent = resume.label || resume.id;
      const meta = document.createElement("p"); meta.textContent = `${resume.mediaType || "External file"} · ${resume.observedSize ?? "unknown"} bytes${resume.default ? " · Default" : ""}`;
      const tags = document.createElement("p"); tags.textContent = resume.tags?.length ? `Tags: ${resume.tags.join(", ")}` : "No tags";
      const assignment = document.createElement("p"); assignment.textContent = assignmentText(resume);
      const open = document.createElement("button"); open.type = "button"; open.className = "button secondary"; open.textContent = "Manage"; open.addEventListener("click", () => openResume(resume.id, open));
      card.append(heading, meta, tags, assignment, buildExtractionControls(resume), open); list.append(card);
    }
    $("#resumes-status").textContent = `${resumeState.items.length} ${resumeState.trash ? "trashed" : "active"} resume${resumeState.items.length === 1 ? "" : "s"}.`;
  }

  async function refreshResumes({ quiet = false } = {}) {
    const requestedTrash = resumeState.trash;
    const requestId = ++resumeState.requestId;
    resumeState.loading = true; $("#resumes-loading").classList.remove("hidden");
    try {
      const [library, proposals] = await Promise.all([api(requestedTrash ? "/api/resumes/trash" : "/api/resumes"), api("/api/resume-proposals")]);
      if (!shouldUseResumeResponse(requestId, resumeState.requestId, requestedTrash, resumeState.trash)) return;
      resumeState.items = library.resumes; resumeState.proposals = proposals.proposals; resumeState.loaded = true; renderResumes();
      if (resumeState.selected) {
        const latest = resumeState.items.find((item) => item.id === resumeState.selected.id);
        if (latest) {
          if (latest.revision === resumeState.selected.revision) renderResumeDialog(latest, true);
          else { renderResumeDialog(resumeState.selected, true); $("#resume-conflict").classList.remove("hidden"); $("#resume-conflict").focus(); }
        }
      }
      if (!quiet) toast("Resumes refreshed from the canonical store");
    } catch (error) { if (shouldUseResumeResponse(requestId, resumeState.requestId, requestedTrash, resumeState.trash)) { resumeError(error.message); $("#resumes-loading").classList.add("hidden"); } }
    finally { if (requestId === resumeState.requestId) resumeState.loading = false; }
  }

  function renderResumeDialog(resume, preserve = false) {
    const form = $("#resume-form");
    const drafts = preserve ? new Map(
      [...resumeState.dirtyMetadata].map((field) => [field, form.elements[field].value]),
    ) : new Map();
    resumeState.selected = resume; $("#resume-dialog-title").textContent = resume.label || resume.id;
    form.elements.label.value = resume.label || ""; form.elements.tags.value = (resume.tags || []).join(", ");
    for (const [field, value] of drafts) form.elements[field].value = value;
    $("#resume-assignment").textContent = assignmentText(resume); const status = proposalStatus(resume.id); $("#resume-proposal-status").textContent = status.text;
    const proposal = proposalForRequest(resume); const view = extractionRequestView(resume.extractionRequest, proposal);
    $("#resume-extraction-status").textContent = extractionStatusText(resume, view); $("#resume-extraction-status").dataset.tone = view.tone;
    $("#resume-extraction-action").textContent = extractionActionLabels[view.action]; $("#resume-extraction-action").dataset.action = view.action;
    $("#resume-handoff-copy").classList.toggle("hidden", resume.extractionRequest?.status !== "requested"); $("#resume-handoff-fallback").classList.add("hidden");
    $("#resume-default").classList.toggle("hidden", resume.default || Boolean(resume.deletedAt)); $("#resume-trash-action").classList.toggle("hidden", Boolean(resume.deletedAt)); $("#resume-restore").classList.toggle("hidden", !resume.deletedAt); $("#resume-delete").classList.toggle("hidden", !resume.deletedAt);
    $("#resume-content").classList.toggle("hidden", resume.storageKind !== "managed" || Boolean(resume.deletedAt)); $("#resume-replace").classList.toggle("hidden", resume.storageKind !== "managed" || Boolean(resume.deletedAt)); $("#resume-adopt").classList.toggle("hidden", resume.storageKind === "managed" || Boolean(resume.deletedAt));
    const holder = $("#resume-proposals"); holder.replaceChildren();
    for (const proposal of status.items) { const row = document.createElement("div"); row.className = "proposal-summary"; const text = document.createElement("span"); text.textContent = `${proposal.status} · ${proposal.pendingCount} pending`; row.append(text); if (proposal.status === "pending") { const button = document.createElement("button"); button.type = "button"; button.className = "button secondary"; button.textContent = "Review"; button.addEventListener("click", () => openProposal(proposal.id)); row.append(button); } holder.append(row); }
  }

  function openResume(id, opener) { const resume = resumeState.items.find((item) => item.id === id); if (!resume) return; resumeState.opener = opener; resumeState.dirtyMetadata.clear(); $("#resume-form").elements.file.value = ""; $("#resume-error").classList.add("hidden"); $("#resume-conflict").classList.add("hidden"); renderResumeDialog(resume); $("#resume-dialog").showModal(); setTimeout(() => $("#resume-form").elements.label.focus(), 0); }

  async function focusResumeRequest(resumeId) {
    if ($("#proposal-dialog").open) $("#proposal-dialog").close(); if ($("#resume-dialog").open) $("#resume-dialog").close();
    await navigateWorkspace("resumes"); await refreshResumes({ quiet: true });
    const target = document.querySelector(`[data-resume-extraction-action="${CSS.escape(resumeId)}"]`); target?.focus(); target?.scrollIntoView({ block: "center" });
  }

  async function requestFreshForProposal() {
    const resume = resumeState.items.find((item) => item.id === resumeState.proposal?.resumeId);
    if (!resume) { $("#proposal-error").textContent = "Refresh Resumes before requesting fresh extraction."; $("#proposal-error").classList.remove("hidden"); return; }
    if (!await runExtractionAction(resume, "fresh")) return;
    $("#proposal-dialog").close();
    const action = $("#resume-extraction-action"); if ($("#resume-dialog").open && resumeState.selected?.id === resume.id) action.focus();
  }

  async function uploadEnvelope(file, metadata) { return { metadata, filename: file.name, content: await fileToBase64(file) }; }

  async function mutateResume(action, body = null) {
    const resume = resumeState.selected;
    try {
      const options = { method: "POST", body: JSON.stringify(body || { expectedRevision: resume.revision }) };
      await api(`/api/resumes/${encodeURIComponent(resume.id)}/${action}`, options); await refresh({ quiet: true }); await refreshResumes({ quiet: true }); $("#resume-dialog").close(); toast(`Resume ${action} completed`);
    } catch (error) { if (error.code === "revision_conflict") { $("#resume-conflict").classList.remove("hidden"); $("#resume-conflict").focus(); } else resumeError(lifecycleErrorText(error), true); }
  }

  async function mutateResumeFile(action) {
    const file = $("#resume-form").elements.file.files[0];
    if (!file) { resumeError(`Choose a file to ${action} first.`, true); return; }
    try {
      const envelope = await uploadEnvelope(file, { expectedRevision: resumeState.selected.revision });
      await mutateResume(action, envelope);
    } catch (error) { resumeError(error.message, true); }
  }

  async function openProposal(id) {
    try {
      const proposal = await api(`/api/resume-proposals/${encodeURIComponent(id)}`); resumeState.proposal = proposal;
      const holder = $("#proposal-rows"); holder.replaceChildren();
      const groups = new Map();
      for (const path of proposal.pendingPaths) { const group = proposalGroupForPath(path); if (!groups.has(group)) groups.set(group, []); groups.get(group).push(path); }
      for (const group of ["Identity", "Contact", "Location", "Experience", "Education", "Skills", "Links", "Additional"]) {
        if (!groups.has(group)) continue;
        const section = document.createElement("section"); section.className = "proposal-group"; const heading = document.createElement("h3"); heading.textContent = group; section.append(heading);
        for (const path of groups.get(group)) {
        const row = document.createElement("fieldset"); row.className = "proposal-row"; const legend = document.createElement("legend"); legend.textContent = path;
        const provenance = summarizeProvenance(profileState.inspection?.factProvenance || {}, path) || {};
        const current = document.createElement("pre"); current.textContent = `Current (${provenance.source || "unknown source"}): ${JSON.stringify(proposal.currentValues[path]?.value)}`;
        const extracted = document.createElement("pre"); extracted.textContent = `Extracted: ${JSON.stringify(pointerValue(proposal.candidate, path))}`;
        const label = document.createElement("label"); label.append("Decision "); const select = document.createElement("select"); select.name = path; select.append(new Option("Decide later", ""), new Option("Use extracted", "use_extracted"), new Option("Keep current", "keep_current")); label.append(select);
        row.append(legend, current, extracted, label);
        const replacement = proposal.replacementScopes?.[path];
        if (replacement) {
          const warning = document.createElement("p"); warning.className = "conflict"; warning.textContent = `Using the extracted value will replace existing ${replacement.path}: ${JSON.stringify(replacement.value)}`;
          const confirmation = document.createElement("label"); const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.dataset.replacementPath = path; checkbox.value = replacement.path; confirmation.append(checkbox, ` I confirm replacing ${replacement.path}`);
          row.append(warning, confirmation);
        }
        section.append(row);
        }
        holder.append(section);
      }
      const stale = Boolean(proposal.staleReasons?.length); $("#proposal-submit").disabled = stale; $("#proposal-keep-all").disabled = stale; $("#proposal-stale-actions").classList.toggle("hidden", !stale); $("#proposal-error").textContent = stale ? "This extraction review is no longer current and cannot be applied to canonical state. Request fresh extraction to continue." : ""; $("#proposal-error").classList.toggle("hidden", !stale); $("#proposal-dialog").showModal();
    } catch (error) { resumeError(error.message, true); }
  }

  async function submitProposalReview(packet) {
    const proposal = resumeState.proposal;
    try {
      await api(`/api/resume-proposals/${encodeURIComponent(proposal.id)}/review`, { method: "POST", body: JSON.stringify({ ...packet, expectedRevision: proposal.revision, expectedProfileRevision: proposal.liveProfileRevision }) });
      resumeState.pendingReview = null; $("#replacement-confirm-dialog").close(); $("#proposal-dialog").close(); await refreshProfile({ preserve: true }); await refreshResumes({ quiet: true });
      if (resumeState.selected) { const latest = resumeState.items.find((item) => item.id === resumeState.selected.id); if (latest) renderResumeDialog(latest, true); }
      toast("Selected extraction decisions applied to Facts");
    } catch (error) { $("#replacement-confirm-dialog").close(); $("#proposal-error").textContent = error.status === 409 ? "The proposal or profile changed. Nothing was retried; refresh and review the latest canonical values." : error.message; $("#proposal-error").classList.remove("hidden"); }
  }


  Object.assign(coordinators, { resumeError, assignmentText, proposalStatus, proposalForRequest, extractionStatusText, handoffText, copyExtractionHandoff, runExtractionAction, buildExtractionControls, renderResumes, refreshResumes, renderResumeDialog, openResume, focusResumeRequest, requestFreshForProposal, uploadEnvelope, mutateResume, mutateResumeFile, openProposal, submitProposalReview });
}
