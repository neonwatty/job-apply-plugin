import * as apiHelpers from "../lib/api.js";
import * as helpers from "../lib/helpers.js";

export function installFacts(context) {
  const { api, state: stores, dom, coordinators } = context;
  const {
    job: state,
    profile: profileState,
    factGroup: factGroupState,
  } = stores;
  const {
    $,
    form,
    dialog,
    statusLabel,
    toast,
    setConnection,
  } = dom;
  const {
    ApiError,
    shouldRetryFactSave,
  } = apiHelpers;
  const {
    pointerValue,
    patchForPaths,
    conflictingPaths,
    summarizeProvenance,
  } = helpers;
  const focusResumeRequest = (...args) => coordinators.focusResumeRequest(...args);
  const openProposal = (...args) => coordinators.openProposal(...args);
  const refresh = (...args) => coordinators.refresh(...args);
  const save = (...args) => coordinators.save(...args);
  const namedTopLevel = new Set(["firstName", "lastName", "email", "phone", "location", "linkedInUrl", "portfolioUrl", "githubUrl", "workHistory", "education", "skills", "preferences"]);
  const encodePointer = (value) => String(value).replaceAll("~", "~0").replaceAll("/", "~1");
  const decodePointer = (value) => String(value).replaceAll("~1", "/").replaceAll("~0", "~");
  const equalJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

  function factPathLabel(control) {
    if (control.dataset.label) return control.dataset.label;
    const label = control.closest("label");
    if (label) {
      const text = [...label.childNodes].find((node) => node.nodeType === Node.TEXT_NODE)?.textContent?.trim();
      if (text) return text;
    }
    const repeater = control.closest(".repeater")?.querySelector("h3")?.textContent?.trim();
    return repeater || control.dataset.path;
  }

  function availableFactPaths() {
    const seen = new Set();
    const paths = [];
    for (const control of document.querySelectorAll("#facts-form [data-path]")) {
      const path = control.dataset.path;
      if (!path || seen.has(path)) continue;
      seen.add(path); paths.push({ path, label: factPathLabel(control) });
    }
    return paths.sort((left, right) => left.label.localeCompare(right.label) || left.path.localeCompare(right.path));
  }

  function factPathWrapper(control) {
    return control.closest(".additional-fact") || control.closest(".repeater") || control.closest("label") || control;
  }

  function renderFactGroupNav() {
    const holder = $("#custom-fact-groups"); holder.replaceChildren();
    for (const group of factGroupState.items) {
      const button = document.createElement("button"); button.type = "button"; button.className = "fact-group-chip";
      button.dataset.factView = `custom:${group.id}`; button.dataset.groupId = group.id; button.textContent = group.label;
      button.setAttribute("aria-pressed", "false"); button.addEventListener("click", () => applyFactView(button.dataset.factView)); holder.append(button);
    }
    applyFactView(factGroupState.selectedView, { announce: false });
  }

  function applyFactView(view, { announce = true } = {}) {
    const customId = view.startsWith("custom:") ? view.slice(7) : null;
    const custom = customId ? factGroupState.items.find((group) => group.id === customId) : null;
    if (customId && !custom) view = "all";
    factGroupState.selectedView = view;
    factGroupState.selected = custom || null;
    for (const control of document.querySelectorAll("#facts-form [data-path]")) factPathWrapper(control).removeAttribute("data-fact-path-hidden");
    const fieldsets = [...document.querySelectorAll("#facts-form [data-fact-section]")];
    for (const fieldset of fieldsets) fieldset.classList.remove("fact-view-hidden");
    let visibleControls = document.querySelectorAll("#facts-form [data-path]").length;
    if (view !== "all" && !custom) {
      for (const fieldset of fieldsets) fieldset.classList.toggle("fact-view-hidden", fieldset.dataset.factSection !== view);
      visibleControls = document.querySelectorAll(`#facts-form [data-fact-section="${CSS.escape(view)}"] [data-path]`).length;
    } else if (custom) {
      const selectedPaths = new Set(custom.paths);
      visibleControls = 0;
      for (const fieldset of fieldsets) {
        let fieldsetMatches = 0;
        for (const control of fieldset.querySelectorAll("[data-path]")) {
          const matches = selectedPaths.has(control.dataset.path);
          factPathWrapper(control).toggleAttribute("data-fact-path-hidden", !matches);
          if (matches) fieldsetMatches += 1;
        }
        fieldset.classList.toggle("fact-view-hidden", fieldsetMatches === 0);
        visibleControls += fieldsetMatches;
      }
    }
    for (const button of document.querySelectorAll("[data-fact-view]")) {
      const active = button.dataset.factView === view;
      button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active));
    }
    $("#fact-group-edit").classList.toggle("hidden", !custom);
    $("#fact-view-empty").classList.toggle("hidden", visibleControls > 0);
    $("#facts-form").classList.toggle("hidden", visibleControls === 0);
    const label = custom?.label || (document.querySelector(`[data-fact-view="${CSS.escape(view)}"]`)?.textContent || "All facts").trim();
    if (announce) $("#fact-view-status").textContent = `Showing ${label}. ${visibleControls} fact field${visibleControls === 1 ? "" : "s"} available.`;
  }

  async function refreshFactGroups({ quiet = false } = {}) {
    const request = ++factGroupState.requestSequence;
    try {
      const result = await api("/api/fact-groups");
      if (request !== factGroupState.requestSequence) return;
      factGroupState.items = result.groups; factGroupState.loaded = true; renderFactGroupNav();
      if (!quiet) toast("Fact groups refreshed from the canonical store");
    } catch (error) {
      if (request !== factGroupState.requestSequence) return;
      const node = $("#facts-error"); node.textContent = error.message; node.classList.remove("hidden");
    }
  }

  function renderFactGroupPicker(selectedPaths = []) {
    const selected = new Set(selectedPaths); const holder = $("#fact-group-paths"); holder.replaceChildren();
    for (const item of availableFactPaths()) {
      const label = document.createElement("label"); const input = document.createElement("input"); input.type = "checkbox"; input.name = "paths"; input.value = item.path; input.checked = selected.has(item.path);
      const copy = document.createElement("span"); const name = document.createElement("strong"); name.textContent = item.label; const path = document.createElement("code"); path.textContent = item.path; copy.append(name, path); label.append(input, copy); holder.append(label);
    }
  }

  function openFactGroup(group = null, opener = null) {
    factGroupState.editing = group; factGroupState.opener = opener || document.activeElement;
    const form = $("#fact-group-form"); form.reset();
    form.elements.label.value = group?.label || "";
    form.elements.order.value = String(group?.order ?? (Math.max(...factGroupState.items.map((item) => item.order), -100) + 100));
    renderFactGroupPicker(group?.paths || []);
    $("#fact-group-dialog-title").textContent = group ? "Edit fact group" : "Create fact group";
    $("#fact-group-delete").classList.toggle("hidden", !group);
    $("#fact-group-conflict").classList.add("hidden"); $("#fact-group-error").classList.add("hidden");
    $("#fact-group-dialog").showModal(); setTimeout(() => form.elements.label.focus(), 0);
  }

  async function saveFactGroup(event) {
    event.preventDefault(); const form = event.currentTarget;
    const paths = [...form.elements.paths].filter((input) => input.checked).map((input) => input.value);
    if (!paths.length) { const node = $("#fact-group-error"); node.textContent = "Choose at least one canonical fact."; node.classList.remove("hidden"); return; }
    const group = { label: form.elements.label.value, paths, order: Number(form.elements.order.value) };
    const selected = factGroupState.editing;
    const endpoint = selected ? `/api/fact-groups/${encodeURIComponent(selected.id)}` : "/api/fact-groups";
    const options = selected
      ? { method: "PATCH", body: JSON.stringify({ patch: group, expectedRevision: selected.revision }) }
      : { method: "POST", body: JSON.stringify({ group }) };
    $("#fact-group-save").disabled = true;
    try {
      const saved = await api(endpoint, options); factGroupState.selectedView = `custom:${saved.id}`;
      await refreshFactGroups({ quiet: true }); $("#fact-group-dialog").close(); toast(`Fact group ${selected ? "updated" : "created"}`);
    } catch (error) {
      if (error.status === 409) { $("#fact-group-conflict").classList.remove("hidden"); $("#fact-group-conflict").focus(); }
      else { const node = $("#fact-group-error"); node.textContent = error.message; node.classList.remove("hidden"); }
    } finally { $("#fact-group-save").disabled = false; }
  }

  async function deleteFactGroup() {
    const group = factGroupState.editing;
    if (!group || !confirm("Remove this saved fact view? Canonical applicant facts will not be changed.")) return;
    try {
      await api(`/api/fact-groups/${encodeURIComponent(group.id)}/delete`, { method: "POST", body: JSON.stringify({ expectedRevision: group.revision }) });
      factGroupState.selectedView = "all"; await refreshFactGroups({ quiet: true }); $("#fact-group-dialog").close(); toast("Fact group removed; canonical facts were unchanged");
    } catch (error) {
      if (error.status === 409) { $("#fact-group-conflict").classList.remove("hidden"); $("#fact-group-conflict").focus(); }
      else { const node = $("#fact-group-error"); node.textContent = error.message; node.classList.remove("hidden"); }
    }
  }

  function provenanceFor(path) {
    return summarizeProvenance(profileState.inspection?.factProvenance, path);
  }

  function provenanceText(path) {
    const record = provenanceFor(path);
    if (!record) return "No recorded provenance";
    const time = new Date(record.updatedAt);
    return `${record.source} · ${Number.isNaN(time.valueOf()) ? record.updatedAt : time.toLocaleString()}`;
  }

  function controlValue(control) {
    if (control.dataset.deleted === "true") return null;
    if (control.dataset.repeater) {
      return [...control.querySelectorAll(".repeater-item")].map((row) => {
        const item = { ...(row._base || {}) };
        for (const input of row.querySelectorAll("[data-item-field]")) item[input.dataset.itemField] = input.type === "checkbox" ? input.checked : input.value;
        return item;
      });
    }
    if (control.dataset.lines !== undefined) return control.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    if (control.dataset.json !== undefined) {
      let parsed;
      try { parsed = JSON.parse(control.value); } catch { throw new Error(`${control.dataset.label || "Structured fact"} must contain valid JSON.`); }
      if (control.dataset.array === "true" && !Array.isArray(parsed)) throw new Error(`${control.dataset.label} must be a JSON array.`);
      return parsed;
    }
    if (control.type === "number" && control.value !== "") return Number(control.value);
    return control.value;
  }

  function setControlValue(control, value) {
    control.dataset.deleted = "false";
    if (control.dataset.repeater) renderRepeater(control, Array.isArray(value) ? value : []);
    else if (control.dataset.lines !== undefined) control.value = Array.isArray(value) ? value.join("\n") : "";
    else if (control.dataset.json !== undefined) control.value = JSON.stringify(value ?? (control.dataset.array === "true" ? [] : null), null, 2);
    else control.value = value ?? "";
  }

  const repeaterSchemas = {
    work: [["company", "Company"], ["title", "Title"], ["startDate", "Start date"], ["endDate", "End date"], ["current", "Current position", "checkbox"], ["description", "Description"]],
    education: [["school", "School"], ["degree", "Degree"], ["field", "Field of study"], ["startDate", "Start date"], ["endDate", "End date"], ["gpa", "GPA"]],
  };

  function renderRepeater(container, items) {
    container.replaceChildren();
    items.forEach((item, index) => {
      const row = document.createElement("div"); row.className = "repeater-item form-grid"; row._base = item && typeof item === "object" ? { ...item } : {};
      for (const [field, text, type] of repeaterSchemas[container.dataset.repeater]) {
        const label = document.createElement("label"); label.textContent = text;
        const input = document.createElement(field === "description" ? "textarea" : "input"); input.dataset.itemField = field;
        if (type === "checkbox") { input.type = "checkbox"; input.checked = item?.[field] === true; }
        else input.value = item?.[field] ?? "";
        input.setAttribute("aria-label", `${text}, item ${index + 1}`); label.append(input); row.append(label);
      }
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "button danger"; remove.textContent = `Remove ${container.dataset.repeater === "work" ? "position" : "education"}`;
      remove.addEventListener("click", () => { row.remove(); markFactDirty(container); }); row.append(remove); container.append(row);
    });
  }

  function addRepeaterItem(path) {
    const container = document.querySelector(`#facts-form [data-path="${CSS.escape(path)}"]`);
    const values = controlValue(container); values.push({}); renderRepeater(container, values); markFactDirty(container);
    container.querySelector(".repeater-item:last-child input")?.focus();
  }

  function renderAdditionalFacts(profile, preservedDrafts = null, preservedDeletions = new Set()) {
    const holder = $("#additional-facts"); holder.replaceChildren();
    const keys = new Set(Object.keys(profile).filter((item) => !namedTopLevel.has(item)));
    for (const [path] of preservedDrafts || []) {
      const encoded = path.startsWith("/") ? path.slice(1) : "";
      if (encoded && !encoded.includes("/")) {
        const key = decodePointer(encoded);
        if (!namedTopLevel.has(key)) keys.add(key);
      }
    }
    for (const key of [...keys].sort()) {
      const path = `/${encodePointer(key)}`;
      const row = document.createElement("div"); row.className = "additional-fact";
      const name = document.createElement("code"); name.textContent = key;
      const label = document.createElement("label"); label.textContent = "JSON value";
      const editor = document.createElement("textarea"); editor.dataset.path = path; editor.dataset.json = ""; editor.dataset.label = key; editor.dataset.additionalAtomic = ""; editor.rows = 4;
      profileState.atomic.add(path); profileState.additionalAtomic.add(path);
      const canonicalExists = Object.hasOwn(profile, key);
      setControlValue(editor, canonicalExists ? profile[key] : preservedDrafts?.get(path));
      const provenance = document.createElement("small"); provenance.textContent = provenanceText(path); label.append(editor, provenance);
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "button danger"; remove.textContent = "Delete";
      remove.addEventListener("click", () => {
        if (!confirm(`Delete the additional fact “${key}”?`)) return;
        editor.dataset.deleted = "true"; editor.disabled = true; remove.disabled = true;
        if (!profileState.drafts.has(path)) profileState.draftBases.set(path, pointerValue(profileState.inspection.profile, path));
        profileState.drafts.set(path, null); profileState.deletions.add(path); row.classList.add("pending-delete");
      });
      editor.addEventListener("input", () => { profileState.deletions.delete(path); markFactDirty(editor); });
      if (preservedDeletions.has(path)) {
        editor.dataset.deleted = "true"; editor.disabled = true; remove.disabled = true; row.classList.add("pending-delete");
      }
      row.append(name, label, remove); holder.append(row);
    }
  }

  function renderProfile(inspection, preserveDrafts = null, preserveDraftBases = null, preserveDeletions = new Set()) {
    profileState.inspection = inspection; profileState.loaded = true; profileState.drafts.clear(); profileState.draftBases.clear(); profileState.atomic.clear(); profileState.additionalAtomic.clear(); profileState.deletions.clear(); profileState.conflicts = []; profileState.latest = null;
    for (const control of document.querySelectorAll("#facts-form [data-path]")) {
      const path = control.dataset.path;
      if (control.dataset.atomic !== undefined) profileState.atomic.add(path);
      if (control.dataset.json !== undefined) control.dataset.array = "true";
      setControlValue(control, pointerValue(inspection.profile, path));
      const note = document.querySelector(`[data-provenance="${CSS.escape(path)}"]`); if (note) note.textContent = provenanceText(path);
    }
    renderAdditionalFacts(inspection.profile, preserveDrafts, preserveDeletions);
    if (preserveDrafts) {
      for (const [path, value] of preserveDrafts) {
        const control = document.querySelector(`#facts-form [data-path="${CSS.escape(path)}"]`);
        if (control) {
          if (!preserveDeletions.has(path)) setControlValue(control, value);
          profileState.drafts.set(path, value);
          profileState.draftBases.set(path, preserveDraftBases?.get(path));
          if (preserveDeletions.has(path)) profileState.deletions.add(path);
        }
      }
    }
    applyFactView(factGroupState.selectedView, { announce: false });
    $("#facts-revision").textContent = `Revision ${inspection.revision}`;
    $("#facts-status").textContent = profileState.drafts.size ? "Draft changes are preserved against the latest profile." : "Profile is synchronized with the canonical store.";
    $("#facts-conflict").classList.add("hidden"); $("#facts-error").classList.add("hidden");
  }

  const readinessNames = {
    first_name: "First name", last_name: "Last name", email: "Email", default_resume: "Default resume",
    phone: "Phone", location: "Location", work_history: "Work history", education: "Education",
    skills: "Skills", professional_links: "Professional links",
  };
  const reviewReasonText = {
    extraction_requested: "Fact extraction is waiting for a Job Apply agent.",
    extraction_failed: "Fact extraction did not complete.",
    extraction_stale: "The resume changed; request fresh extraction.",
    unresolved_conflicts: "Extracted changes need review.",
    human_protected_facts_retained: "Human-confirmed facts remain protected until you review them.",
  };

  function readinessList(title, items, common = false) {
    const section = document.createElement("section"); const heading = document.createElement("h3"); heading.textContent = title;
    const list = document.createElement("ul"); list.className = "readiness-list";
    for (const item of items || []) {
      const row = document.createElement("li"); const name = document.createElement("span"); name.textContent = readinessNames[item.id] || statusLabel(item.id);
      const stateLabel = document.createElement("strong"); stateLabel.className = `readiness-state ${item.state}`; stateLabel.textContent = common ? (item.state === "present" ? "Present" : "Not added") : (item.state === "present" ? "Complete" : "Needs attention");
      row.append(name, stateLabel); list.append(row);
    }
    section.append(heading, list); return section;
  }

  function renderPreparedness(preparedness) {
    profileState.preparedness = preparedness;
    const holder = $("#profile-readiness-sections"); holder.replaceChildren(
      readinessList("Essential setup", preparedness?.essentialSetup),
      readinessList("Common coverage", preparedness?.commonCoverage, true),
    );
    const review = document.createElement("section"); const heading = document.createElement("h3"); heading.textContent = "Review health";
    const list = document.createElement("ul"); list.className = "readiness-list review-health";
    for (const item of preparedness?.reviewHealth || []) {
      const row = document.createElement("li"); const copy = document.createElement("span"); copy.textContent = reviewReasonText[item.reasonCode] || statusLabel(item.reasonCode);
      const action = document.createElement("button"); action.type = "button"; action.className = "button secondary";
      if (item.proposalId) { action.textContent = "Review changes"; action.addEventListener("click", () => openProposal(item.proposalId)); }
      else { action.textContent = item.reasonCode === "extraction_stale" ? "Request fresh extraction" : "Open resume"; action.addEventListener("click", () => focusResumeRequest(item.resumeId)); }
      row.append(copy, action); list.append(row);
    }
    if (!list.children.length) { const row = document.createElement("li"); row.textContent = "No extraction requests or proposal reviews need attention."; list.append(row); }
    review.append(heading, list); holder.append(review);
  }

  function markFactDirty(control) {
    try {
      const value = controlValue(control);
      const path = control.dataset.path;
      if (equalJson(value, pointerValue(profileState.inspection.profile, path))) {
        profileState.drafts.delete(path); profileState.draftBases.delete(path);
      } else {
        if (!profileState.drafts.has(path)) profileState.draftBases.set(path, pointerValue(profileState.inspection.profile, path));
        profileState.drafts.set(path, value);
      }
      $("#facts-error").classList.add("hidden");
      $("#facts-status").textContent = profileState.drafts.size ? `${profileState.drafts.size} fact change${profileState.drafts.size === 1 ? "" : "s"} ready to save.` : "Profile is synchronized with the canonical store.";
    } catch (error) { const node = $("#facts-error"); node.textContent = error.message; node.classList.remove("hidden"); }
  }

  async function refreshProfile({ preserve = true } = {}) {
    try {
      const drafts = preserve ? new Map(profileState.drafts) : null;
      const draftBases = preserve ? new Map(profileState.draftBases) : null;
      const deletions = preserve ? new Set(profileState.deletions) : new Set();
      const [inspection, preparedness] = await Promise.all([api("/api/profile"), api("/api/profile-preparedness")]);
      renderProfile(inspection, drafts, draftBases, deletions); renderPreparedness(preparedness); setConnection(true);
    } catch (error) { setConnection(false, error.message); const node = $("#facts-error"); node.textContent = error.message; node.classList.remove("hidden"); }
  }

  function showFactConflicts(latest, conflicts) {
    profileState.latest = latest; profileState.conflicts = conflicts;
    const list = $("#facts-conflict-list"); list.replaceChildren();
    for (const path of conflicts) { const item = document.createElement("li"); item.textContent = path; list.append(item); }
    $("#facts-conflict").classList.remove("hidden"); $("#facts-conflict").focus();
  }

  async function saveFacts() {
    $("#facts-save").disabled = true;
    try {
      for (const control of document.querySelectorAll("#facts-form [data-path]")) if (profileState.drafts.has(control.dataset.path)) profileState.drafts.set(control.dataset.path, controlValue(control));
      if (!profileState.drafts.size) { toast("No fact changes to save"); return; }
      let retries = 0;
      while (true) {
        try {
          const latest = await api("/api/profile");
          const conflicts = conflictingPaths(profileState.draftBases, latest.profile, profileState.drafts, profileState.atomic);
          if (conflicts.length) { showFactConflicts(latest, conflicts); return; }
          const atomicPaths = [...profileState.drafts.keys()].filter((path) => profileState.additionalAtomic.has(path));
          const deletedPaths = atomicPaths.filter((path) => profileState.deletions.has(path));
          const updated = await api("/api/profile", { method: "PATCH", body: JSON.stringify({ patch: patchForPaths(profileState.drafts), expectedRevision: latest.revision, atomicPaths, deletedPaths }) });
          renderProfile(updated); toast("Facts saved to the canonical profile");
          return;
        } catch (error) {
          if (shouldRetryFactSave(error, retries)) { retries += 1; continue; }
          if (error instanceof ApiError && error.status === 409 && error.code === "revision_conflict") {
            const node = $("#facts-error");
            node.textContent = "The profile changed repeatedly while saving. Your draft is preserved. Retry Save or refresh the profile before trying again.";
            node.classList.remove("hidden");
            return;
          }
          throw error;
        }
      }
    } catch (error) {
      const node = $("#facts-error"); node.textContent = error.message; node.classList.remove("hidden");
    } finally { $("#facts-save").disabled = false; }
  }

  function resolveFactConflicts(useMine) {
    const drafts = new Map(profileState.drafts);
    if (!useMine) for (const path of profileState.conflicts) drafts.delete(path);
    const deletions = new Set([...profileState.deletions].filter((path) => drafts.has(path)));
    const resolvedBases = new Map(
      [...drafts].map(([path]) => [path, pointerValue(profileState.latest.profile, path)]),
    );
    renderProfile(profileState.latest, drafts, resolvedBases, deletions);
    if (useMine) saveFacts(); else $("#facts-save").focus();
  }


  Object.assign(coordinators, { factPathLabel, availableFactPaths, factPathWrapper, renderFactGroupNav, applyFactView, refreshFactGroups, renderFactGroupPicker, openFactGroup, saveFactGroup, deleteFactGroup, provenanceFor, provenanceText, controlValue, setControlValue, renderRepeater, addRepeaterItem, renderAdditionalFacts, renderProfile, readinessList, renderPreparedness, markFactDirty, refreshProfile, showFactConflicts, saveFacts, resolveFactConflicts });
}
