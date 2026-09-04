import {
  assert,
  resolve,
  test,
  ApiError,
  FACT_SAVE_REVISION_RETRIES,
  canMarkReadyFrom,
  createApi,
  createLatestRequestCoordinator,
  extractionRequestView,
  filterJobs,
  formPatch,
  filterTrashItems,
  lifecycleErrorText,
  proposalGroupForPath,
  resumeAssignmentText,
  safeSessionStorage,
  sessionToken,
  shouldRetryFactSave,
  shouldUseResumeResponse,
  tagsFromInput,
  trashBlockerText,
  tokenFromHash,
  transitionsFor,
  typedDeletePhrase,
} from "./workspace_test_support.mjs";

test("unified Trash helpers filter types and require exact type-specific phrases", () => {
  const items = [
    { type: "job", blockerCounts: { claims: 0, nonterminalSessions: 1 } },
    { type: "resume", blockerCounts: { jobReferences: 0 } },
  ];
  assert.deepEqual(filterTrashItems(items, "job"), [items[0]]);
  assert.deepEqual(filterTrashItems(items, ""), items);
  assert.equal(typedDeletePhrase("answer"), "DELETE ANSWER");
  assert.equal(trashBlockerText(items[0]), "1 protected reference");
  assert.equal(trashBlockerText(items[1]), "No known references");
  const blocker = new ApiError(409, { error: { code: "history_reference_blocked", message: "Protected history blocks deletion.", recordType: "answer", operation: "delete", counts: { sessions: 0, history: 2 } } });
  assert.equal(blocker.recordType, "answer");
  assert.equal(blocker.operation, "delete");
  assert.equal(lifecycleErrorText(blocker), "Protected history blocks deletion. (2 protected references.)");
  assert.match(lifecycleErrorText(new ApiError(409, { error: { code: "revision_conflict", message: "ignored" } })), /changed elsewhere.*Nothing was retried/);
});


test("unified Trash helpers ignore stale success and failure side effects", async () => {
  const deferred = () => {
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
    return { promise, resolve: resolvePromise, reject: rejectPromise };
  };
  const state = {
    items: [], counts: { job: 0, resume: 0, answer: 0 }, loaded: false,
    rendered: [], connection: "starting", error: "starting", toasts: [],
  };
  const applySuccess = (result) => {
    state.items = result.items;
    state.counts = result.counts;
    state.loaded = true;
    state.rendered = result.items.map((item) => item.label);
    state.connection = "online";
    state.error = null;
    state.toasts.push("refreshed");
  };
  const applyFailure = (error) => {
    state.connection = "offline";
    state.error = error.message;
  };
  const coordinator = createLatestRequestCoordinator();

  const staleSuccess = deferred();
  const latestSuccess = deferred();
  const staleSuccessRun = coordinator.run(() => staleSuccess.promise, applySuccess, applyFailure);
  const latestSuccessRun = coordinator.run(() => latestSuccess.promise, applySuccess, applyFailure);
  latestSuccess.resolve({ items: [{ type: "job", label: "new canonical item" }], counts: { job: 1, resume: 0, answer: 0 } });
  assert.equal(await latestSuccessRun, true);
  const afterLatestSuccess = structuredClone(state);
  staleSuccess.resolve({ items: [{ type: "answer", label: "stale item" }], counts: { job: 0, resume: 0, answer: 1 } });
  assert.equal(await staleSuccessRun, false);
  assert.deepEqual(state, afterLatestSuccess);

  const staleFailure = deferred();
  const newestSuccess = deferred();
  const staleFailureRun = coordinator.run(() => staleFailure.promise, applySuccess, applyFailure);
  const newestSuccessRun = coordinator.run(() => newestSuccess.promise, applySuccess, applyFailure);
  newestSuccess.resolve({ items: [{ type: "resume", label: "newest canonical item" }], counts: { job: 0, resume: 1, answer: 0 } });
  assert.equal(await newestSuccessRun, true);
  const afterNewestSuccess = structuredClone(state);
  staleFailure.reject(new Error("stale connection failure"));
  assert.equal(await staleFailureRun, false);
  assert.deepEqual(state, afterNewestSuccess);
});

test("fragment token is decoded without accepting unrelated URL data", () => {
  assert.equal(tokenFromHash("#token=abc%20123"), "abc 123");
  assert.equal(tokenFromHash("#other=value"), "");
});

test("fragment token survives a same-tab reload without remaining in the URL", () => {
  const values = new Map();
  const storage = { setItem(key, value) { values.set(key, value); }, getItem(key) { return values.get(key) || null; } };
  assert.equal(sessionToken("#token=session-secret", storage), "session-secret");
  assert.equal(sessionToken("", storage), "session-secret");
  const denied = {};
  Object.defineProperty(denied, "sessionStorage", { get() { throw new DOMException("denied", "SecurityError"); } });
  assert.equal(safeSessionStorage(denied), null);
  assert.equal(sessionToken("#token=fallback-secret", safeSessionStorage(denied)), "fallback-secret");
});

test("API client authenticates in memory and surfaces revision conflicts", async () => {
  let captured;
  const fetchImpl = async (path, options) => {
    captured = { path, options };
    return { ok: false, status: 409, async json() { return { error: { code: "revision_conflict", message: "job revision conflict" } }; } };
  };
  const api = createApi("secret", fetchImpl);
  await assert.rejects(
    api("/api/jobs/job-1", { method: "PATCH", body: "{}" }),
    (error) => error instanceof ApiError && error.status === 409 && error.code === "revision_conflict",
  );
  assert.equal(captured.options.headers.Authorization, "Bearer secret");
  assert.equal(captured.options.headers["Content-Type"], "application/json");
  assert.equal(captured.path.includes("secret"), false);
});

test("Facts save retry policy is bounded and limited to revision conflicts", () => {
  const revisionConflict = new ApiError(409, { error: { code: "revision_conflict", message: "changed" } });
  const otherConflict = new ApiError(409, { error: { code: "protected_fact_conflict", message: "protected" } });
  assert.equal(FACT_SAVE_REVISION_RETRIES, 2);
  assert.equal(shouldRetryFactSave(revisionConflict, 0), true);
  assert.equal(shouldRetryFactSave(revisionConflict, 1), true);
  assert.equal(shouldRetryFactSave(revisionConflict, 2), false);
  assert.equal(shouldRetryFactSave(otherConflict, 0), false);
  assert.equal(shouldRetryFactSave(new ApiError(500, { error: { code: "revision_conflict" } }), 0), false);
});

test("jobs filter by status and human-visible fields", () => {
  const jobs = [
    { role: "Staff Engineer", company: "Acme", location: "Phoenix", status: "ready" },
    { role: "Designer", company: "Orbit", location: "Remote", status: "saved" },
  ];
  assert.deepEqual(filterJobs(jobs, "acme", ""), [jobs[0]]);
  assert.deepEqual(filterJobs(jobs, "remote", "saved"), [jobs[1]]);
  assert.deepEqual(filterJobs(jobs, "engineer", "saved"), []);
});


test("form values become a supported Store patch", () => {
  const patch = formPatch({
    url: "https://example.com/job", role: "Engineer", company: "Acme", location: "Remote",
    workplaceType: "remote", employmentType: "full_time", compensation: "$150k", notes: "note",
    description: "description", resumeId: "", priority: "4",
  });
  assert.equal(patch.priority, 4);
  assert.equal(patch.resumeId, null);
  assert.equal(patch.role, "Engineer");
  assert.equal("status" in patch, false);
});

test("resume tag drafts are trimmed without inventing durable browser state", () => {
  assert.deepEqual(tagsFromInput(" primary, remote, ,primary "), ["primary", "remote", "primary"]);
});

test("resume assignment copy uses canonical projection counts", () => {
  assert.equal(
    resumeAssignmentText({ assignedJobCount: 2, implicitJobCount: 1 }),
    "2 explicitly assigned active jobs; 1 active job use this default.",
  );
  assert.equal(resumeAssignmentText({ assignedJobCount: 0, implicitJobCount: 0 }), "0 explicitly assigned active jobs.");
});

test("resume refresh results stay bound to their requested Active or Trash view", () => {
  assert.equal(shouldUseResumeResponse(4, 4, false, false), true);
  assert.equal(shouldUseResumeResponse(3, 4, false, false), false);
  assert.equal(shouldUseResumeResponse(4, 4, false, true), false);
});

test("extraction request view is honest and closed for every state", () => {
  assert.deepEqual(extractionRequestView(null, null), {
    label: "Facts not extracted", action: "request", tone: "neutral",
  });
  const waiting = extractionRequestView({ status: "requested" }, null);
  assert.equal(waiting.action, "cancel");
  assert.match(waiting.label, /Waiting for a Job Apply agent/);
  assert.doesNotMatch(waiting.label, /Extracting/i);
  assert.equal(extractionRequestView({ status: "failed" }, null).action, "retry");
  assert.equal(extractionRequestView({ status: "stale" }, null).action, "fresh");
  assert.equal(extractionRequestView({ status: "cancelled" }, null).action, "request");
  assert.equal(extractionRequestView({ status: "completed" }, { status: "pending" }).action, "review");
  assert.deepEqual(extractionRequestView(
    { status: "completed" },
    { status: "pending", staleReasons: ["profile_revision_changed"] },
  ), {
    label: "Extraction review is no longer current", action: "fresh", tone: "warning",
  });
  assert.equal(extractionRequestView({ status: "completed" }, { status: "completed" }).action, "facts");
});

test("proposal groups keep deterministic order and unknown paths visible", () => {
  assert.equal(proposalGroupForPath("/firstName"), "Identity");
  assert.equal(proposalGroupForPath("/email"), "Contact");
  assert.equal(proposalGroupForPath("/location/city"), "Location");
  assert.equal(proposalGroupForPath("/workHistory"), "Experience");
  assert.equal(proposalGroupForPath("/education"), "Education");
  assert.equal(proposalGroupForPath("/skills"), "Skills");
  assert.equal(proposalGroupForPath("/linkedInUrl"), "Links");
  assert.equal(proposalGroupForPath("/futureFact/value"), "Additional");
});


test("status actions preserve guarded ready, acquire, and applied boundaries", () => {
  assert.deepEqual(transitionsFor("saved"), ["needs_info", "closed"]);
  assert.equal(transitionsFor("ready").includes("in_progress"), false);
  assert.deepEqual(transitionsFor("in_progress"), []);
  assert.deepEqual(transitionsFor("awaiting_review"), ["applied", "closed"]);
  assert.equal(canMarkReadyFrom("saved"), true);
  assert.equal(canMarkReadyFrom("needs_info"), true);
  assert.equal(canMarkReadyFrom("awaiting_review"), false);
});
