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

export function shouldUseActivityResponse(activity, ...knownJobs) {
  const responseJob = activity?.job;
  if (!Number.isInteger(responseJob?.revision)) return false;
  const knownRevision = Math.max(0, ...knownJobs
    .filter((job) => Number.isInteger(job?.revision))
    .map((job) => job.revision));
  return responseJob.revision >= knownRevision;
}

export function newestCanonicalJob(current, incoming) {
  if (!current) return incoming;
  if (!incoming || current.id !== incoming.id) return current;
  const currentRevision = Number.isInteger(current.revision) ? current.revision : 0;
  const incomingRevision = Number.isInteger(incoming.revision) ? incoming.revision : 0;
  return incomingRevision >= currentRevision ? incoming : current;
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

export function attentionMembershipSignature(projection) {
  return JSON.stringify((projection?.items || []).map((item) => [item.jobId, item.reasonCode]));
}

export function attentionAnnouncement(previous, current) {
  if (!previous || attentionMembershipSignature(previous) === attentionMembershipSignature(current)) return "";
  const count = current?.items?.length || 0;
  return `Needs Attention queue updated. ${count} job${count === 1 ? "" : "s"} now require action.`;
}

export function attentionMissingInformationText(item) {
  if (item?.reasonCode !== "needs_information") return "";
  const count = Number.isInteger(item.missingInformationCount) ? item.missingInformationCount : 0;
  return ` · ${count} missing information item${count === 1 ? "" : "s"}`;
}

export function attentionBlockerSummary(item) {
  const blockers = item?.session?.blockers || [];
  const knownDataBrowserFailure = item?.reasonCode === "browser_action_required"
    && blockers.length === 2
    && blockers.some((entry) => entry.type === "browser_handoff" && entry.code === "unsupported-control")
    && blockers.some((entry) => entry.type === "information" && entry.code === "owner-input-required");
  if (knownDataBrowserFailure) {
    return "Browser action required: unsupported control. Saved information is already known.";
  }
  return blockers.length
    ? `${blockers.length} typed blocker${blockers.length === 1 ? "" : "s"}: ${blockers.map((entry) => entry.code).join(", ")}`
    : "No typed blockers recorded.";
}

export function ownerBetaNextStep(action) {
  return ({
    import_resume: ["Import a resume", "Add a private managed resume so agents have an approved document to use."],
    review_facts: ["Review your application facts", "Confirm the local facts agents may use before you prepare a job."],
    resolve_attention: ["Resolve Needs Attention", "A job needs human review, missing information, or interrupted-work recovery."],
    handoff_ready_job: ["Hand off a ready job", "Copy the supported invocation below and let the agent acquire the canonical Ready job."],
    capture_job: ["Capture your first job", "Save an opportunity, run its ready check, and mark it Ready for an agent."],
    prepare_job: ["Prepare the next job", "Open Jobs, complete missing setup, run the ready check, and mark a job Ready."],
  })[action] || ["Review the workspace", "Refresh the canonical Store and choose a workspace section."];
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

export function extractionRequestView(request, proposalSummary) {
  if (!request || request.status === "cancelled") {
    return { label: "Facts not extracted", action: "request", tone: "neutral" };
  }
  if (request.status === "requested") {
    return { label: "Waiting for a Job Apply agent", action: "cancel", tone: "waiting" };
  }
  if (request.status === "failed") {
    return { label: "Fact extraction did not complete", action: "retry", tone: "warning" };
  }
  if (request.status === "stale") {
    return { label: "The resume changed after this request", action: "fresh", tone: "warning" };
  }
  if (request.status === "completed" && proposalSummary?.status === "pending" && proposalSummary.staleReasons?.length) {
    return { label: "Extraction review is no longer current", action: "fresh", tone: "warning" };
  }
  if (request.status === "completed" && proposalSummary?.status === "pending") {
    return { label: "Extracted changes need review", action: "review", tone: "review" };
  }
  return { label: "Extracted facts were applied or reviewed", action: "facts", tone: "complete" };
}

export function proposalGroupForPath(path) {
  const top = String(path || "").split("/")[1] || "";
  if (["firstName", "lastName"].includes(top)) return "Identity";
  if (["email", "phone"].includes(top)) return "Contact";
  if (top === "location") return "Location";
  if (top === "workHistory") return "Experience";
  if (top === "education") return "Education";
  if (top === "skills") return "Skills";
  if (["linkedInUrl", "portfolioUrl", "githubUrl"].includes(top)) return "Links";
  return "Additional";
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
