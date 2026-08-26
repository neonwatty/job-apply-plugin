export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error?.message || `Workspace request failed (${status})`);
    this.status = status;
    this.code = payload?.error?.code || "request_error";
    this.recordType = payload?.error?.recordType || null;
    this.operation = payload?.error?.operation || null;
    this.counts = payload?.error?.counts || {};
  }
}

export const FACT_SAVE_REVISION_RETRIES = 2;

export function shouldRetryFactSave(error, retries, maxRetries = FACT_SAVE_REVISION_RETRIES) {
  return error instanceof ApiError
    && error.status === 409
    && error.code === "revision_conflict"
    && retries < maxRetries;
}

export function tokenFromHash(hash) {
  const params = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  return params.get("token") || "";
}

export function sessionToken(hash, storage) {
  const token = tokenFromHash(hash);
  try {
    if (token) storage?.setItem("jobApplyWorkspaceToken", token);
    return token || storage?.getItem("jobApplyWorkspaceToken") || "";
  } catch {
    return token;
  }
}

export function safeSessionStorage(scope) {
  try { return scope?.sessionStorage || null; } catch { return null; }
}

export function filterJobs(jobs, query = "", status = "") {
  const needle = query.trim().toLocaleLowerCase();
  return jobs.filter((job) => {
    if (status && job.status !== status) return false;
    if (!needle) return true;
    return [job.role, job.company, job.location, job.url]
      .some((value) => String(value || "").toLocaleLowerCase().includes(needle));
  });
}

export function answerNeedsFreshConsent(state, sensitivity, hasValue) {
  return Boolean(hasValue) && (state === "sensitive" || sensitivity !== "none");
}

export function answerSummary(record) {
  if (record.valueRedacted) return "Sensitive value hidden — reveal explicitly to view";
  if (record.hasValue) return "Value retained";
  return "No retained value";
}

export function canRevealAnswer(record) {
  return Boolean(record?.valueRedacted) && record?.deletedAt == null;
}

export function canRefreshAnswerDraft(selected, latest) {
  return Boolean(selected && latest && selected.key === latest.key);
}

export function canApplyAnswerReveal(selected, requestedKey, revealed) {
  return Boolean(
    selected
    && revealed
    && selected.key === requestedKey
    && revealed.key === requestedKey
    && !revealed.redirectedFrom
  );
}

export function canApplyAnswerDialogResponse(selected, requestedKey, requestSequence, currentSequence, dialogOpen = true) {
  return Boolean(
    dialogOpen
    &&
    selected
    && selected.key === requestedKey
    && requestSequence === currentSequence
  );
}

export function canApplyAnswerDialogMutation(selected, requestedKey, requestGeneration, currentGeneration, dialogOpen = true) {
  return dialogOpen
    && requestGeneration === currentGeneration
    && (selected?.key ?? null) === requestedKey;
}

export function answerApiPath(key, action = "") {
  const bytes = new TextEncoder().encode(String(key));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `/api/answers/by-key/${encoded}${action ? `/${action}` : ""}`;
}

export function sameAnswerScope(left, right) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
    return value;
  };
  return JSON.stringify(canonical(left || {})) === JSON.stringify(canonical(right || {}));
}

export function formPatch(values) {
  const patch = {};
  for (const field of ["url", "role", "company", "location", "workplaceType", "employmentType", "compensation", "notes", "description", "resumeId"]) {
    const value = values[field];
    patch[field] = value === "" && field === "resumeId" ? null : value;
  }
  patch.priority = Number(values.priority || 0);
  return patch;
}

export function transitionsFor(status) {
  return {
    saved: ["needs_info", "closed"], needs_info: ["saved", "closed"], ready: ["saved", "needs_info", "closed"],
    in_progress: [], awaiting_review: ["applied", "closed"],
    applied: ["closed"], closed: ["saved"],
  }[status] || [];
}

export function canMarkReadyFrom(status) {
  return status === "saved" || status === "needs_info";
}

export function createApi(token, fetchImpl = globalThis.fetch) {
  return async function api(path, options = {}) {
    const headers = { Authorization: `Bearer ${token}`, ...(options.headers || {}) };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetchImpl(path, { ...options, headers });
    let payload = null;
    try { payload = await response.json(); } catch { /* handled below */ }
    if (!response.ok) throw new ApiError(response.status, payload);
    return payload;
  };
}

export function createLatestRequestCoordinator() {
  let latestRequest = 0;
  return {
    invalidate() { latestRequest += 1; },
    async run(load, onSuccess, onFailure) {
      const requestId = ++latestRequest;
      try {
        const value = await load();
        if (requestId !== latestRequest) return false;
        onSuccess(value);
      } catch (error) {
        if (requestId !== latestRequest) return false;
        onFailure(error);
      }
      return true;
    },
  };
}

export function activitySignature(activity) {
  if (!activity) return "";
  return JSON.stringify({
    status: activity.job?.status,
    revision: activity.job?.revision,
    sessionStatus: activity.session?.status,
    sessionStep: activity.session?.step,
    sessionUpdatedAt: activity.session?.updatedAt,
    pendingInformation: activity.session?.pendingInformation || [],
    claimState: activity.claim?.state,
    claimHeartbeatAt: activity.claim?.heartbeatAt,
    history: activity.history || [],
  });
}

export function activityAnnouncement(previous, current) {
  if (!previous || activitySignature(previous) === activitySignature(current)) return "";
  const changes = [];
  if (previous.job?.status !== current.job?.status) changes.push(`Status changed to ${String(current.job?.status || "saved").replaceAll("_", " ")}.`);
  if (previous.claim?.state !== current.claim?.state) changes.push(`Agent attempt is ${current.claim?.state || "not active"}.`);
  if (previous.session?.updatedAt !== current.session?.updatedAt && current.session?.step) changes.push(`Progress updated at ${current.session.step}.`);
  if ((previous.history || []).length !== (current.history || []).length) changes.push("Application history updated.");
  return changes.join(" ");
}

export function pointerValue(value, pointer) {
  return pointer.split("/").slice(1).reduce((item, segment) => {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    return item != null && Object.hasOwn(Object(item), key) ? item[key] : undefined;
  }, value);
}

export function patchForPaths(entries) {
  const patch = {};
  for (const [pointer, value] of entries) {
    const parts = pointer.split("/").slice(1).map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
    let target = patch;
    parts.forEach((part, index) => {
      if (index === parts.length - 1) Object.defineProperty(target, part, { value, enumerable: true, configurable: true, writable: true });
      else {
        if (!Object.hasOwn(target, part)) Object.defineProperty(target, part, { value: {}, enumerable: true, configurable: true, writable: true });
        target = target[part];
      }
    });
  }
  return patch;
}

export function conflictingPaths(base, latest, drafts, atomicPaths = new Set()) {
  return [...drafts].filter(([path, mine]) => {
    const before = base instanceof Map ? base.get(path) : pointerValue(base, path);
    const now = pointerValue(latest, path);
    const structured = atomicPaths.has(path) || typeof mine === "object" || typeof before === "object" || typeof now === "object";
    return JSON.stringify(before) !== JSON.stringify(now) && (structured || JSON.stringify(mine) !== JSON.stringify(now));
  }).map(([path]) => path);
}

export function summarizeProvenance(records, path) {
  const ancestors = Object.entries(records || {}).filter(([candidate]) => path === candidate || path.startsWith(`${candidate}/`));
  ancestors.sort((left, right) => right[0].length - left[0].length);
  if (ancestors.length) return ancestors[0][1];
  const descendants = Object.entries(records || {}).filter(([candidate]) => candidate.startsWith(`${path}/`));
  if (!descendants.length) return null;
  const sources = [...new Set(descendants.map(([, record]) => record.source))].sort();
  const updatedAt = descendants.map(([, record]) => record.updatedAt).filter(Boolean).sort().at(-1);
  return { source: sources.length === 1 ? sources[0] : `mixed: ${sources.join(", ")}`, updatedAt };
}

export function tagsFromInput(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result).split(",", 2)[1] || ""));
    reader.addEventListener("error", () => reject(new Error("The selected file could not be read.")));
    reader.readAsDataURL(file);
  });
}

export function resumeAssignmentText(resume) {
  const explicit = Number.isInteger(resume?.assignedJobCount) ? resume.assignedJobCount : 0;
  const implicit = Number.isInteger(resume?.implicitJobCount) ? resume.implicitJobCount : 0;
  return `${explicit} explicitly assigned active job${explicit === 1 ? "" : "s"}${implicit ? `; ${implicit} active job${implicit === 1 ? "" : "s"} use this default` : ""}.`;
}

export function typedDeletePhrase(type) {
  return `DELETE ${String(type || "").toUpperCase()}`;
}

export function filterTrashItems(items, type = "") {
  return (items || []).filter((item) => !type || item.type === type);
}

export function trashBlockerText(item) {
  const counts = item?.blockerCounts || {};
  const total = Object.values(counts).reduce(
    (sum, value) => sum + (Number.isInteger(value) ? value : 0), 0,
  );
  return total ? `${total} protected reference${total === 1 ? "" : "s"}` : "No known references";
}

export function lifecycleErrorText(error) {
  if (error?.code === "revision_conflict") {
    return "This record changed elsewhere. Nothing was retried; refresh Trash and review the latest revision.";
  }
  const protectedCount = Object.values(error?.counts || {}).reduce(
    (sum, value) => sum + (Number.isInteger(value) ? value : 0), 0,
  );
  const suffix = protectedCount
    ? ` (${protectedCount} protected reference${protectedCount === 1 ? "" : "s"}.)`
    : "";
  return `${error?.message || "The lifecycle operation was rejected."}${suffix}`;
}

export function shouldUseResumeResponse(requestId, latestRequestId, requestedTrash, currentTrash) {
  return requestId === latestRequestId && requestedTrash === currentTrash;
}

const hasDom = typeof document !== "undefined";

if (hasDom) {
  const token = sessionToken(location.hash, safeSessionStorage(globalThis));
  if (location.hash) history.replaceState(null, "", location.pathname);
  const api = createApi(token);
  const state = { jobs: [], resumes: [], selected: null, latest: null, draft: null, dirty: false, dirtyFields: new Set(), polling: false, opener: null, openerJobId: null, focusAfterClose: null, focusAfterCloseJobId: null, activity: null, activityJobId: null };
  const profileState = { inspection: null, drafts: new Map(), draftBases: new Map(), atomic: new Set(), additionalAtomic: new Set(), deletions: new Set(), conflicts: [], latest: null, loaded: false };
  const resumeState = { items: [], proposals: [], trash: false, loaded: false, loading: false, requestId: 0, selected: null, opener: null, proposal: null, dirtyMetadata: new Set() };
  const answerState = { items: [], loaded: false, selected: null, offset: 0, limit: 25, total: 0, dirty: new Set(), opener: null, requestSequence: 0, detailRequestSequence: 0, dialogGeneration: 0, mergeRequestSequence: 0, mergeSource: null, mergeCandidates: [], busyControls: null };
  const trashState = { items: [], counts: { job: 0, resume: 0, answer: 0 }, loaded: false, selected: null, opener: null };
  const trashRefreshCoordinator = createLatestRequestCoordinator();
  const activityRefreshCoordinator = createLatestRequestCoordinator();
  const jobCardRenderKeys = new WeakMap();
  const $ = (selector) => document.querySelector(selector);
  const form = $("#job-form");
  const dialog = $("#job-dialog");
  const statusLabel = (value) => String(value || "saved").replaceAll("_", " ");
  const escapeText = (value) => String(value ?? "");

  function toast(message) {
    const node = $("#toast"); node.textContent = message; node.classList.remove("hidden");
    clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.add("hidden"), 3500);
  }

  function setConnection(online, message = online ? "Canonical store connected" : "Connection lost") {
    $("#connection-dot").classList.toggle("online", online); $("#connection-label").textContent = message;
  }

  const namedTopLevel = new Set(["firstName", "lastName", "email", "phone", "location", "linkedInUrl", "portfolioUrl", "githubUrl", "workHistory", "education", "skills", "preferences"]);
  const encodePointer = (value) => String(value).replaceAll("~", "~0").replaceAll("/", "~1");
  const decodePointer = (value) => String(value).replaceAll("~1", "/").replaceAll("~0", "~");
  const equalJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

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
    $("#facts-revision").textContent = `Revision ${inspection.revision}`;
    $("#facts-status").textContent = profileState.drafts.size ? "Draft changes are preserved against the latest profile." : "Profile is synchronized with the canonical store.";
    $("#facts-conflict").classList.add("hidden"); $("#facts-error").classList.add("hidden");
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
      const inspection = await api("/api/profile"); renderProfile(inspection, drafts, draftBases, deletions); setConnection(true);
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

  function trashActionPath(item, action) {
    if (item.type === "answer") return answerApiPath(item.id, action);
    return `/api/${item.type === "resume" ? "resumes" : "jobs"}/${encodeURIComponent(item.id)}/${action}`;
  }

  function renderTrash() {
    const type = $("#trash-type-filter").value;
    const items = filterTrashItems(trashState.items, type);
    $("#trash-nav-count").textContent = String(trashState.items.length);
    $("#trash-counts").textContent = `${trashState.counts.job} jobs · ${trashState.counts.resume} resumes · ${trashState.counts.answer} answers`;
    $("#trash-status").textContent = `${items.length} trashed ${type || "record"}${items.length === 1 ? "" : "s"} in this view.`;
    $("#trash-empty").classList.toggle("hidden", items.length !== 0);
    const list = $("#trash-list"); list.replaceChildren();
    for (const item of items) {
      const card = document.createElement("article"); card.className = "trash-card"; card.setAttribute("role", "listitem");
      const body = document.createElement("div"); const kind = document.createElement("p"); kind.className = "eyebrow"; kind.textContent = item.type;
      const heading = document.createElement("h3"); heading.textContent = item.label; const detail = document.createElement("p"); detail.textContent = trashBlockerText(item); body.append(kind, heading, detail);
      const actions = document.createElement("div"); actions.className = "button-row";
      const restore = document.createElement("button"); restore.type = "button"; restore.className = "button secondary"; restore.textContent = "Restore";
      restore.addEventListener("click", () => restoreTrashItem(item, restore));
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "button danger"; remove.textContent = "Delete permanently…";
      remove.addEventListener("click", () => openTrashDelete(item, remove)); actions.append(restore, remove); card.append(body, actions); list.append(card);
    }
  }

  async function refreshTrash({ quiet = false } = {}) {
    await trashRefreshCoordinator.run(
      () => api("/api/trash"),
      (result) => {
        trashState.items = result.items; trashState.counts = result.counts; trashState.loaded = true; renderTrash(); setConnection(true);
        $("#trash-error").classList.add("hidden"); if (!quiet) toast("Trash refreshed from the canonical store");
      },
      (error) => { const node = $("#trash-error"); node.textContent = error.message; node.classList.remove("hidden"); setConnection(false, error.message); },
    );
  }

  async function restoreTrashItem(item, control) {
    control.disabled = true;
    try {
      await api(trashActionPath(item, "restore"), { method: "POST", body: JSON.stringify({ expectedRevision: item.revision }) });
      await Promise.all([refresh({ quiet: true }), refreshTrash({ quiet: true })]); toast(`${item.type} restored`);
    } catch (error) {
      const node = $("#trash-error"); node.textContent = lifecycleErrorText(error); node.classList.remove("hidden");
      if (error.code === "revision_conflict") await refreshTrash({ quiet: true });
    } finally { control.disabled = false; }
  }

  function openTrashDelete(item, opener) {
    trashState.selected = { ...item }; trashState.opener = opener;
    const phrase = typedDeletePhrase(item.type); $("#trash-delete-identity").textContent = `${item.type}: ${item.label}`; $("#trash-delete-phrase").textContent = phrase;
    $("#trash-delete-impact").textContent = item.type === "resume"
      ? "This permanently deletes the selected canonical resume record and its managed resume file. It does not affect unrelated jobs or erase application history, sessions, or audit evidence."
      : "This permanently deletes only the selected canonical record. It does not cascade or erase application history, sessions, or audit evidence.";
    $("#trash-delete-input").value = ""; $("#trash-delete-confirm").disabled = true; $("#trash-delete-error").classList.add("hidden"); $("#trash-delete-conflict").classList.add("hidden");
    $("#trash-delete-dialog").showModal(); setTimeout(() => $("#trash-delete-input").focus(), 0);
  }

  async function submitTrashDelete(event) {
    event.preventDefault(); const item = trashState.selected; if (!item) return;
    if ($("#trash-delete-input").value !== typedDeletePhrase(item.type)) return;
    $("#trash-delete-confirm").disabled = true;
    try {
      await api(trashActionPath(item, "delete"), { method: "POST", body: JSON.stringify({ expectedRevision: item.revision }) });
      $("#trash-delete-dialog").close();
      if (item.type === "answer" && $("#answer-dialog").open) $("#answer-dialog").close();
      if (item.type === "resume" && $("#resume-dialog").open) $("#resume-dialog").close();
      await Promise.all([refresh({ quiet: true }), refreshTrash({ quiet: true }), answerState.loaded ? refreshAnswers() : Promise.resolve(), resumeState.loaded ? refreshResumes({ quiet: true }) : Promise.resolve()]); toast(`${item.type} permanently deleted`);
    } catch (error) {
      if (error.code === "revision_conflict") { $("#trash-delete-conflict").classList.remove("hidden"); $("#trash-delete-conflict").focus(); }
      else { $("#trash-delete-error").textContent = lifecycleErrorText(error); $("#trash-delete-error").classList.remove("hidden"); }
      $("#trash-delete-confirm").disabled = false;
    }
  }

  async function showWorkspace(name) {
    const facts = name === "facts";
    const resumes = name === "resumes";
    const answers = name === "answers";
    const trash = name === "trash";
    $("#jobs-workspace").classList.toggle("hidden", facts || resumes || answers || trash); $("#facts-workspace").classList.toggle("hidden", !facts); $("#resumes-workspace").classList.toggle("hidden", !resumes); $("#answers-workspace").classList.toggle("hidden", !answers); $("#trash-workspace").classList.toggle("hidden", !trash);
    for (const section of ["jobs", "facts", "resumes", "answers", "trash"]) { const active = name === section; $(`#nav-${section}`).classList.toggle("active", active); $(`#nav-${section}`).toggleAttribute("aria-current", active); }
    document.title = `${facts ? "Facts" : resumes ? "Resumes" : answers ? "Answers" : trash ? "Trash" : "Jobs"} · Job Apply Workspace`;
    if (facts && !profileState.loaded) await refreshProfile({ preserve: false });
    if (resumes && !resumeState.loaded) await refreshResumes();
    if (answers && !answerState.loaded) await refreshAnswers();
    if (trash && !trashState.loaded) await refreshTrash();
  }

  function answerError(message, dialogError = false) { const node = $(dialogError ? "#answer-error" : "#answers-error"); node.textContent = message; node.classList.remove("hidden"); }

  function setAnswerBusy(busy) {
    if (busy) {
      if (answerState.busyControls) return;
      answerState.busyControls = [...$("#answer-form").elements]
        .filter((control) => !control.matches("[data-close]"))
        .map((control) => [control, control.disabled]);
      for (const [control] of answerState.busyControls) control.disabled = true;
      return;
    }
    for (const [control, disabled] of answerState.busyControls || []) control.disabled = disabled;
    answerState.busyControls = null;
  }

  function renderAnswers() {
    const list = $("#answer-list"); list.replaceChildren();
    $("#answers-empty").classList.toggle("hidden", answerState.items.length !== 0);
    for (const answer of answerState.items) {
      const item = document.createElement("div"); item.setAttribute("role", "listitem");
      const button = document.createElement("button"); button.type = "button"; button.className = "answer-card"; button.dataset.key = answer.key;
      const primary = document.createElement("div"); const heading = document.createElement("h3"); heading.textContent = answer.question || answer.key; const summary = document.createElement("p"); summary.textContent = answerSummary(answer); summary.classList.toggle("redacted", answer.valueRedacted === true); primary.append(heading, summary);
      const metadata = document.createElement("p"); metadata.textContent = `${answer.state} · ${answer.reviewStatus} · revision ${answer.revision}`;
      const references = document.createElement("p"); references.textContent = `${answer.referenceCounts?.total || 0} reference${answer.referenceCounts?.total === 1 ? "" : "s"}`;
      button.append(primary, metadata, references); button.addEventListener("click", () => openAnswer(answer, button)); item.append(button); list.append(item);
    }
    const first = answerState.total === 0 ? 0 : answerState.offset + 1; const last = answerState.offset + answerState.items.length;
    $("#answers-status").textContent = `${answerState.total} canonical record${answerState.total === 1 ? "" : "s"} in this view; showing ${first}–${last}. Values are not included in this list.`;
    $("#answers-previous").disabled = answerState.offset === 0; $("#answers-next").disabled = answerState.offset + answerState.items.length >= answerState.total;
  }

  async function refreshAnswers({ reset = false } = {}) {
    if (reset) answerState.offset = 0;
    $("#answers-error").classList.add("hidden");
    const view = $("#answer-view").value;
    const requestSequence = ++answerState.requestSequence;
    try {
      const result = await api("/api/answers/query", { method: "POST", body: JSON.stringify({ query: $("#answer-search").value, state: $("#answer-state-filter").value || null, reviewStatus: view === "trash" ? null : view, includeTrashed: view === "trash", trashedOnly: view === "trash", offset: answerState.offset, limit: answerState.limit }) });
      if (requestSequence !== answerState.requestSequence) return;
      answerState.items = result.items; answerState.total = result.total; answerState.loaded = true; renderAnswers(); setConnection(true);
    } catch (error) { if (requestSequence !== answerState.requestSequence) return; answerError(error.message); setConnection(false, error.message); }
  }

  function syncSensitiveConsent() {
    const form = $("#answer-form");
    const sensitive = form.elements.state.value === "sensitive" || form.elements.sensitivity.value !== "none";
    $("#remember-sensitive-label").classList.toggle("hidden", !sensitive);
    if (!sensitive) form.elements.rememberSensitive.checked = false;
  }

  function populateAnswerForm(answer) {
    setAnswerBusy(false);
    const form = $("#answer-form");
    form.elements.question.value = answer?.question || ""; form.elements.aliases.value = (answer?.aliases || []).join("\n"); form.elements.state.value = answer?.state || "confirmed"; form.elements.sensitivity.value = answer?.sensitivity || "none"; form.elements.scope.value = JSON.stringify(answer?.scope || {}, null, 2); form.elements.value.value = answer?.value ?? ""; form.elements.rememberSensitive.checked = false; syncSensitiveConsent();
    form.elements.question.required = !answer;
    answerState.dirty.clear(); $("#answer-error").classList.add("hidden"); $("#answer-conflict").classList.add("hidden");
    const pending = answer?.reviewStatus === "pending"; const trashed = answer?.deletedAt != null;
    $("#answer-reveal").classList.toggle("hidden", !canRevealAnswer(answer)); $("#answer-merge").classList.toggle("hidden", !answer || trashed); $("#answer-accept").classList.toggle("hidden", !pending || trashed); $("#answer-decline").classList.toggle("hidden", !pending || trashed); $("#answer-trash").classList.toggle("hidden", !answer || trashed); $("#answer-restore").classList.toggle("hidden", !trashed); $("#answer-delete").classList.toggle("hidden", !trashed); $("#answer-save").classList.toggle("hidden", trashed);
    $("#answer-reference-counts").textContent = answer ? `${answer.referenceCounts?.sessions || 0} session and ${answer.referenceCounts?.history || 0} history references.` : "";
  }

  async function openAnswer(answer, opener) {
    const requestSequence = ++answerState.detailRequestSequence;
    const requestedOpener = opener || document.activeElement;
    try {
      const selected = await api(answerApiPath(answer.key));
      if (requestSequence !== answerState.detailRequestSequence) return;
      answerState.dialogGeneration += 1; answerState.opener = requestedOpener; answerState.selected = selected; populateAnswerForm(selected);
      $("#answer-kicker").textContent = `CANONICAL · REVISION ${selected.revision}`; $("#answer-dialog").showModal(); setTimeout(() => $("#answer-form").elements.question.focus(), 0);
    } catch (error) { if (requestSequence === answerState.detailRequestSequence) answerError(error.message); }
  }
  function newAnswer() { answerState.detailRequestSequence += 1; answerState.dialogGeneration += 1; answerState.selected = null; answerState.opener = document.activeElement; populateAnswerForm(null); $("#answer-kicker").textContent = "NEW CANONICAL RECORD"; $("#answer-dialog").showModal(); setTimeout(() => $("#answer-form").elements.question.focus(), 0); }

  function answerFormPayload(onlyDirty = false) {
    const form = $("#answer-form"); let scope; try { scope = JSON.parse(form.elements.scope.value); } catch { throw new Error("Scope must be a valid JSON object."); } if (!scope || Array.isArray(scope) || typeof scope !== "object") throw new Error("Scope must be a JSON object.");
    const all = { question: form.elements.question.value, aliases: form.elements.aliases.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean), state: form.elements.state.value, sensitivity: form.elements.sensitivity.value, scope, value: form.elements.state.value === "missing" ? null : form.elements.value.value, source: "user" };
    if (!onlyDirty) return all;
    const patch = {}; for (const name of answerState.dirty) if (Object.hasOwn(all, name)) patch[name] = all[name]; return patch;
  }

  async function saveAnswer(event) {
    event.preventDefault();
    const selected = answerState.selected;
    const requestedKey = selected?.key ?? null;
    const dialogGeneration = answerState.dialogGeneration;
    try {
      const answer = answerFormPayload(Boolean(selected));
      if (selected && !Object.keys(answer).length) throw new Error("Change at least one field before saving.");
      const rememberSensitive = $("#answer-form").elements.rememberSensitive.checked;
      setAnswerBusy(true);
      const result = selected
        ? await api(answerApiPath(selected.key), { method: "PATCH", body: JSON.stringify({ patch: answer, expectedRevision: selected.revision, rememberSensitive }) })
        : await api("/api/answers", { method: "POST", body: JSON.stringify({ answer, rememberSensitive }) });
      const currentDialog = canApplyAnswerDialogMutation(answerState.selected, requestedKey, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open);
      if (currentDialog) { answerState.opener = null; $("#answer-dialog").close(); }
      await refreshAnswers({ reset: true });
      if (currentDialog) (document.querySelector(`.answer-card[data-key="${CSS.escape(result.key)}"]`) || $("#answer-new")).focus();
      toast(`Answer ${selected ? "updated" : "created"}`); return result;
    } catch (error) { if (!canApplyAnswerDialogMutation(answerState.selected, requestedKey, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open)) { toast(error.message); return; } if (error.status === 409) { $("#answer-conflict").classList.remove("hidden"); $("#answer-conflict").focus(); } else answerError(error.message, true); }
    finally { if (canApplyAnswerDialogMutation(answerState.selected, requestedKey, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open)) setAnswerBusy(false); }
  }

  async function answerAction(action) {
    const answer = answerState.selected; if (!answer) return;
    const dialogGeneration = answerState.dialogGeneration;
    setAnswerBusy(true);
    try {
      const payload = { expectedRevision: answer.revision };
      if (action === "accept") { payload.patch = answerFormPayload(true); payload.rememberSensitive = $("#answer-form").elements.rememberSensitive.checked; }
      await api(answerApiPath(answer.key, action), { method: "POST", body: JSON.stringify(payload) });
      const currentDialog = canApplyAnswerDialogMutation(answerState.selected, answer.key, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open);
      if (currentDialog) { answerState.opener = null; $("#answer-dialog").close(); }
      await refreshAnswers({ reset: true }); if (currentDialog) $("#answer-new").focus(); toast(`Answer ${action === "accept" ? "accepted" : action === "decline" ? "declined" : `${action}d`}`);
    }
    catch (error) { if (!canApplyAnswerDialogMutation(answerState.selected, answer.key, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open)) { toast(error.message); return; } if (error.code === "revision_conflict") { $("#answer-conflict").classList.remove("hidden"); $("#answer-conflict").focus(); } else answerError(lifecycleErrorText(error), true); }
    finally { if (canApplyAnswerDialogMutation(answerState.selected, answer.key, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open)) setAnswerBusy(false); }
  }

  async function mergeCandidates(source) {
    const items = [];
    for (let offset = 0; ; offset += 200) {
      const result = await api("/api/answers/query", { method: "POST", body: JSON.stringify({ reviewStatus: "accepted", offset, limit: 200 }) });
      items.push(...result.items);
      if (!result.hasMore) break;
    }
    return items.filter((item) => item.key !== source.key && sameAnswerScope(item.scope, source.scope));
  }

  async function openAnswerMerge() {
    const source = answerState.selected; if (!source) return;
    if (answerState.dirty.size) {
      answerError("Save this draft or close the answer details to discard it before merging.", true);
      $("#answer-error").focus();
      return;
    }
    const dialogGeneration = answerState.dialogGeneration;
    const mergeRequestSequence = ++answerState.mergeRequestSequence;
    const error = $("#answer-merge-error"); error.classList.add("hidden");
    try {
      const candidates = await mergeCandidates(source);
      if (
        mergeRequestSequence !== answerState.mergeRequestSequence
        || !canApplyAnswerDialogResponse(answerState.selected, source.key, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open)
        || answerState.selected.revision !== source.revision
        || answerState.dirty.size
      ) return;
      answerState.mergeSource = source;
      answerState.mergeCandidates = candidates;
      const select = $("#answer-merge-winner"); select.replaceChildren();
      select.append(new Option("Select an accepted winner", ""));
      for (const candidate of answerState.mergeCandidates) {
        select.append(new Option(`${candidate.question || candidate.key} · revision ${candidate.revision} · ${candidate.state} · ${answerSummary(candidate)}`, candidate.key));
      }
      const sourceLabel = source.question?.trim() || `Question not recorded (explicit key: ${source.key})`;
      const sourceValueStatus = source.hasValue ? "Its retained value will be discarded." : "It has no retained value to discard.";
      $("#answer-merge-source").textContent = `Duplicate source: ${sourceLabel} · ${source.reviewStatus} · revision ${source.revision}. ${sourceValueStatus}`;
      $("#answer-merge-confirm").disabled = answerState.mergeCandidates.length === 0;
      if (!answerState.mergeCandidates.length) {
        error.textContent = "No other accepted answer has this exact scope."; error.classList.remove("hidden");
      }
      $("#answer-merge-dialog").showModal(); setTimeout(() => select.focus(), 0);
    } catch (exception) { if (canApplyAnswerDialogResponse(answerState.selected, source.key, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open)) answerError(exception.message, true); }
  }

  async function submitAnswerMerge(event) {
    event.preventDefault();
    const source = answerState.mergeSource;
    const winner = answerState.mergeCandidates.find((item) => item.key === $("#answer-merge-winner").value);
    const dialogGeneration = answerState.dialogGeneration;
    const mergeRequestSequence = answerState.mergeRequestSequence;
    const error = $("#answer-merge-error"); error.classList.add("hidden");
    if (!source || !winner || answerState.selected?.key !== source.key || answerState.selected?.revision !== source.revision) { error.textContent = "The source answer changed. Close this confirmation and start the merge again."; error.classList.remove("hidden"); return; }
    setAnswerBusy(true);
    try {
      const merged = await api(answerApiPath(source.key, "merge"), { method: "POST", body: JSON.stringify({ winnerKey: winner.key, expectedWinnerRevision: winner.revision, expectedSourceRevision: source.revision }) });
      const currentDialog = canApplyAnswerDialogMutation(answerState.selected, source.key, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open);
      if (currentDialog) { answerState.opener = null; if ($("#answer-merge-dialog").open) $("#answer-merge-dialog").close(); $("#answer-dialog").close(); }
      await refreshAnswers({ reset: true });
      if (currentDialog) (document.querySelector(`.answer-card[data-key="${CSS.escape(merged.key)}"]`) || $("#answer-new")).focus(); toast("Duplicate merged into the selected canonical winner");
    } catch (exception) {
      if (mergeRequestSequence !== answerState.mergeRequestSequence || !canApplyAnswerDialogMutation(answerState.selected, source.key, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open && $("#answer-merge-dialog").open)) { toast(exception.message); return; }
      error.textContent = exception.status === 409 ? "The source or winner changed. Nothing was merged; close and reopen to select current revisions." : exception.message;
      error.classList.remove("hidden"); error.focus();
    } finally { if (canApplyAnswerDialogMutation(answerState.selected, source.key, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open)) setAnswerBusy(false); }
  }

  function resumeError(message, dialogError = false) { const node = $(dialogError ? "#resume-error" : "#resumes-error"); node.textContent = message; node.classList.remove("hidden"); }

  function assignmentText(resume) {
    return resumeAssignmentText(resume);
  }

  function proposalStatus(resumeId) {
    const items = resumeState.proposals.filter((item) => item.resumeId === resumeId);
    const pending = items.filter((item) => item.status === "pending");
    return { items, text: pending.length ? `${pending.length} pending extraction review${pending.length === 1 ? "" : "s"} · ${pending.reduce((sum, item) => sum + item.pendingCount, 0)} conflicts` : items.length ? "Extraction review complete" : "No extraction proposal" };
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
      const extraction = document.createElement("p"); extraction.textContent = proposalStatus(resume.id).text;
      const open = document.createElement("button"); open.type = "button"; open.className = "button secondary"; open.textContent = "Manage"; open.addEventListener("click", () => openResume(resume.id, open));
      card.append(heading, meta, tags, assignment, extraction, open); list.append(card);
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
          resumeState.selected.assignedJobCount = latest.assignedJobCount;
          resumeState.selected.implicitJobCount = latest.implicitJobCount;
          renderResumeDialog(resumeState.selected, true);
          if (latest.revision !== resumeState.selected.revision) { $("#resume-conflict").classList.remove("hidden"); $("#resume-conflict").focus(); }
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
    $("#resume-default").classList.toggle("hidden", resume.default || Boolean(resume.deletedAt)); $("#resume-trash-action").classList.toggle("hidden", Boolean(resume.deletedAt)); $("#resume-restore").classList.toggle("hidden", !resume.deletedAt); $("#resume-delete").classList.toggle("hidden", !resume.deletedAt);
    $("#resume-content").classList.toggle("hidden", resume.storageKind !== "managed" || Boolean(resume.deletedAt)); $("#resume-replace").classList.toggle("hidden", resume.storageKind !== "managed" || Boolean(resume.deletedAt)); $("#resume-adopt").classList.toggle("hidden", resume.storageKind === "managed" || Boolean(resume.deletedAt));
    const holder = $("#resume-proposals"); holder.replaceChildren();
    for (const proposal of status.items) { const row = document.createElement("div"); row.className = "proposal-summary"; const text = document.createElement("span"); text.textContent = `${proposal.status} · ${proposal.pendingCount} pending`; row.append(text); if (proposal.status === "pending") { const button = document.createElement("button"); button.type = "button"; button.className = "button secondary"; button.textContent = "Review"; button.addEventListener("click", () => openProposal(proposal.id)); row.append(button); } holder.append(row); }
  }

  function openResume(id, opener) { const resume = resumeState.items.find((item) => item.id === id); if (!resume) return; resumeState.opener = opener; resumeState.dirtyMetadata.clear(); $("#resume-form").elements.file.value = ""; $("#resume-error").classList.add("hidden"); $("#resume-conflict").classList.add("hidden"); renderResumeDialog(resume); $("#resume-dialog").showModal(); setTimeout(() => $("#resume-form").elements.label.focus(), 0); }

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
      for (const path of proposal.pendingPaths) {
        const row = document.createElement("fieldset"); row.className = "proposal-row"; const legend = document.createElement("legend"); legend.textContent = path;
        const current = document.createElement("pre"); current.textContent = `Current: ${JSON.stringify(proposal.currentValues[path]?.value)}`;
        const extracted = document.createElement("pre"); extracted.textContent = `Extracted: ${JSON.stringify(pointerValue(proposal.candidate, path))}`;
        const label = document.createElement("label"); label.append("Decision "); const select = document.createElement("select"); select.name = path; select.append(new Option("Decide later", ""), new Option("Use extracted", "use_extracted"), new Option("Keep current", "keep_current")); label.append(select);
        row.append(legend, current, extracted, label);
        const replacement = proposal.replacementScopes?.[path];
        if (replacement) {
          const warning = document.createElement("p"); warning.className = "conflict"; warning.textContent = `Using the extracted value will replace existing ${replacement.path}: ${JSON.stringify(replacement.value)}`;
          const confirmation = document.createElement("label"); const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.dataset.replacementPath = path; checkbox.value = replacement.path; confirmation.append(checkbox, ` I confirm replacing ${replacement.path}`);
          row.append(warning, confirmation);
        }
        holder.append(row);
      }
      $("#proposal-submit").disabled = Boolean(proposal.staleReasons?.length); $("#proposal-error").textContent = proposal.staleReasons?.length ? "This proposal is stale and cannot be reviewed. Create a fresh proposal through the CLI." : ""; $("#proposal-error").classList.toggle("hidden", !proposal.staleReasons?.length); $("#proposal-dialog").showModal();
    } catch (error) { resumeError(error.message, true); }
  }

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

  async function refresh({ quiet = false } = {}) {
    if (state.polling) return; state.polling = true;
    try {
      const data = await api("/api/state");
      if (state.dirty && state.selected) {
        const latest = data.jobs.find((job) => job.id === state.selected.id);
        if (latest && latest.revision !== state.selected.revision) {
          state.latest = latest; $("#sync-notice").textContent = "A canonical job changed while your draft is open. Your draft has not been replaced."; $("#sync-notice").classList.remove("hidden");
        }
      }
      state.jobs = data.jobs; state.resumes = data.resumes; render(); setConnection(true);
      if (!quiet) toast("Jobs refreshed from the canonical store");
    } catch (error) {
      setConnection(false, error.message); if (!quiet) showFormError(error.message);
    } finally { state.polling = false; }
  }

  function fillResumeOptions(selected) {
    const select = form.elements.resumeId; select.replaceChildren(new Option("Use default resume", ""));
    for (const resume of state.resumes) select.append(new Option(`${resume.label || resume.id}${resume.default ? " · default" : ""}`, resume.id));
    select.value = selected || "";
  }

  function fillForm(job) {
    for (const field of ["url", "role", "company", "location", "workplaceType", "employmentType", "compensation", "notes", "description", "priority"]) form.elements[field].value = job?.[field] ?? (field === "priority" ? 0 : "");
    fillResumeOptions(job?.resumeId); state.dirty = false; state.dirtyFields.clear(); hideConflict(); $("#form-error").classList.add("hidden");
  }

  function openNew() {
    rememberOpener();
    state.selected = null; state.latest = null; state.draft = null; fillForm(null); $("#job-dialog-title").textContent = "Capture a job"; $("#dialog-kicker").textContent = "NEW CANONICAL RECORD";
    state.activity = null; state.activityJobId = null; activityRefreshCoordinator.invalidate();
    for (const id of ["trash-job", "preflight-job", "mark-ready", "status-actions", "application-activity"]) $("#" + id).classList.add("hidden");
    dialog.showModal(); setTimeout(() => form.elements.url.focus(), 0);
  }

  function openExisting(id) {
    const job = state.jobs.find((item) => item.id === id); if (!job) return;
    rememberOpener(id);
    state.selected = job; state.latest = null; state.draft = null; fillForm(job); $("#job-dialog-title").textContent = job.role || "Job details"; $("#dialog-kicker").textContent = `${statusLabel(job.status).toUpperCase()} · REVISION ${job.revision}`;
    state.activity = null; state.activityJobId = id; prepareActivity(job); renderJobControls(job); dialog.showModal(); loadActivity(id); setTimeout(() => form.elements.role.focus(), 0);
  }

  function currentValues() { return Object.fromEntries(new FormData(form).entries()); }
  function showFormError(message) { const node = $("#form-error"); node.textContent = message; node.classList.remove("hidden"); }
  function hideConflict() { $("#conflict").classList.add("hidden"); $("#conflict-latest").replaceChildren(); $("#reload-latest").disabled = false; $("#rebase-draft").disabled = false; }

  async function showConflict() {
    const values = currentValues();
    state.draft = Object.fromEntries([...state.dirtyFields].map((field) => [field, values[field]]));
    const holder = $("#conflict-latest"); holder.replaceChildren();
    $("#reload-latest").disabled = false; $("#rebase-draft").disabled = false;
    try {
      state.latest = await api(`/api/jobs/${encodeURIComponent(state.selected.id)}`);
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

  async function preflight() {
    if (!state.selected) return; try {
      const result = await api(`/api/jobs/${encodeURIComponent(state.selected.id)}/preflight`); renderPreflight(result); return result;
    } catch (error) { showFormError(error.message); return null; }
  }

  const issueText = { profile_empty: "Complete your applicant profile", resume_missing: "Assign an active resume", resume_file_missing: "The resume file cannot be found", resume_file_changed: "The resume file changed since it was added", role_missing: "Add a role for clearer handoff", company_missing: "Add a company for clearer handoff" };
  function renderPreflight(result) {
    const panel = $("#preflight-panel"), body = $("#preflight-results"); body.replaceChildren();
    const summary = document.createElement("p"); summary.textContent = result.ready ? "No blocking issues. This job can be handed to a Job Apply agent." : "Resolve the blocking issues before marking this job ready."; body.append(summary);
    for (const [label, items] of [["Blocking", result.errors], ["Warnings", result.warnings]]) if (items.length) { const h = document.createElement("strong"); h.textContent = label; const ul = document.createElement("ul"); for (const code of items) { const li = document.createElement("li"); li.textContent = issueText[code] || code; ul.append(li); } body.append(h, ul); }
    panel.classList.remove("hidden"); $("#mark-ready").classList.toggle("hidden", !result.ready || !canMarkReadyFrom(state.selected?.status));
  }

  async function transition(status, userConfirmed = false, closedOutcome = null) {
    try {
      const body = { status, expectedRevision: state.selected.revision, userConfirmed };
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
    renderStatusActions(job);
  }

  const formatActivityTime = (value) => {
    if (!value) return "Not recorded";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  };

  function prepareActivity(job) {
    $("#application-activity").classList.remove("hidden");
    $("#activity-current-status").className = `status ${job.status}`;
    $("#activity-current-status").textContent = statusLabel(job.status);
    $("#activity-summary").textContent = `Canonical revision ${job.revision}. Loading durable activity…`;
    $("#activity-claim").textContent = "Checking agent attempt health…";
    $("#activity-recovery").classList.add("hidden");
    $("#activity-progress").classList.add("hidden");
    $("#activity-history-list").replaceChildren();
    $("#activity-history-empty").classList.remove("hidden");
  }

  function renderActivity(activity, announce = true) {
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
        row.textContent = `${item.question || "Information requested"} · ${statusLabel(item.state || "missing")}${item.sensitive ? " · sensitive" : ""}`;
        pending.append(row);
      }
      $("#activity-pending-wrap").classList.toggle("hidden", pending.children.length === 0);
    } else {
      progress.classList.add("hidden");
    }

    const historyList = $("#activity-history-list"); historyList.replaceChildren();
    for (const event of activity.history) {
      const row = document.createElement("li");
      const summary = document.createElement("strong"); summary.textContent = `${statusLabel(event.event)}${event.status ? ` · ${statusLabel(event.status)}` : ""}`;
      const at = document.createElement("time"); at.dateTime = event.at || ""; at.textContent = formatActivityTime(event.at);
      row.append(summary, at); historyList.append(row);
    }
    $("#activity-history-empty").classList.toggle("hidden", historyList.children.length !== 0);

    if (!state.dirty && state.selected && (state.selected.status !== status || state.selected.revision !== activity.job.revision)) {
      state.selected = { ...state.selected, status, revision: activity.job.revision };
      const listed = state.jobs.find((job) => job.id === state.selected.id);
      if (listed) Object.assign(listed, { status, revision: activity.job.revision });
      $("#dialog-kicker").textContent = `${statusLabel(status).toUpperCase()} · REVISION ${activity.job.revision}`;
      renderJobControls(state.selected);
      render();
    }
    const message = activityAnnouncement(previous, activity);
    if (announce && message) $("#activity-live").textContent = message;
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
        $("#activity-summary").textContent = `Durable activity could not be refreshed: ${error.message}`;
      },
    );
  }

  function jobButton(id) { return document.querySelector(`[data-id="${CSS.escape(id)}"]`); }
  function rememberOpener(jobId = null) {
    state.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    state.openerJobId = jobId;
    state.focusAfterClose = null;
    state.focusAfterCloseJobId = null;
  }
  function closeJobDialog(destination = null, destinationJobId = null) {
    state.focusAfterClose = destination;
    state.focusAfterCloseJobId = destinationJobId || destination?.dataset?.id || null;
    dialog.close();
  }
  function firstListDestination() { return $(".job-card") || $("#new-job"); }

  form.addEventListener("submit", save); form.addEventListener("input", (event) => { if (state.selected && event.target.name) { state.dirty = true; state.dirtyFields.add(event.target.name); } });
  $("#nav-jobs").addEventListener("click", () => showWorkspace("jobs")); $("#nav-facts").addEventListener("click", () => showWorkspace("facts")); $("#nav-resumes").addEventListener("click", () => showWorkspace("resumes")); $("#nav-answers").addEventListener("click", () => showWorkspace("answers")); $("#nav-trash").addEventListener("click", () => showWorkspace("trash"));
  $("#trash-refresh").addEventListener("click", () => refreshTrash()); $("#trash-type-filter").addEventListener("change", renderTrash);
  $("#trash-delete-input").addEventListener("input", () => { $("#trash-delete-confirm").disabled = $("#trash-delete-input").value !== typedDeletePhrase(trashState.selected?.type); });
  $("#trash-delete-form").addEventListener("submit", submitTrashDelete);
  $("#trash-conflict-refresh").addEventListener("click", async () => { $("#trash-delete-dialog").close(); await refreshTrash({ quiet: true }); $("#trash-list").focus(); });
  $("#answers-refresh").addEventListener("click", () => refreshAnswers()); $("#answer-new").addEventListener("click", newAnswer); $("#answer-search").addEventListener("input", () => refreshAnswers({ reset: true })); $("#answer-view").addEventListener("change", () => refreshAnswers({ reset: true })); $("#answer-state-filter").addEventListener("change", () => refreshAnswers({ reset: true }));
  $("#answers-previous").addEventListener("click", () => { answerState.offset = Math.max(0, answerState.offset - answerState.limit); refreshAnswers(); }); $("#answers-next").addEventListener("click", () => { answerState.offset += answerState.limit; refreshAnswers(); });
  $("#answer-form").addEventListener("submit", saveAnswer); $("#answer-form").addEventListener("input", (event) => { if (event.target.name && event.target.name !== "rememberSensitive") answerState.dirty.add(event.target.name); if (["state", "sensitivity"].includes(event.target.name)) syncSensitiveConsent(); });
  $("#answer-reveal").addEventListener("click", async () => { const requestedKey = answerState.selected.key; const dialogGeneration = answerState.dialogGeneration; setAnswerBusy(true); try { const revealed = await api(answerApiPath(requestedKey, "reveal"), { method: "POST", body: "{}" }); if (!canApplyAnswerDialogResponse(answerState.selected, requestedKey, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open)) return; if (!canApplyAnswerReveal(answerState.selected, requestedKey, revealed)) { answerError("This answer changed identity while its value was being revealed. Nothing was placed in the dialog; close it and review the canonical answer.", true); return; } $("#answer-form").elements.value.value = revealed.value ?? ""; $("#answer-reveal").classList.add("hidden"); toast("Sensitive value revealed for this dialog"); } catch (error) { if (canApplyAnswerDialogResponse(answerState.selected, requestedKey, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open)) answerError(error.message, true); } finally { if (canApplyAnswerDialogResponse(answerState.selected, requestedKey, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open)) setAnswerBusy(false); } });
  $("#answer-merge").addEventListener("click", openAnswerMerge); $("#answer-merge-form").addEventListener("submit", submitAnswerMerge);
  $("#answer-merge-dialog").addEventListener("close", () => { if ($("#answer-merge-dialog").open) return; answerState.mergeRequestSequence += 1; answerState.mergeSource = null; answerState.mergeCandidates = []; });
  $("#answer-accept").addEventListener("click", () => answerAction("accept")); $("#answer-decline").addEventListener("click", () => answerAction("decline")); $("#answer-trash").addEventListener("click", () => { if (confirm("Move this answer to trash?")) answerAction("trash"); }); $("#answer-restore").addEventListener("click", () => answerAction("restore")); $("#answer-delete").addEventListener("click", () => openTrashDelete({ type: "answer", id: answerState.selected.key, revision: answerState.selected.revision, label: answerState.selected.question || answerState.selected.key }, $("#answer-delete")));
  $("#answer-conflict-refresh").addEventListener("click", async () => { const selected = answerState.selected; const dialogGeneration = answerState.dialogGeneration; setAnswerBusy(true); try { const latest = await api(answerApiPath(selected.key)); if (!canApplyAnswerDialogResponse(answerState.selected, selected.key, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open)) return; if (!canRefreshAnswerDraft(selected, latest)) { answerError("This source answer changed identity while its canonical revision was being refreshed. Its preserved draft was not retargeted; close this dialog and review the current answer separately.", true); return; } answerState.selected = latest; $("#answer-conflict").classList.add("hidden"); $("#answer-kicker").textContent = `CANONICAL · REVISION ${answerState.selected.revision} · DRAFT PRESERVED`; toast("Canonical revision refreshed; review your preserved draft"); } catch (error) { if (canApplyAnswerDialogResponse(answerState.selected, selected.key, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open)) answerError(error.message, true); } finally { if (canApplyAnswerDialogResponse(answerState.selected, selected.key, dialogGeneration, answerState.dialogGeneration, $("#answer-dialog").open)) setAnswerBusy(false); } });
  $("#answer-dialog").addEventListener("close", () => { if ($("#answer-dialog").open) return; setAnswerBusy(false); answerState.dialogGeneration += 1; answerState.mergeRequestSequence += 1; answerState.mergeSource = null; answerState.selected = null; answerState.dirty.clear(); $("#answer-form").elements.value.value = ""; $("#answer-form").elements.rememberSensitive.checked = false; const target = answerState.opener?.isConnected ? answerState.opener : $("#answer-new"); target.focus(); answerState.opener = null; });
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
  $("#resume-content").addEventListener("click", async () => { const resume = resumeState.selected; try { const response = await fetch(`/api/resumes/${encodeURIComponent(resume.id)}/content`, { headers: { Authorization: `Bearer ${token}` } }); if (!response.ok) { let payload = null; try { payload = await response.json(); } catch {} throw new ApiError(response.status, payload); } if (resume.mediaType?.startsWith("text/plain")) { $("#resume-preview").textContent = await response.text(); $("#preview-dialog").showModal(); } else { const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.target = "_blank"; link.rel = "noopener"; if (resume.mediaType?.includes("wordprocessingml")) link.download = `resume-${resume.id}.docx`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000); } } catch (error) { resumeError(error.message, true); } });
  $("#proposal-form").addEventListener("submit", async (event) => { event.preventDefault(); const proposal = resumeState.proposal; const decisions = {}; const replacementConfirmations = {}; for (const select of event.currentTarget.querySelectorAll("select[name]")) if (select.value) decisions[select.name] = select.value; if (!Object.keys(decisions).length) { $("#proposal-error").textContent = "Select at least one decision."; $("#proposal-error").classList.remove("hidden"); return; } for (const [path, decision] of Object.entries(decisions)) { const replacement = proposal.replacementScopes?.[path]; if (decision === "use_extracted" && replacement) { const checkbox = event.currentTarget.querySelector(`[data-replacement-path="${CSS.escape(path)}"]`); if (!checkbox?.checked) { $("#proposal-error").textContent = `Confirm that accepting ${path} replaces ${replacement.path}.`; $("#proposal-error").classList.remove("hidden"); return; } replacementConfirmations[path] = replacement.path; } } try { await api(`/api/resume-proposals/${encodeURIComponent(proposal.id)}/review`, { method: "POST", body: JSON.stringify({ decisions, replacementConfirmations, expectedRevision: proposal.revision, expectedProfileRevision: proposal.liveProfileRevision }) }); $("#proposal-dialog").close(); await refreshProfile({ preserve: true }); await refreshResumes({ quiet: true }); if (resumeState.selected) { const latest = resumeState.items.find((item) => item.id === resumeState.selected.id); if (latest) renderResumeDialog(latest, true); } toast("Selected extraction decisions applied to Facts"); } catch (error) { $("#proposal-error").textContent = error.status === 409 ? "The proposal or profile changed. Nothing was retried; refresh and review the latest canonical values." : error.message; $("#proposal-error").classList.remove("hidden"); } });
  $("#facts-form").addEventListener("input", (event) => { const control = event.target.closest("[data-path]"); if (control) markFactDirty(control); });
  $("#add-work").addEventListener("click", () => addRepeaterItem("/workHistory")); $("#add-education").addEventListener("click", () => addRepeaterItem("/education"));
  $("#facts-save").addEventListener("click", saveFacts); $("#facts-refresh").addEventListener("click", () => refreshProfile());
  $("#facts-use-latest").addEventListener("click", () => resolveFactConflicts(false)); $("#facts-use-mine").addEventListener("click", () => resolveFactConflicts(true));
  $("#new-job").addEventListener("click", openNew); $("#empty-create").addEventListener("click", openNew); $("#refresh").addEventListener("click", () => refresh());
  $("#search").addEventListener("input", render); $("#status-filter").addEventListener("change", render);
  $("#preflight-job").addEventListener("click", preflight); $("#mark-ready").addEventListener("click", async () => { const result = await preflight(); if (result?.ready) transition("ready"); });
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
    activityRefreshCoordinator.invalidate(); state.activity = null; state.activityJobId = null; $("#activity-live").textContent = "";
    state.dirty = false; state.dirtyFields.clear(); state.draft = null; $("#sync-notice").classList.add("hidden");
    const destinationJobId = state.focusAfterCloseJobId || state.focusAfterClose?.dataset?.id || state.openerJobId;
    const destinationFallback = state.focusAfterClose || state.opener || $("#new-job");
    state.focusAfterClose = null; state.focusAfterCloseJobId = null; state.opener = null; state.openerJobId = null;
    render();
    queueMicrotask(() => {
      if (dialog.open || document.querySelector("dialog[open]")) return;
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

  if (!token) { setConnection(false, "Workspace token missing — restart with the printed URL"); $("#loading").innerHTML = "<p>Open the complete URL printed by the workspace launcher.</p>"; }
  else { refresh({ quiet: true }); refreshTrash({ quiet: true }); setInterval(() => { refresh({ quiet: true }); if (dialog.open && state.selected) loadActivity(); if (resumeState.loaded) refreshResumes({ quiet: true }); if (trashState.loaded) refreshTrash({ quiet: true }); }, 4000); }
}
