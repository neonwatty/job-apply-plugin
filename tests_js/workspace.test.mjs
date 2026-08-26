import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { chromium } from "playwright";

const SOURCE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = process.env.JOB_WORKSPACE_TEST_ROOT
  ? resolve(process.env.JOB_WORKSPACE_TEST_ROOT)
  : SOURCE_ROOT;
const PYTHON = process.env.PYTHON || "python3";

function minimalSyntheticPdf() {
  const header = "%PDF-1.7\n";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n",
  ];
  const offsets = [];
  let body = header;
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body));
    body += object;
  }
  const xrefOffset = Buffer.byteLength(body);
  const entries = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return Buffer.from(
    `${body}xref\n0 4\n0000000000 65535 f \n${entries}`
      + `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );
}

const {
  ApiError,
  activityAnnouncement,
  activitySignature,
  answerApiPath,
  FACT_SAVE_REVISION_RETRIES,
  canMarkReadyFrom,
  answerNeedsFreshConsent,
  answerSummary,
  canApplyAnswerReveal,
  canApplyAnswerDialogResponse,
  canApplyAnswerDialogMutation,
  canRefreshAnswerDraft,
  canRevealAnswer,
  sameAnswerScope,
  createApi,
  createLatestRequestCoordinator,
  conflictingPaths,
  filterJobs,
  formPatch,
  filterTrashItems,
  lifecycleErrorText,
  patchForPaths,
  pointerValue,
  resumeAssignmentText,
  safeSessionStorage,
  sessionToken,
  shouldRetryFactSave,
  shouldUseResumeResponse,
  summarizeProvenance,
  tagsFromInput,
  trashBlockerText,
  tokenFromHash,
  transitionsFor,
  typedDeletePhrase,
} = await import(pathToFileURL(join(REPO_ROOT, "workspace", "app.js")).href);

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

test("application activity announcements are latest-only and non-duplicative", () => {
  const before = {
    job: { status: "ready", revision: 2 }, claim: { state: "none" },
    session: null, history: [],
  };
  const active = {
    job: { status: "in_progress", revision: 3 },
    claim: { state: "active", heartbeatAt: "2026-08-26T12:00:00Z" },
    session: { status: "active", step: "questions", updatedAt: "2026-08-26T12:00:00Z", pendingInformation: [] },
    history: [{ event: "job-started", status: "in_progress", at: "2026-08-26T12:00:00Z" }],
  };
  assert.equal(activityAnnouncement(null, before), "");
  assert.equal(activityAnnouncement(active, structuredClone(active)), "");
  assert.match(activityAnnouncement(before, active), /Status changed to in progress/);
  assert.match(activityAnnouncement(before, active), /Agent attempt is active/);
  assert.match(activityAnnouncement(before, active), /history updated/);
  assert.equal(activitySignature(active), activitySignature(structuredClone(active)));
  assert.equal(activitySignature(active).includes("ownerLabel"), false);
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

test("answer summaries preserve aggregate redaction and fresh-consent boundaries", () => {
  assert.equal(answerSummary({ valueRedacted: true, hasValue: true }), "Sensitive value hidden — reveal explicitly to view");
  assert.equal(answerSummary({ valueRedacted: false, hasValue: true }), "Value retained");
  assert.equal(answerNeedsFreshConsent("sensitive", "high", true), true);
  assert.equal(answerNeedsFreshConsent("confirmed", "personal", true), true);
  assert.equal(answerNeedsFreshConsent("confirmed", "none", true), false);
  assert.equal(canRevealAnswer({ valueRedacted: true, deletedAt: null }), true);
  assert.equal(canRevealAnswer({ valueRedacted: true, deletedAt: "2026-08-25T00:00:00Z" }), false);
  assert.equal(canRefreshAnswerDraft({ key: "source" }, { key: "source", revision: 2 }), true);
  assert.equal(canRefreshAnswerDraft({ key: "source" }, { key: "winner", redirectedFrom: "source" }), false);
  assert.equal(canApplyAnswerReveal({ key: "source" }, "source", { key: "source", value: "private" }), true);
  assert.equal(canApplyAnswerReveal({ key: "source" }, "source", { key: "winner", redirectedFrom: "source", value: "winner-private" }), false);
  assert.equal(canApplyAnswerReveal({ key: "another" }, "source", { key: "source", value: "private" }), false);
  assert.equal(canApplyAnswerDialogResponse({ key: "source" }, "source", 4, 4), true);
  assert.equal(canApplyAnswerDialogResponse({ key: "source" }, "source", 4, 5), false);
  assert.equal(canApplyAnswerDialogResponse({ key: "another" }, "source", 4, 4), false);
  assert.equal(canApplyAnswerDialogResponse({ key: "source" }, "source", 4, 4, false), false);
  assert.equal(canApplyAnswerDialogMutation({ key: "source" }, "source", 7, 7), true);
  assert.equal(canApplyAnswerDialogMutation({ key: "source" }, "source", 7, 8), false);
  assert.equal(canApplyAnswerDialogMutation({ key: "another" }, "source", 7, 7), false);
  assert.equal(canApplyAnswerDialogMutation(null, null, 7, 7), true);
  assert.equal(canApplyAnswerDialogMutation({ key: "source" }, "source", 7, 7, false), false);
  assert.equal(sameAnswerScope({ country: "US", ats: { name: "x" } }, { ats: { name: "x" }, country: "US" }), true);
  assert.equal(sameAnswerScope({ country: "US" }, { country: "CA" }), false);
  assert.equal(answerApiPath(".."), "/api/answers/by-key/Li4");
  assert.equal(answerApiPath("résumé/回答", "reveal").includes("."), false);
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

test("profile paths build selective patches and distinguish safe rebases from conflicts", () => {
  const base = { location: { city: "Phoenix", country: "US" }, skills: ["Python"], firstName: "Ada" };
  const latest = { location: { city: "Phoenix", country: "CA" }, skills: ["Python", "Rust"], firstName: "Grace" };
  const drafts = new Map([["/location/city", "Tempe"], ["/skills", ["Go"]], ["/firstName", "Augusta"]]);
  assert.equal(pointerValue(base, "/location/city"), "Phoenix");
  assert.deepEqual(patchForPaths(drafts), { location: { city: "Tempe" }, skills: ["Go"], firstName: "Augusta" });
  assert.deepEqual(conflictingPaths(base, latest, drafts, new Set(["/skills"])), ["/skills", "/firstName"]);
  const draftBases = new Map([["/firstName", "Ada"]]);
  assert.deepEqual(conflictingPaths(draftBases, latest, new Map([["/firstName", "Augusta"]])), ["/firstName"]);
});

test("profile pointer patches preserve forward-compatible prototype-shaped keys", () => {
  const patch = patchForPaths(new Map([
    ["/__proto__", { enabled: true }],
    ["/constructor/prototype", "kept"],
  ]));

  assert.equal(Object.hasOwn(patch, "__proto__"), true);
  assert.deepEqual(patch.__proto__, { enabled: true });
  assert.equal(Object.hasOwn(patch, "constructor"), true);
  assert.equal(patch.constructor.prototype, "kept");
  assert.equal(pointerValue({}, "/__proto__"), undefined);
  assert.deepEqual(pointerValue(JSON.parse('{"__proto__":{"enabled":true}}'), "/__proto__"), { enabled: true });
  assert.equal({}.enabled, undefined);
  assert.equal({}.kept, undefined);
});

test("atomic Additional provenance summarizes descendant sources", () => {
  assert.deepEqual(
    summarizeProvenance({
      "/futureConfig/enabled": { source: "resume", updatedAt: "2026-01-01T00:00:00Z" },
      "/futureConfig/note": { source: "user", updatedAt: "2026-01-02T00:00:00Z" },
    }, "/futureConfig"),
    { source: "mixed: resume, user", updatedAt: "2026-01-02T00:00:00Z" },
  );
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

test("workspace markup has semantic dialogs, labels, live regions, and no remote assets", async () => {
  const html = await readFile(join(REPO_ROOT, "workspace", "index.html"), "utf8");
  assert.match(html, /<main(?:\s|>)/);
  assert.match(html, /<dialog id="job-dialog" aria-labelledby=/);
  assert.match(html, /id="facts-workspace"/);
  assert.match(html, /id="resumes-workspace"/);
  assert.match(html, /id="answers-workspace"/);
  assert.match(html, /<dialog id="answer-dialog" aria-labelledby=/);
  assert.match(html, /<dialog id="answer-merge-dialog" aria-labelledby=/);
  assert.match(html, /id="answer-merge-winner"/);
  assert.match(html, /id="answer-reveal"/);
  assert.match(html, /name="rememberSensitive"/);
  assert.match(html, /<dialog id="resume-dialog" aria-labelledby=/);
  assert.match(html, /<dialog id="proposal-dialog" aria-labelledby=/);
  assert.match(html, /aria-label="Workspace sections"/);
  for (const path of ["\/firstName", "\/location\/city", "\/workHistory", "\/education", "\/skills", "\/preferences\/targetTitles", "\/preferences\/minBaseSalary", "\/preferences\/remotePreference", "\/preferences\/excludePatterns", "\/preferences\/defaultTimeRange"]) {
    assert.match(html, new RegExp(`data-path="${path}"`));
  }
  assert.match(html, /data-path="\/location\/zip"/);
  assert.doesNotMatch(html, /data-path="\/location\/postalCode"/);
  assert.match(html, /data-path="\/preferences\/minBaseSalary" type="text"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /class="skip-link"/);
  assert.doesNotMatch(html, /(?:src|href)="https?:\/\//);
  for (const name of ["url", "role", "company", "location", "priority", "resumeId", "notes", "description"]) {
    assert.match(html, new RegExp(`<(?:input|select|textarea) name="${name}"`));
  }
});

test("answer-memory documents guarded profile and preference mutations", async () => {
  const skill = await readFile(join(REPO_ROOT, "skills", "answer-memory", "SKILL.md"), "utf8");
  assert.match(skill, /profile-replace[\s\\]+--input <profile\.json> --expected-revision <revision>[\s\\]+--source <user\|resume\|agent\|migration>/);
  assert.match(skill, /preferences-set[\s\\]+--input <preferences\.json> --expected-revision <revision>[\s\\]+--source <user\|resume\|agent\|migration> \[--replace\]/);
  assert.match(skill, /sole existing-record mutation that intentionally takes no expected revision/);
  assert.match(skill, /--winner-key <accepted-winner-key> --source-key <active-duplicate-key>/);
  assert.doesNotMatch(skill, /--source-key <accepted-duplicate-key>/);
});

test("answer browser routes encode canonical keys at every path boundary", async () => {
  const app = await readFile(join(REPO_ROOT, "workspace", "app.js"), "utf8");
  for (const expression of [
    "answerApiPath(answer.key, action)",
    "answerApiPath(selected.key)",
    "answerApiPath(source.key, \"merge\")",
  ]) {
    assert.ok(app.includes(expression), expression);
  }
  assert.doesNotMatch(app, /encodeURIComponent\((?:answer|selected|source)\.key\)/);
});

test("job-apply direct URL workflow resolves canonical managed resume storage", async () => {
  const skill = await readFile(join(REPO_ROOT, "skills", "job-apply", "SKILL.md"), "utf8");
  const readme = await readFile(join(REPO_ROOT, "README.md"), "utf8");
  assert.match(skill, /resume-import --input/);
  assert.match(skill, /resume-resolve --id <resume-id>/);
  assert.match(skill, /direct-URL mode[\s\S]{0,500}run `resume-resolve`/);
  assert.match(skill, /full `resume-list` records as private tool output, not as a redacted projection/);
  assert.match(skill, /summary containing only `id`, `label`, `tags`, `default`, `revision`, and `storageKind`/);
  assert.match(skill, /never include a private path, managed filename, original filename, digest, or any other field/);
  assert.doesNotMatch(skill, /inspect redacted metadata with `resume-list`/);
  assert.match(skill, /Never use `profile\.resumePath` or a user source path for upload/);
  assert.doesNotMatch(readme, /Every resume write uses an exact revision/);
  assert.match(readme, /Import is a new-record operation protected by ID\/content uniqueness/);
  assert.match(readme, /resume-resolve/);
});

test("styles include visible focus, reduced motion, contrast mode, and responsive behavior", async () => {
  const css = await readFile(join(REPO_ROOT, "workspace", "styles.css"), "utf8");
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /prefers-color-scheme: dark/);
  assert.match(css, /@media \(max-width:/);
});

test("open Job detail polling keeps the latest selected activity and announces once", { timeout: 60_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "job-activity-polling-"));
  const storeRoot = join(temporary, "store");
  const storeScript = join(REPO_ROOT, "scripts", "job-apply-store.py");
  let inputCounter = 0;
  const cli = async (command, args = [], payload) => {
    const finalArgs = [storeScript, "--root", storeRoot, command, ...args];
    if (payload !== undefined) {
      const inputPath = join(temporary, `activity-input-${inputCounter++}.json`);
      await writeFile(inputPath, JSON.stringify(payload));
      finalArgs.push("--input", inputPath);
    }
    const result = spawnSync(PYTHON, finalArgs, { cwd: REPO_ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const waitForStartup = (child) => new Promise((resolveStartup, rejectStartup) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => rejectStartup(new Error(`workspace startup timed out: ${stderr}`)), 10_000);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      try { resolveStartup(JSON.parse(stdout.slice(0, newline))); } catch (error) { rejectStartup(error); }
    });
    child.once("exit", (code) => { clearTimeout(timer); rejectStartup(new Error(`workspace exited during startup (${code}): ${stderr}`)); });
  });

  let server;
  let browser;
  try {
    const resumePath = join(temporary, "activity-resume.pdf");
    await writeFile(resumePath, minimalSyntheticPdf());
    await cli("profile-replace", ["--expected-revision", "0", "--source", "user"], { firstName: "Ada" });
    await cli("resume-create", [], { id: "activity-resume", label: "Activity resume", path: resumePath });
    let pollingJob = await cli("job-create", [], {
      id: "polling-job", url: "https://example.com/jobs/polling", role: "Polling Engineer", company: "Polling Co",
    });
    const otherJob = await cli("job-create", [], {
      id: "other-job", url: "https://example.com/jobs/other", role: "Other Engineer", company: "Other Co",
    });
    pollingJob = await cli("job-transition", ["--id", pollingJob.id, "--status", "ready", "--expected-revision", String(pollingJob.revision)]);

    server = spawn(PYTHON, [join(REPO_ROOT, "scripts", "job-apply-workspace.py"), "--root", storeRoot, "--port", "0", "--no-open", "--json"], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const startup = await waitForStartup(server);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const activityPayloads = [];
    page.on("response", async (response) => {
      if (!new URL(response.url()).pathname.endsWith("/activity") || !response.ok()) return;
      try { activityPayloads.push(await response.json()); } catch { /* asserted through visible failure paths */ }
    });
    await page.goto(startup.url);
    await page.getByText("Canonical store connected").waitFor();

    const pollingCard = page.getByRole("button", { name: /Polling Engineer/ });
    await pollingCard.focus();
    await page.keyboard.press("Enter");
    const jobDialog = page.locator("#job-dialog");
    const activityPanel = jobDialog.getByRole("region", { name: "Application activity" });
    await activityPanel.getByText(/Canonical status ready/).waitFor();

    const activityPattern = `**/api/jobs/${pollingJob.id}/activity`;
    const failActivity = (route) => route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "activity_unavailable", message: "activity unavailable for test" } }),
    });
    await page.keyboard.press("Escape");
    await jobDialog.waitFor({ state: "hidden" });
    await page.route(activityPattern, failActivity);
    await pollingCard.focus();
    await page.keyboard.press("Enter");
    await activityPanel.getByText(/Durable activity could not be refreshed/).waitFor();
    assert.match(await activityPanel.innerText(), /Agent attempt information is unavailable until refresh succeeds/);
    assert.match(await activityPanel.innerText(), /Application history is unavailable until refresh succeeds/);
    assert.equal(await activityPanel.getByText("No agent activity has been recorded for this job.").isVisible(), false);
    await page.evaluate(() => {
      globalThis.__activityRecoveryMutations = [];
      const live = document.querySelector("#activity-live");
      globalThis.__activityRecoveryObserver = new MutationObserver(() => {
        globalThis.__activityRecoveryMutations.push(live.textContent);
      });
      globalThis.__activityRecoveryObserver.observe(live, { childList: true, characterData: true, subtree: true });
    });
    await page.waitForTimeout(4_500);
    assert.deepEqual(await page.evaluate(() => [...globalThis.__activityRecoveryMutations]), []);
    await page.unroute(activityPattern, failActivity);
    await activityPanel.getByText(/Canonical status ready/).waitFor();
    await page.waitForFunction(() => globalThis.__activityRecoveryMutations?.length === 1);
    assert.deepEqual(
      await page.evaluate(() => [...globalThis.__activityRecoveryMutations]),
      ["Durable application activity is available again."],
    );
    await page.waitForTimeout(4_500);
    assert.deepEqual(
      await page.evaluate(() => [...globalThis.__activityRecoveryMutations]),
      ["Durable application activity is available again."],
    );
    await page.evaluate(() => globalThis.__activityRecoveryObserver?.disconnect());

    const statePattern = "**/api/state";
    const failStateRefresh = (route) => route.abort();
    await page.route(statePattern, failStateRefresh);
    pollingJob = await cli("job-update", ["--id", pollingJob.id, "--expected-revision", String(pollingJob.revision), "--origin", "human"], { notes: "CLI concurrent note" });
    await page.keyboard.press("Escape");
    await jobDialog.waitFor({ state: "hidden" });
    await pollingCard.focus();
    await page.keyboard.press("Enter");
    await activityPanel.getByText(new RegExp(`Canonical status ready · revision ${pollingJob.revision}`)).waitFor();
    await jobDialog.getByLabel("Role", { exact: true }).fill("Stale browser draft");
    await page.getByRole("button", { name: "Save job" }).click();
    const maskedRevisionConflict = page.locator("#conflict");
    await maskedRevisionConflict.waitFor();
    const canonicalAfterConflict = await cli("job-get", ["--id", pollingJob.id]);
    assert.equal(canonicalAfterConflict.role, "Polling Engineer");
    assert.equal(canonicalAfterConflict.notes, "CLI concurrent note");
    await page.getByRole("button", { name: "Load canonical values" }).click();
    assert.equal(await jobDialog.getByLabel("Notes", { exact: true }).inputValue(), "CLI concurrent note");
    await page.unroute(statePattern, failStateRefresh);

    await page.evaluate(() => {
      globalThis.__activityLiveMutations = [];
      const live = document.querySelector("#activity-live");
      globalThis.__activityLiveObserver = new MutationObserver(() => {
        globalThis.__activityLiveMutations.push(live.textContent);
      });
      globalThis.__activityLiveObserver.observe(live, { childList: true, characterData: true, subtree: true });
    });

    const acquired = await cli("job-acquire", ["--id", pollingJob.id, "--owner", "private-polling-owner", "--expected-revision", String(pollingJob.revision)]);
    await cli("claim-progress", ["--id", pollingJob.id, "--token", acquired.token], {
      status: "active", step: "questions", answerKeys: ["private.polling.answer"],
      pendingFields: [{ question: "Can you work in this location?", state: "missing", answerKey: "private.polling.answer", sensitive: true }],
    });
    await activityPanel.getByText(/Canonical status in progress/).waitFor();
    await activityPanel.getByText("Can you work in this location? · missing · sensitive").waitFor();
    await page.waitForFunction(() => globalThis.__activityLiveMutations?.length === 1);
    const announced = await page.evaluate(() => [...globalThis.__activityLiveMutations]);
    assert.match(announced[0], /Status changed to in progress/);
    await page.waitForTimeout(4_500);
    assert.deepEqual(await page.evaluate(() => [...globalThis.__activityLiveMutations]), announced);

    const forbidden = [acquired.token, "private-polling-owner", "private.polling.answer", "tokenHash", "claimId", "ownerLabel", "answerKey", "answerKeys", "operationId", "resultClaim", "browserState", otherJob.id];
    const liveDom = await activityPanel.innerText();
    for (const value of forbidden) assert.equal(liveDom.includes(value), false, value);
    assert.ok(activityPayloads.length >= 2);
    for (const payload of activityPayloads) {
      const serialized = JSON.stringify(payload);
      for (const value of forbidden) assert.equal(serialized.includes(value), false, value);
    }

    await page.keyboard.press("Escape");
    await jobDialog.waitFor({ state: "hidden" });
    await page.waitForFunction((id) => document.activeElement?.dataset?.id === id, pollingJob.id);

    let releaseOlder;
    let olderSeenResolve;
    let olderReleasedResolve;
    const olderSeen = new Promise((resolveSeen) => { olderSeenResolve = resolveSeen; });
    const olderReleased = new Promise((resolveReleased) => { olderReleasedResolve = resolveReleased; });
    const releaseOlderPromise = new Promise((resolveRelease) => { releaseOlder = resolveRelease; });
    let delayedPayload;
    let delayed = false;
    await page.route(`**/api/jobs/${pollingJob.id}/activity`, async (route) => {
      if (delayed) { await route.continue(); return; }
      delayed = true;
      const response = await route.fetch();
      delayedPayload = await response.json();
      olderSeenResolve();
      await releaseOlderPromise;
      await route.fulfill({ response });
      olderReleasedResolve();
    });

    await pollingCard.focus();
    await page.keyboard.press("Enter");
    await olderSeen;
    await page.keyboard.press("Escape");
    await jobDialog.waitFor({ state: "hidden" });
    const otherCard = page.getByRole("button", { name: /Other Engineer/ });
    await otherCard.focus();
    await page.keyboard.press("Enter");
    await activityPanel.getByText(/Canonical status saved · revision 1/).waitFor();
    releaseOlder();
    await olderReleased;
    await page.waitForTimeout(250);

    assert.equal(await jobDialog.getByRole("heading", { name: "Other Engineer" }).count(), 1);
    assert.match(await activityPanel.innerText(), /Canonical status saved · revision 1/);
    assert.match(await activityPanel.innerText(), /No agent currently owns this job/);
    assert.equal(await activityPanel.getByText("Resumable progress").isVisible(), false);
    assert.equal(await activityPanel.getByText("No agent activity has been recorded for this job.").isVisible(), true);
    const raceDom = await activityPanel.innerText();
    for (const value of forbidden) assert.equal(raceDom.includes(value), false, value);
    const delayedSerialized = JSON.stringify(delayedPayload);
    for (const value of forbidden) assert.equal(delayedSerialized.includes(value), false, value);

    await page.evaluate((expectedJobId) => {
      const events = [];
      globalThis.__jobDialogDismissalEvents = events;
      const currentDialog = document.querySelector("#job-dialog");
      currentDialog.addEventListener("cancel", (event) => {
        events.push({ type: "cancel", defaultPrevented: event.defaultPrevented });
      }, { once: true });
      currentDialog.addEventListener("close", () => {
        events.push({ type: "close" });
        queueMicrotask(() => {
          events.push({ type: "post-close-microtask", activeJobId: document.activeElement?.dataset?.id || null });
        });
      }, { once: true });
      const recordDestinationFocus = (event) => {
        if (!(event.target instanceof HTMLElement) || event.target.dataset.id !== expectedJobId) return;
        events.push({ type: "focus" });
        document.removeEventListener("focusin", recordDestinationFocus);
      };
      document.addEventListener("focusin", recordDestinationFocus);
    }, otherJob.id);
    await page.keyboard.press("Escape");
    await jobDialog.waitFor({ state: "hidden" });
    await page.waitForFunction(() => globalThis.__jobDialogDismissalEvents?.some((event) => event.type === "post-close-microtask"));
    const dismissalSnapshot = await page.evaluate(() => ({
      activeJobId: document.activeElement?.dataset?.id || null,
      events: [...globalThis.__jobDialogDismissalEvents],
    }));
    const dismissalEvents = dismissalSnapshot.events;
    assert.deepEqual(dismissalEvents.filter((event) => event.type === "cancel"), [
      { type: "cancel", defaultPrevented: true },
    ]);
    assert.equal(dismissalEvents.filter((event) => event.type === "close").length, 1);
    assert.equal(dismissalEvents.filter((event) => event.type === "focus").length, 1);
    const postCloseIndex = dismissalEvents.findIndex((event) => event.type === "post-close-microtask");
    assert.ok(dismissalEvents.findIndex((event) => event.type === "cancel") < postCloseIndex);
    assert.ok(dismissalEvents.findIndex((event) => event.type === "close") < postCloseIndex);
    assert.deepEqual(dismissalEvents[postCloseIndex], { type: "post-close-microtask", activeJobId: otherJob.id });
    assert.equal(dismissalSnapshot.activeJobId, otherJob.id);
    await page.waitForFunction((id) => document.activeElement?.dataset?.id === id, otherJob.id);
    await page.waitForTimeout(4_500);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.id), otherJob.id);
    await page.evaluate(() => globalThis.__activityLiveObserver?.disconnect());

    await browser.close(); browser = null;
    server.kill("SIGINT");
    const exitCode = await new Promise((resolveExit) => server.once("exit", resolveExit));
    assert.equal(exitCode, 0);
    server = null;
  } finally {
    if (browser) await browser.close();
    if (server && server.exitCode === null) {
      server.kill("SIGINT");
      await new Promise((resolveExit) => server.once("exit", resolveExit));
    }
    await rm(temporary, { recursive: true, force: true });
  }
});

test("real browser and CLI share CRUD, conflict, ready handoff, semantics, focus, and shutdown", { timeout: 90_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "job-workspace-browser-"));
  const storeRoot = join(temporary, "store");
  const storeScript = join(REPO_ROOT, "scripts", "job-apply-store.py");
  let inputCounter = 0;
  const cli = async (command, args = [], payload) => {
    const finalArgs = [storeScript, "--root", storeRoot, command, ...args];
    if (payload !== undefined) {
      const inputPath = join(temporary, `input-${inputCounter++}.json`);
      await writeFile(inputPath, JSON.stringify(payload));
      finalArgs.push("--input", inputPath);
    }
    const result = spawnSync(PYTHON, finalArgs, { cwd: REPO_ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const waitForStartup = (child) => new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`workspace startup timed out: ${stderr}`)), 10_000);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline >= 0) {
        clearTimeout(timer);
        try { resolve(JSON.parse(stdout.slice(0, newline))); } catch (error) { reject(error); }
      }
    });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`workspace exited during startup (${code}): ${stderr}`)); });
  });

  let server;
  let browser;
  try {
    const resumePath = join(temporary, "resume.pdf");
    await writeFile(resumePath, minimalSyntheticPdf());
    await cli("profile-replace", ["--expected-revision", "0", "--source", "resume"], {
      firstName: "Ada", lastName: "Example", email: "ada@example.invalid",
      location: { city: "Phoenix", country: "US", zip: "85001" }, skills: ["Python"],
      workHistory: [{ company: "Example Co", title: "Engineer" }],
      education: [{ school: "Example University", degree: "BS" }],
      preferences: { targetTitles: ["Engineer"], minBaseSalary: "$150K", remotePreference: "remote", excludePatterns: ["intern"], defaultTimeRange: "week" },
      customNote: "synthetic", futureConfig: { enabled: true, obsolete: "remove atomically" },
    });
    let seededProfile = await cli("profile-inspect");
    await cli("profile-patch", ["--expected-revision", String(seededProfile.revision), "--source", "resume"], {
      descendantConfig: { enabled: true, mode: "safe" },
    });
    await cli("resume-create", [], { id: "browser-resume", label: "Browser resume", path: resumePath });
    const cliJob = await cli("job-create", [], { url: "https://example.com/jobs/cli-browser", role: "CLI Engineer", company: "CLI Co" });

    server = spawn(PYTHON, [join(REPO_ROOT, "scripts", "job-apply-workspace.py"), "--root", storeRoot, "--port", "0", "--no-open", "--json"], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const startup = await waitForStartup(server);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.addInitScript(() => {
      // This walkthrough drives every refresh explicitly; background polling can
      // otherwise race the save-time refresh and make focus assertions flaky.
      globalThis.setInterval = () => 0;
    });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    await page.goto(startup.url);
    await page.getByText("Canonical store connected").waitFor();
    await page.reload();
    await page.getByText("Canonical store connected").waitFor();
    const jobDialog = page.locator("#job-dialog");

    await page.getByRole("button", { name: "Facts" }).click();
    await page.waitForFunction(() => document.querySelector('[data-path="/firstName"]')?.value === "Ada");
    assert.equal(await page.getByLabel("First name").inputValue(), "Ada");
    assert.equal(await page.getByLabel("Postal code").inputValue(), "85001");
    assert.equal(await page.getByLabel("Minimum base salary").inputValue(), "$150K");
    assert.match(await page.locator('[data-provenance="/firstName"]').innerText(), /resume/);
    assert.match(await page.locator('.additional-fact').filter({ hasText: "descendantConfig" }).locator("small").innerText(), /resume/);
    await page.getByLabel("Last name").fill("Browser");
    await page.getByLabel("City").fill("Tempe");
    await page.getByLabel("Postal code").fill("85281");
    await page.getByLabel("Minimum base salary").fill("$175K");
    await page.getByLabel("Remote preference").fill("hybrid");
    await page.getByLabel("Title, item 1").fill("Staff Engineer");
    await page.getByLabel("Degree, item 1").fill("BSc");
    await page.getByLabel("Skills (one per line)").fill("Python\nRust");
    await page.locator('.additional-fact').filter({ hasText: "customNote" }).getByLabel("JSON value").fill('"browser synthetic"');
    await page.locator('.additional-fact').filter({ hasText: "futureConfig" }).getByLabel("JSON value").fill('{"enabled":false}');
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByText("Profile is synchronized with the canonical store.").waitFor();
    let profile = await cli("profile-inspect");
    assert.equal(profile.profile.lastName, "Browser");
    assert.equal(profile.profile.location.city, "Tempe");
    assert.equal(profile.profile.location.zip, "85281");
    assert.equal(profile.profile.preferences.minBaseSalary, "$175K");
    assert.equal(profile.profile.preferences.remotePreference, "hybrid");
    assert.equal(profile.profile.workHistory[0].title, "Staff Engineer");
    assert.equal(profile.profile.education[0].degree, "BSc");
    assert.deepEqual(profile.profile.skills, ["Python", "Rust"]);
    assert.equal(profile.profile.customNote, "browser synthetic");
    assert.deepEqual(profile.profile.futureConfig, { enabled: false });
    assert.equal(profile.factProvenance["/location/city"].source, "user");

    let futureConfig = page.locator('.additional-fact').filter({ hasText: "futureConfig" });
    await futureConfig.getByLabel("JSON value").fill("null");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByText("Profile is synchronized with the canonical store.").waitFor();
    profile = await cli("profile-inspect");
    assert.equal(Object.hasOwn(profile.profile, "futureConfig"), true);
    assert.equal(profile.profile.futureConfig, null);

    futureConfig = page.locator('.additional-fact').filter({ hasText: "futureConfig" });
    page.once("dialog", (prompt) => prompt.accept());
    await futureConfig.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByText("Profile is synchronized with the canonical store.").waitFor();
    profile = await cli("profile-inspect");
    assert.equal("futureConfig" in profile.profile, false);

    let customNote = page.locator('.additional-fact').filter({ hasText: "customNote" });
    await customNote.getByLabel("JSON value").fill('"draft after delete"');
    profile = await cli("profile-patch", ["--expected-revision", String(profile.revision), "--source", "user"], { customNote: null });
    await page.locator("#facts-refresh").click();
    await page.waitForFunction((revision) => document.querySelector("#facts-revision")?.textContent === `Revision ${revision}`, profile.revision);
    customNote = page.locator('.additional-fact').filter({ hasText: "customNote" });
    assert.equal(await customNote.getByLabel("JSON value").inputValue(), '"draft after delete"');
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.locator("#facts-conflict").waitFor();
    await page.getByRole("button", { name: "Use my values for conflicts" }).click();
    await page.getByText("Profile is synchronized with the canonical store.").waitFor();
    profile = await cli("profile-inspect");
    assert.equal(profile.profile.customNote, "draft after delete");

    customNote = page.locator('.additional-fact').filter({ hasText: "customNote" });
    await customNote.getByLabel("JSON value").fill('"discard after delete"');
    profile = await cli("profile-patch", ["--expected-revision", String(profile.revision), "--source", "user"], { customNote: null });
    await page.locator("#facts-refresh").click();
    await page.waitForFunction((revision) => document.querySelector("#facts-revision")?.textContent === `Revision ${revision}`, profile.revision);
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.locator("#facts-conflict").waitFor();
    await page.getByRole("button", { name: "Use latest for conflicts" }).click();
    assert.equal(await page.locator('.additional-fact').filter({ hasText: "customNote" }).count(), 0);

    await page.getByLabel("First name").fill("Disjoint draft");
    profile = await cli("profile-patch", ["--expected-revision", String(profile.revision), "--source", "agent"], { location: { country: "CA" } });
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByText("Profile is synchronized with the canonical store.").waitFor();
    profile = await cli("profile-inspect");
    assert.equal(profile.profile.firstName, "Disjoint draft");
    assert.equal(profile.profile.location.country, "CA");

    await page.getByLabel("First name").fill("Refresh-protected draft");
    profile = await cli("profile-patch", ["--expected-revision", String(profile.revision), "--source", "user"], { firstName: "Refresh canonical" });
    await page.locator("#facts-refresh").click();
    await page.waitForFunction((revision) => document.querySelector("#facts-revision")?.textContent === `Revision ${revision}`, profile.revision);
    assert.equal(await page.getByLabel("First name").inputValue(), "Refresh-protected draft");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.locator("#facts-conflict").waitFor();
    await page.getByRole("button", { name: "Use latest for conflicts" }).click();
    assert.equal(await page.getByLabel("First name").inputValue(), "Refresh canonical");

    await page.getByLabel("First name").fill("Same path draft");
    profile = await cli("profile-patch", ["--expected-revision", String(profile.revision), "--source", "user"], { firstName: "CLI canonical" });
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.locator("#facts-conflict").waitFor();
    await page.getByRole("button", { name: "Use latest for conflicts" }).click();
    assert.equal(await page.getByLabel("First name").inputValue(), "CLI canonical");

    await page.getByLabel("Skills (one per line)").fill("Draft skill");
    profile = await cli("profile-patch", ["--expected-revision", String(profile.revision), "--source", "user"], { skills: ["Canonical skill"] });
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.locator("#facts-conflict").waitFor();
    await page.getByRole("button", { name: "Use my values for conflicts" }).click();
    await page.getByText("Profile is synchronized with the canonical store.").waitFor();
    profile = await cli("profile-inspect");
    assert.deepEqual(profile.profile.skills, ["Draft skill"]);

    let forcedRevisionConflicts = 0;
    await page.route("**/api/profile", async (route, request) => {
      if (request.method() !== "PATCH") { await route.continue(); return; }
      forcedRevisionConflicts += 1;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "revision_conflict", message: "synthetic conflict" } }),
      });
    });
    await page.getByLabel("First name").fill("Retry-preserved draft");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByText(/profile changed repeatedly while saving/i).waitFor();
    assert.equal(forcedRevisionConflicts, FACT_SAVE_REVISION_RETRIES + 1);
    assert.equal(await page.getByLabel("First name").inputValue(), "Retry-preserved draft");
    assert.equal(await page.getByRole("button", { name: "Save changes" }).isEnabled(), true);
    await page.unroute("**/api/profile");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByText("Profile is synchronized with the canonical store.").waitFor();
    await page.getByRole("button", { name: "Resumes" }).click();
    await page.getByRole("heading", { name: "Browser resume" }).waitFor();

    const importForm = page.locator("#resume-import");
    await importForm.getByLabel("Label").fill("Browser upload");
    await importForm.getByLabel("Tags (comma separated)").fill("browser, text");
    await importForm.getByLabel(/PDF, DOCX/).setInputFiles({ name: "private-browser-name.txt", mimeType: "text/plain", buffer: Buffer.from("browser private resume") });
    await importForm.getByRole("button", { name: "Import resume" }).click();
    await page.getByRole("heading", { name: "Browser upload" }).waitFor();
    let resumes = await cli("resume-list");
    const uploaded = resumes.find((resume) => resume.label === "Browser upload");
    assert.ok(uploaded, "browser import must be visible to the CLI");
    assert.notEqual(uploaded.originalFilename, "private-browser-name.txt");

    const uploadCard = page.locator(".resume-card").filter({ hasText: "Browser upload" });
    const manageUpload = uploadCard.getByRole("button", { name: "Manage" });
    const manageLifecycleUpload = () => page.locator(".resume-card").filter({ hasText: "Preserved browser draft" }).getByRole("button", { name: "Manage" });
    await manageUpload.click();
    const resumeDialog = page.locator("#resume-dialog");
    await resumeDialog.getByLabel("Label").fill("Preserved browser draft");
    await resumeDialog.getByLabel("Replacement file").setInputFiles({ name: "replacement.txt", mimeType: "text/plain", buffer: Buffer.from("replacement draft") });
    await cli("resume-update", ["--id", uploaded.id, "--expected-revision", String(uploaded.revision)], { tags: ["cli"] });
    await page.locator("#resumes-refresh").evaluate((button) => button.click());
    await page.locator("#resume-conflict").waitFor();
    assert.equal(await resumeDialog.getByLabel("Label").inputValue(), "Preserved browser draft");
    assert.equal(await resumeDialog.getByLabel("Replacement file").evaluate((input) => input.files.length), 1);
    await page.getByRole("button", { name: "Refresh canonical revision" }).click();
    assert.equal(await resumeDialog.getByLabel("Label").inputValue(), "Preserved browser draft");
    await resumeDialog.getByRole("button", { name: "Save metadata" }).click();
    await resumeDialog.waitFor({ state: "hidden" });
    resumes = await cli("resume-list");
    const finalResume = resumes.find((resume) => resume.id === uploaded.id);
    assert.equal(finalResume.label, "Preserved browser draft");
    assert.deepEqual(finalResume.tags, ["cli"]);

    await manageLifecycleUpload().click();
    await resumeDialog.getByRole("button", { name: "Make default" }).click();
    await resumeDialog.waitFor({ state: "hidden" });
    assert.equal((await cli("resume-get", ["--id", uploaded.id])).default, true);

    await manageLifecycleUpload().click();
    page.once("dialog", (prompt) => prompt.accept());
    await resumeDialog.getByRole("button", { name: "Move to trash" }).click();
    await page.getByText("This default resume is in use by active jobs. Assign another default first.").waitFor();
    await resumeDialog.getByRole("button", { name: "Close resume details" }).click();

    await page.getByRole("button", { name: "Jobs" }).click();
    await page.getByRole("button", { name: /CLI Engineer/ }).click();
    await jobDialog.getByLabel("Resume").selectOption(uploaded.id);
    await page.getByRole("button", { name: "Save job" }).click();
    await jobDialog.waitFor({ state: "hidden" });
    assert.equal((await cli("job-get", ["--id", cliJob.id])).resumeId, uploaded.id);

    await page.getByRole("button", { name: "Resumes" }).click();
    await page.locator(".resume-card").filter({ hasText: "Browser resume" }).getByRole("button", { name: "Manage" }).click();
    await resumeDialog.getByRole("button", { name: "Make default" }).click();
    await resumeDialog.waitFor({ state: "hidden" });
    assert.equal((await cli("resume-get", ["--id", "browser-resume"])).default, true);
    assert.equal((await cli("resume-get", ["--id", uploaded.id])).default, false);

    await manageLifecycleUpload().click();
    page.once("dialog", (prompt) => prompt.accept());
    await resumeDialog.getByRole("button", { name: "Move to trash" }).click();
    await page.getByText("This resume is assigned to an active job. Reassign that job first.").waitFor();
    await resumeDialog.getByRole("button", { name: "Close resume details" }).click();

    await page.getByRole("button", { name: "Jobs" }).click();
    await page.getByRole("button", { name: /CLI Engineer/ }).click();
    await jobDialog.getByLabel("Resume").selectOption("browser-resume");
    await page.getByRole("button", { name: "Save job" }).click();
    await jobDialog.waitFor({ state: "hidden" });
    const reassignedCliJob = await cli("job-get", ["--id", cliJob.id]);
    assert.equal(reassignedCliJob.resumeId, "browser-resume");

    await page.getByRole("button", { name: "Resumes" }).click();
    await manageLifecycleUpload().click();
    page.once("dialog", (prompt) => prompt.accept());
    await resumeDialog.getByRole("button", { name: "Move to trash" }).click();
    await resumeDialog.waitFor({ state: "hidden" });
    let lifecycleResume = await cli("resume-get", ["--id", uploaded.id, "--include-trashed"]);
    assert.ok(lifecycleResume.deletedAt);

    await page.locator("#resumes-trash").click();
    await page.locator(".resume-card").filter({ hasText: "Preserved browser draft" }).getByRole("button", { name: "Manage" }).click();
    await resumeDialog.getByRole("button", { name: "Restore" }).click();
    await resumeDialog.waitFor({ state: "hidden" });
    lifecycleResume = await cli("resume-get", ["--id", uploaded.id]);
    assert.equal(lifecycleResume.deletedAt, null);

    await page.locator("#resumes-active").click();
    await page.locator(".resume-card").filter({ hasText: "Preserved browser draft" }).getByRole("button", { name: "Manage" }).click();
    page.once("dialog", (prompt) => prompt.accept());
    await resumeDialog.getByRole("button", { name: "Move to trash" }).click();
    await resumeDialog.waitFor({ state: "hidden" });
    await page.locator("#resumes-trash").click();
    await page.locator(".resume-card").filter({ hasText: "Preserved browser draft" }).getByRole("button", { name: "Manage" }).click();
    await resumeDialog.getByRole("button", { name: "Delete permanently" }).click();
    const deleteDialog = page.locator("#trash-delete-dialog");
    await deleteDialog.waitFor({ state: "visible" });
    assert.equal(await deleteDialog.locator("#trash-delete-identity").textContent(), "resume: Preserved browser draft");
    assert.equal(await deleteDialog.getByRole("button", { name: "Delete permanently" }).isDisabled(), true);
    await deleteDialog.getByLabel(/Type DELETE RESUME/).fill("DELETE RESUME");
    await deleteDialog.getByRole("button", { name: "Delete permanently" }).click();
    await deleteDialog.waitFor({ state: "hidden" });
    await resumeDialog.waitFor({ state: "hidden" });
    assert.equal(await cli("resume-get", ["--id", uploaded.id, "--include-trashed"]), null);
    await page.locator("#resumes-active").click();

    profile = await cli("profile-inspect");
    profile = await cli("profile-patch", ["--expected-revision", String(profile.revision), "--source", "user"], { browserAncestor: "Canonical ancestor value" });
    const proposalResume = await cli("resume-get", ["--id", "browser-resume"]);
    const proposal = await cli("resume-proposal-create", ["--resume-id", proposalResume.id, "--expected-resume-revision", String(proposalResume.revision), "--expected-profile-revision", String(profile.revision)], { firstName: "Extracted browser fact", browserAutoFact: "Auto-filled browser fact", browserAncestor: { child: "Extracted child" } });
    await page.locator("#resumes-refresh").click();
    await page.locator(".resume-card").filter({ hasText: "Browser resume" }).getByRole("button", { name: "Manage" }).click();
    assert.equal(await resumeDialog.getByLabel("Replacement file").evaluate((input) => input.files.length), 0);
    const proposalResumeBeforeReadFailure = await cli("resume-get", ["--id", "browser-resume"]);
    await resumeDialog.getByLabel("Replacement file").setInputFiles({ name: "unreadable.txt", mimeType: "text/plain", buffer: Buffer.from("unreadable") });
    await page.evaluate(() => {
      globalThis.__JobApplyOriginalFileReader = globalThis.FileReader;
      globalThis.FileReader = class {
        addEventListener(name, callback) { if (name === "error") this.onError = callback; }
        readAsDataURL() { queueMicrotask(() => this.onError()); }
      };
    });
    const errorsBeforeRead = pageErrors.length;
    await resumeDialog.getByRole("button", { name: "Replace file" }).click();
    await page.getByText("The selected file could not be read.").waitFor();
    await page.evaluate(() => { globalThis.FileReader = globalThis.__JobApplyOriginalFileReader; delete globalThis.__JobApplyOriginalFileReader; });
    assert.equal(pageErrors.length, errorsBeforeRead);
    assert.equal((await cli("resume-get", ["--id", "browser-resume"])).revision, proposalResumeBeforeReadFailure.revision);
    await resumeDialog.getByRole("button", { name: "Review", exact: true }).click();
    await page.locator("#proposal-dialog[open]").waitFor();
    const firstNameReview = page.locator(".proposal-row").filter({ has: page.locator("legend", { hasText: "/firstName" }) });
    const ancestorReview = page.locator(".proposal-row").filter({ has: page.locator("legend", { hasText: "/browserAncestor/child" }) });
    await firstNameReview.locator("select").selectOption("use_extracted");
    await ancestorReview.locator("select").selectOption("use_extracted");
    await ancestorReview.getByText('Using the extracted value will replace existing /browserAncestor: "Canonical ancestor value"').waitFor();
    await page.getByRole("button", { name: "Apply selected decisions" }).click();
    await page.getByText("Confirm that accepting /browserAncestor/child replaces /browserAncestor.").waitFor();
    assert.equal((await cli("profile-inspect")).profile.browserAncestor, "Canonical ancestor value");
    await ancestorReview.getByLabel("I confirm replacing /browserAncestor").check();
    await page.getByRole("button", { name: "Apply selected decisions" }).click();
    await page.locator("#proposal-dialog").waitFor({ state: "hidden" });
    profile = await cli("profile-inspect");
    assert.equal(profile.profile.firstName, "Extracted browser fact");
    assert.equal(profile.profile.browserAutoFact, "Auto-filled browser fact");
    assert.deepEqual(profile.profile.browserAncestor, { child: "Extracted child" });
    assert.equal((await cli("resume-proposal-get", ["--id", proposal.id])).status, "completed");
    await page.getByRole("button", { name: "Close resume details" }).click();
    await page.route(/\/api\/resumes$/, async (route) => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
      await route.continue();
    });
    await page.locator("#resumes-refresh").click();
    await page.locator("#resumes-trash").click();
    await page.getByText("0 trashed resumes.").waitFor();
    await page.waitForTimeout(500);
    assert.equal(await page.getByRole("heading", { name: "Browser resume" }).count(), 0);
    await page.unroute(/\/api\/resumes$/);
    await page.getByRole("button", { name: "Jobs" }).click();

    const cliButton = page.getByRole("button", { name: /CLI Engineer/ });
    await cliButton.waitFor();
    assert.equal(await page.getByRole("listitem").count(), 1);
    assert.equal(await page.getByRole("listitem").locator("button").count(), 1);
    assert.equal(await cliButton.getAttribute("role"), null);

    await cliButton.focus();
    await page.keyboard.press("Enter");
    await page.locator("#job-dialog[open]").waitFor();
    const closeDetails = page.getByRole("button", { name: "Close job details" });
    await closeDetails.focus();
    await page.keyboard.press("Enter");
    await page.locator("#job-dialog").waitFor({ state: "hidden" });
    await page.waitForFunction((id) => document.activeElement?.dataset?.id === id, cliJob.id);

    await cliButton.press("Enter");
    await jobDialog.getByLabel("Role", { exact: true }).fill("Browser-edited CLI Engineer");
    await jobDialog.getByLabel("Notes", { exact: true }).fill("Edited in the browser");
    await page.getByRole("button", { name: "Save job" }).click();
    await page.locator("#job-dialog").waitFor({ state: "hidden" });
    await page.waitForFunction((id) => document.activeElement?.dataset?.id === id, cliJob.id);
    const browserEdited = await cli("job-get", ["--id", cliJob.id]);
    assert.equal(browserEdited.role, "Browser-edited CLI Engineer");
    assert.equal(browserEdited.notes, "Edited in the browser");
    assert.equal(browserEdited.revision, reassignedCliJob.revision + 1);

    await page.getByRole("button", { name: "New job" }).click();
    await jobDialog.getByLabel("Job URL", { exact: true }).fill("https://example.com/jobs/ui-browser");
    await jobDialog.getByLabel("Role", { exact: true }).fill("UI Engineer");
    await jobDialog.getByLabel("Company", { exact: true }).fill("UI Co");
    await jobDialog.getByLabel("Priority", { exact: true }).fill("4");
    await jobDialog.getByLabel("Notes", { exact: true }).fill("Created in the browser");
    await page.getByRole("button", { name: "Save job" }).click();
    await page.locator("#job-dialog").waitFor({ state: "hidden" });
    const listed = await cli("job-list");
    const uiJob = listed.find((job) => job.role === "UI Engineer");
    assert.ok(uiJob, "browser-created job must be visible to the CLI");
    await page.waitForFunction((id) => document.activeElement?.dataset?.id === id, uiJob.id);

    await page.getByRole("button", { name: /UI Engineer/ }).press("Enter");
    await jobDialog.getByLabel("Role", { exact: true }).fill("My preserved draft");
    const cliUpdated = await cli("job-update", ["--id", uiJob.id, "--expected-revision", String(uiJob.revision), "--origin", "human"], { role: "CLI canonical edit", notes: "CLI concurrent note" });
    await cli("job-transition", ["--id", uiJob.id, "--status", "needs_info", "--expected-revision", String(cliUpdated.revision)]);
    await page.getByRole("button", { name: "Save job" }).click();
    const conflict = page.locator("#conflict");
    await conflict.waitFor();
    assert.equal(await jobDialog.getByLabel("Role", { exact: true }).inputValue(), "My preserved draft");
    assert.match(await conflict.innerText(), /CLI canonical edit/);
    assert.equal(await page.evaluate(() => document.activeElement?.id), "conflict");

    await page.getByRole("button", { name: "Reapply my draft" }).click();
    assert.equal(await jobDialog.getByLabel("Role", { exact: true }).inputValue(), "My preserved draft");
    assert.equal(await jobDialog.getByLabel("Notes", { exact: true }).inputValue(), "CLI concurrent note");
    assert.equal(await page.getByRole("button", { name: "Move to saved" }).isVisible(), true);
    assert.equal(await page.getByRole("button", { name: "Move to needs info" }).count(), 0);
    await page.getByRole("button", { name: "Save job" }).click();
    await page.locator("#job-dialog").waitFor({ state: "hidden" });
    const safelyRebased = await cli("job-get", ["--id", uiJob.id]);
    assert.equal(safelyRebased.role, "My preserved draft");
    assert.equal(safelyRebased.notes, "CLI concurrent note");

    await page.getByRole("button", { name: /My preserved draft/ }).click();
    await jobDialog.getByLabel("Company", { exact: true }).fill("Offline draft company");
    const newest = await cli("job-update", ["--id", uiJob.id, "--expected-revision", String(safelyRebased.revision), "--origin", "human"], { notes: "Newest canonical note" });
    await page.route(`**/api/jobs/${uiJob.id}`, (route) => route.request().method() === "GET" ? route.abort() : route.continue());
    await page.getByRole("button", { name: "Save job" }).click();
    await conflict.waitFor();
    assert.match(await conflict.innerText(), /could not be loaded/i);
    assert.equal(await page.getByRole("button", { name: "Load canonical values" }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Reapply my draft" }).isDisabled(), true);
    assert.equal(await jobDialog.getByLabel("Company", { exact: true }).inputValue(), "Offline draft company");
    await page.unroute(`**/api/jobs/${uiJob.id}`);
    await page.getByRole("button", { name: "Save job" }).click();
    await page.getByRole("button", { name: "Load canonical values" }).click();
    assert.equal(await jobDialog.getByLabel("Notes", { exact: true }).inputValue(), "Newest canonical note");
    await page.getByRole("button", { name: "Run ready check" }).click();
    await page.getByText("No blocking issues").waitFor();
    await page.getByRole("button", { name: "Mark ready" }).click();
    await page.locator("#job-dialog").waitFor({ state: "hidden" });
    const ready = await cli("job-list", ["--status", "ready"]);
    assert.equal(ready.some((job) => job.id === uiJob.id), true);
    await page.waitForFunction((id) => document.activeElement?.dataset?.id === id, uiJob.id);

    let activityJob = await cli("job-get", ["--id", uiJob.id]);
    let claim = await cli("job-acquire", ["--id", uiJob.id, "--owner", "private-browser-owner", "--expected-revision", String(activityJob.revision)]);
    const activityCard = () => page.getByRole("button", { name: /My preserved draft/ });
    await activityCard().click();
    const activityPanel = jobDialog.getByRole("region", { name: "Application activity" });
    await activityPanel.getByText(/Agent attempt active/).waitFor();
    assert.match(await activityPanel.innerText(), /Canonical status in progress/);
    assert.equal((await activityPanel.innerText()).includes("private-browser-owner"), false);
    assert.equal((await activityPanel.innerText()).includes(claim.token), false);
    await closeDetails.click();

    await cli("claim-progress", ["--id", uiJob.id, "--token", claim.token], {
      status: "active", step: "questions", answerKeys: ["private.browser.answer"],
      pendingFields: [{ question: "Do you need sponsorship?", state: "missing", answerKey: "private.browser.answer", sensitive: true }],
    });
    await activityCard().click();
    await activityPanel.getByText("Do you need sponsorship? · missing · sensitive").waitFor();
    const progressText = await activityPanel.innerText();
    assert.equal(progressText.includes("private.browser.answer"), false);
    assert.equal(progressText.includes("answerKey"), false);
    await closeDetails.click();

    activityJob = await cli("job-get", ["--id", uiJob.id]);
    await cli("claim-handoff", ["--id", uiJob.id, "--token", claim.token, "--status", "needs_info", "--expected-revision", String(activityJob.revision)], {
      status: "active", step: "questions", answerKeys: ["private.browser.answer"],
      pendingFields: [{ question: "Do you need sponsorship?", state: "missing", answerKey: "private.browser.answer", sensitive: true }],
    });
    await activityCard().click();
    await activityPanel.getByText(/Canonical status needs info/).waitFor();
    assert.match(await activityPanel.innerText(), /job-blocked · needs info/i);
    assert.equal(await activityPanel.locator("button").count(), 0);
    await page.getByRole("button", { name: "Mark ready" }).click();
    await page.locator("#job-dialog").waitFor({ state: "hidden" });

    activityJob = await cli("job-get", ["--id", uiJob.id]);
    claim = await cli("job-acquire", ["--id", uiJob.id, "--owner", "private-recovery-owner", "--expected-revision", String(activityJob.revision)]);
    const coordinatorPath = join(storeRoot, "coordinator.json");
    const coordinator = JSON.parse(await readFile(coordinatorPath, "utf8"));
    coordinator.claim.expiresAt = "2000-01-01T00:00:00Z";
    await writeFile(coordinatorPath, JSON.stringify(coordinator));
    await activityCard().click();
    await activityPanel.getByText(/lease expired/).waitFor();
    assert.match(await activityPanel.innerText(), /CLI claim-recover/);
    assert.equal((await activityPanel.innerText()).includes(coordinator.claim.claimId), false);
    await closeDetails.click();

    const recovered = await cli("claim-recover", ["--id", uiJob.id, "--owner", "private-recovered-owner"]);
    assert.notEqual(recovered.token, claim.token);
    await activityCard().click();
    await activityPanel.getByText(/Agent attempt active/).waitFor();
    const recoveredText = await activityPanel.innerText();
    assert.equal(recoveredText.includes(recovered.token), false);
    assert.equal(recoveredText.includes("private-recovered-owner"), false);
    await closeDetails.click();

    activityJob = await cli("job-get", ["--id", uiJob.id]);
    await cli("claim-handoff", ["--id", uiJob.id, "--token", recovered.token, "--status", "awaiting_review", "--expected-revision", String(activityJob.revision)], {
      status: "review", step: "review", pendingFields: [], answerKeys: [],
    });
    await activityCard().click();
    await activityPanel.getByText(/Canonical status awaiting review/).waitFor();
    const statusActions = jobDialog.getByRole("region", { name: "Status actions" });
    const statusActionButtons = statusActions.getByRole("button");
    assert.deepEqual(await statusActionButtons.allTextContents(), ["Mark applied…", "Close job"]);
    assert.equal(await statusActions.getByRole("button", { name: /in progress/i }).count(), 0);
    assert.equal(await statusActions.getByRole("button", { name: "Mark applied…", exact: true }).count(), 1);
    assert.equal(await statusActions.getByRole("button", { name: "Close job", exact: true }).count(), 1);
    page.once("dialog", (prompt) => prompt.accept());
    await statusActions.getByRole("button", { name: "Mark applied…", exact: true }).click();
    await page.locator("#job-dialog").waitFor({ state: "hidden" });
    assert.equal((await cli("job-get", ["--id", uiJob.id])).status, "applied");

    await page.getByRole("button", { name: /Browser-edited CLI Engineer/ }).click();
    await page.getByLabel("Closed outcome").selectOption("withdrawn");
    await page.getByRole("button", { name: "Close job", exact: true }).click();
    await page.locator("#job-dialog").waitFor({ state: "hidden" });
    const closed = await cli("job-get", ["--id", cliJob.id]);
    assert.equal(closed.status, "closed");
    assert.equal(closed.closedOutcome, "withdrawn");

    await page.getByRole("button", { name: /Browser-edited CLI Engineer/ }).click();
    page.once("dialog", (prompt) => prompt.accept());
    await page.getByRole("button", { name: "Move to trash" }).click();
    await page.locator("#job-dialog").waitFor({ state: "hidden" });
    await page.waitForFunction((id) => document.activeElement?.dataset?.id === id, uiJob.id);
    assert.equal((await cli("job-get", ["--id", cliJob.id])), null);
    const trashedCliJob = await cli("job-get", ["--id", cliJob.id, "--include-trashed"]);
    await cli("job-restore", ["--id", cliJob.id, "--expected-revision", String(trashedCliJob.revision)]);

    const cliObserved = await cli("answer-observe", [], { question: "Will you relocate for this role?", state: "missing", scope: { ats: "browser" } });
    await page.getByRole("button", { name: "Answers" }).click();
    await page.locator("#answer-view").selectOption("pending");
    await page.getByRole("heading", { name: "Will you relocate for this role?" }).waitFor();
    const observedCard = page.locator(".answer-card").filter({ hasText: "Will you relocate for this role?" });
    assert.equal(await observedCard.getAttribute("role"), null);
    assert.equal(await observedCard.locator("xpath=..").getAttribute("role"), "listitem");
    await observedCard.click();
    await page.locator("#answer-dialog[open]").waitFor();
    await page.locator("#answer-dialog").getByLabel("State").selectOption("sensitive");
    await page.locator("#answer-dialog").getByLabel("Sensitivity").selectOption("high");
    await page.locator("#answer-dialog").getByLabel("Value", { exact: true }).fill("relocation-sensitive-draft");
    await page.locator("#answer-dialog").getByLabel(/freshly consent/).check();
    await page.locator("#answer-dialog").getByRole("button", { name: "Accept", exact: true }).click();
    await page.locator("#answer-dialog").waitFor({ state: "hidden" });
    const acceptedObserved = await cli("answer-get", ["--key", cliObserved.key]);
    assert.equal(acceptedObserved.reviewStatus, "accepted");
    assert.equal("value" in acceptedObserved, false);
    assert.equal((await cli("answer-reveal", ["--key", cliObserved.key])).value, "relocation-sensitive-draft");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "answer-new");

    await page.locator("#answer-view").selectOption("accepted");
    const questionless = await cli("answer-put", [], { key: "explicit-questionless", state: "missing" });
    const reservedObserved = await cli("answer-put", [], { key: "observed", question: "Reserved observed browser key?", state: "confirmed", value: "observed value" });
    const reservedTrash = await cli("answer-put", [], { key: "trash", question: "Reserved trash browser key?", state: "confirmed", value: "trash value" });
    const dotOnly = await cli("answer-put", [], { key: "..", state: "missing" });
    const slowDetail = await cli("answer-put", [], { question: "Slow answer detail?", state: "missing" });
    const fastDetail = await cli("answer-put", [], { question: "Fast answer detail?", state: "missing" });
    await page.getByRole("button", { name: "Refresh" }).click();

    const slowDetailRoute = `**${answerApiPath(slowDetail.key)}`;
    await page.route(slowDetailRoute, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await route.continue();
    });
    await page.locator(`.answer-card[data-key="${slowDetail.key}"]`).click();
    await page.locator(`.answer-card[data-key="${fastDetail.key}"]`).click();
    await page.locator("#answer-dialog[open]").waitFor();
    assert.equal(await page.locator("#answer-dialog").getByLabel("Question").inputValue(), "Fast answer detail?");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await page.locator("#answer-dialog").getByLabel("Question").inputValue(), "Fast answer detail?");
    await page.locator("#answer-dialog").getByRole("button", { name: "Close answer details" }).click();
    await page.unroute(slowDetailRoute);

    await page.locator(`.answer-card[data-key="${dotOnly.key}"]`).click();
    await page.locator("#answer-dialog").getByLabel("Aliases (one per line)").fill("dot-only browser alias");
    await page.locator("#answer-dialog").getByRole("button", { name: "Save answer" }).click();
    await page.locator("#answer-dialog").waitFor({ state: "hidden" });
    assert.deepEqual((await cli("answer-get", ["--key", dotOnly.key])).aliases, ["dot only browser alias"]);
    await page.locator(`.answer-card[data-key="${dotOnly.key}"]`).click();
    page.once("dialog", (prompt) => prompt.accept());
    await page.locator("#answer-dialog").getByRole("button", { name: "Move to trash" }).click();
    await page.locator("#answer-dialog").waitFor({ state: "hidden" });
    await page.locator("#answer-view").selectOption("trash");
    await page.locator(`.answer-card[data-key="${dotOnly.key}"]`).click();
    await page.locator("#answer-dialog").getByRole("button", { name: "Restore" }).click();
    await page.locator("#answer-dialog").waitFor({ state: "hidden" });
    await page.locator("#answer-view").selectOption("accepted");

    await page.locator(`.answer-card[data-key="${questionless.key}"]`).click();
    assert.equal(await page.locator("#answer-dialog").getByLabel("Question").getAttribute("required"), null);
    await page.locator("#answer-dialog").getByLabel("Aliases (one per line)").fill("questionless browser alias");
    await page.locator("#answer-dialog").getByRole("button", { name: "Save answer" }).click();
    await page.locator("#answer-dialog").waitFor({ state: "hidden" });
    assert.deepEqual((await cli("answer-get", ["--key", questionless.key])).aliases, ["questionless browser alias"]);
    await page.locator(`.answer-card[data-key="${questionless.key}"]`).click();
    await page.locator("#answer-dialog").getByRole("button", { name: "Merge duplicate…" }).click();
    await page.locator("#answer-merge-dialog").waitFor({ state: "visible" });
    const questionlessMergeCopy = await page.locator("#answer-merge-source").innerText();
    assert.equal(questionlessMergeCopy.includes(`Question not recorded (explicit key: ${questionless.key})`), true);
    assert.equal(questionlessMergeCopy.includes("· accepted · revision 2"), true);
    assert.equal(questionlessMergeCopy.includes("It has no retained value to discard."), true);
    await page.locator("#answer-merge-dialog").getByRole("button", { name: "Cancel" }).click();
    await page.locator("#answer-dialog").getByRole("button", { name: "Close answer details" }).click();
    await page.locator("#answer-dialog").waitFor({ state: "hidden" });
    await page.locator(`.answer-card[data-key="${reservedObserved.key}"]`).click();
    const reservedObservedDialog = page.locator("#answer-dialog");
    await reservedObservedDialog.waitFor({ state: "visible" });
    assert.equal(await reservedObservedDialog.getByLabel("Question").inputValue(), "Reserved observed browser key?");
    const reservedObservedAliases = reservedObservedDialog.getByLabel("Aliases (one per line)");
    await reservedObservedAliases.fill("reserved observed alias");
    assert.equal(await reservedObservedAliases.inputValue(), "reserved observed alias");
    const reservedObservedPath = answerApiPath(reservedObserved.key);
    const reservedObservedPatch = page.waitForResponse((response) => {
      const request = response.request();
      return new URL(response.url()).pathname === reservedObservedPath && request.method() === "PATCH";
    });
    await reservedObservedDialog.getByRole("button", { name: "Save answer" }).click();
    const reservedObservedResponse = await reservedObservedPatch;
    assert.equal(reservedObservedResponse.status(), 200);
    assert.deepEqual(reservedObservedResponse.request().postDataJSON().patch, { aliases: ["reserved observed alias"] });
    await reservedObservedDialog.waitFor({ state: "hidden" });
    assert.deepEqual((await cli("answer-get", ["--key", reservedObserved.key])).aliases, ["reserved observed alias"]);
    await page.locator(".answer-card").filter({ hasText: "Reserved trash browser key?" }).click();
    page.once("dialog", (prompt) => prompt.accept());
    await page.locator("#answer-dialog").getByRole("button", { name: "Move to trash" }).click();
    await page.locator("#answer-dialog").waitFor({ state: "hidden" });
    await page.locator("#answer-view").selectOption("trash");
    await page.locator(".answer-card").filter({ hasText: "Reserved trash browser key?" }).click();
    await page.locator("#answer-dialog").getByRole("button", { name: "Restore" }).click();
    await page.locator("#answer-dialog").waitFor({ state: "hidden" });
    assert.equal((await cli("answer-get", ["--key", reservedTrash.key])).deletedAt, null);
    await page.locator("#answer-view").selectOption("accepted");
    await page.getByRole("button", { name: "New answer" }).click();
    const answerDialog = page.locator("#answer-dialog");
    await answerDialog.getByLabel("Question").fill("Browser reusable answer?");
    await answerDialog.getByLabel("Value", { exact: true }).fill("Browser reusable value");
    await answerDialog.getByRole("button", { name: "Save answer" }).click();
    await answerDialog.waitFor({ state: "hidden" });
    let browserAnswer = await cli("answer-find", ["--question", "Browser reusable answer?", "--scope", "{}"]);
    assert.equal(browserAnswer.value, "Browser reusable value");

    await page.getByRole("button", { name: "New answer" }).click();
    await answerDialog.getByLabel("Question").fill("Browser private answer?");
    await answerDialog.getByLabel("State").selectOption("sensitive");
    await answerDialog.getByLabel("Sensitivity").selectOption("high");
    await answerDialog.getByLabel("Value", { exact: true }).fill("browser-sensitive-secret");
    await answerDialog.getByLabel(/freshly consent/).check();
    await answerDialog.getByRole("button", { name: "Save answer" }).click();
    await answerDialog.waitFor({ state: "hidden" });
    const cliLibrary = await cli("answer-list");
    const sensitiveAnswer = await cli("answer-find", ["--question", "Browser private answer?", "--scope", "{}"]);
    assert.equal(JSON.stringify(cliLibrary).includes("browser-sensitive-secret"), false);
    assert.equal("value" in sensitiveAnswer, false);
    const sensitiveCard = page.locator(".answer-card").filter({ hasText: "Browser private answer?" });
    assert.equal((await sensitiveCard.innerText()).includes("browser-sensitive-secret"), false);
    await sensitiveCard.click();
    await page.locator("#answer-dialog[open]").waitFor();
    assert.equal(await answerDialog.getByLabel("Value", { exact: true }).inputValue(), "");
    await answerDialog.getByRole("button", { name: "Reveal sensitive value" }).click();
    await page.waitForFunction(() => document.querySelector("#answer-form [name=value]")?.value === "browser-sensitive-secret");
    assert.equal(await answerDialog.getByLabel("Value", { exact: true }).inputValue(), "browser-sensitive-secret");
    await answerDialog.getByRole("button", { name: "Close answer details" }).click();
    await page.waitForFunction((key) => document.activeElement?.dataset?.key === key, sensitiveAnswer.key);

    const duplicate = await cli("answer-put", [], { question: "Duplicate browser reusable answer?", state: "confirmed", value: "discarded-browser-duplicate" });
    await page.getByRole("button", { name: "Refresh" }).click();
    const duplicateCard = page.locator(".answer-card").filter({ hasText: "Duplicate browser reusable answer?" });
    await duplicateCard.click();
    await answerDialog.getByLabel("Aliases (one per line)").fill("unsaved source merge draft");
    await answerDialog.getByRole("button", { name: "Merge duplicate…" }).click();
    await answerDialog.getByText("Save this draft or close the answer details to discard it before merging.").waitFor();
    assert.equal(await page.locator("#answer-merge-dialog").isVisible(), false);
    assert.equal(await answerDialog.getByLabel("Aliases (one per line)").inputValue(), "unsaved source merge draft");
    await answerDialog.getByRole("button", { name: "Close answer details" }).click();
    await duplicateCard.click();
    await answerDialog.getByRole("button", { name: "Merge duplicate…" }).click();
    const mergeDialog = page.locator("#answer-merge-dialog");
    await mergeDialog.waitFor({ state: "visible" });
    assert.equal((await mergeDialog.innerText()).includes("Browser reusable value"), false);
    assert.equal((await mergeDialog.innerText()).includes("discarded-browser-duplicate"), false);
    await mergeDialog.getByLabel("Accepted winner").selectOption(browserAnswer.key);
    await mergeDialog.getByRole("button", { name: "Merge into selected winner" }).click();
    await mergeDialog.waitFor({ state: "hidden" });
    await answerDialog.waitFor({ state: "hidden" });
    const redirectedDuplicate = await cli("answer-get", ["--key", duplicate.key]);
    assert.equal(redirectedDuplicate.key, browserAnswer.key);
    assert.equal(redirectedDuplicate.redirectedFrom, duplicate.key);
    assert.equal((await cli("answer-reveal", ["--key", duplicate.key])).value, "Browser reusable value");
    browserAnswer = await cli("answer-get", ["--key", browserAnswer.key]);
    const afterMerge = await cli("answer-list");
    assert.equal(JSON.stringify(afterMerge).includes("discarded-browser-duplicate"), false);

    await page.route("**/api/answers/query", async (route) => {
      const query = route.request().postDataJSON()?.query;
      if (query === "Browser reusable") await new Promise((resolve) => setTimeout(resolve, 250));
      await route.continue();
    });
    await page.locator("#answer-search").fill("Browser reusable");
    await page.locator("#answer-search").fill("No canonical answer matches this");
    await page.waitForFunction(() => document.querySelector("#answers-status")?.textContent?.startsWith("0 canonical"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await page.locator(".answer-card").count(), 0);
    await page.unroute("**/api/answers/query");
    await page.locator("#answer-search").fill("");
    await page.getByRole("heading", { name: "Browser reusable answer?" }).waitFor();
    await page.locator("#answer-state-filter").selectOption("sensitive");
    await page.waitForFunction(() => ![...document.querySelectorAll(".answer-card")].some((card) => card.textContent?.includes("Browser reusable answer?")));
    assert.equal(await page.locator(".answer-card").filter({ hasText: "Browser private answer?" }).count(), 1);
    assert.equal(await page.locator(".answer-card").filter({ hasText: "Browser reusable answer?" }).count(), 0);
    await page.locator("#answer-state-filter").selectOption("");
    await page.getByRole("heading", { name: "Browser reusable answer?" }).waitFor();

    const reusableCard = page.locator(".answer-card").filter({ hasText: "Browser reusable answer?" });
    await reusableCard.click();
    await answerDialog.getByLabel("Aliases (one per line)").fill("Browser alias draft");
    browserAnswer = await cli("answer-update", ["--key", browserAnswer.key, "--expected-revision", String(browserAnswer.revision)], { source: "agent" });
    await answerDialog.getByRole("button", { name: "Save answer" }).click();
    await page.locator("#answer-conflict").waitFor();
    assert.equal(await answerDialog.getByLabel("Aliases (one per line)").inputValue(), "Browser alias draft");
    await page.locator("#answer-conflict").getByRole("button", { name: "Refresh canonical revision" }).click();
    assert.equal(await answerDialog.getByLabel("Aliases (one per line)").inputValue(), "Browser alias draft");
    await answerDialog.getByRole("button", { name: "Save answer" }).click();
    await answerDialog.waitFor({ state: "hidden" });
    browserAnswer = await cli("answer-find", ["--question", "Browser alias draft", "--scope", "{}"]);
    assert.equal(browserAnswer.source, "agent");

    await cli("history-append", [], { applicationId: "browser-answer-history", event: "reviewed", answerKeys: [browserAnswer.key] });
    await page.locator(".answer-card").filter({ hasText: "Browser reusable answer?" }).click();
    page.once("dialog", (prompt) => prompt.accept());
    await answerDialog.getByRole("button", { name: "Move to trash" }).click();
    await answerDialog.getByText("This answer is a canonical redirect target and cannot be moved or deleted.").waitFor();
    const activeRedirectTarget = await cli("answer-get", ["--key", browserAnswer.key, "--include-trashed"]);
    assert.equal(activeRedirectTarget.key, browserAnswer.key);
    assert.equal(activeRedirectTarget.deletedAt, null);
    await answerDialog.getByRole("button", { name: "Close answer details" }).click();

    // The packaged smoke selects this test by name, so this is the source and
    // packaged proof for the top-level unified Trash lifecycle.
    const trashJob = await cli("job-create", [], { id: "trash-ui-job", url: "https://private.example/jobs/trash-ui", role: "Trash UI job" });
    await cli("job-trash", ["--id", trashJob.id, "--expected-revision", String(trashJob.revision)]);
    const trashResumePath = join(temporary, "private-trash-resume.txt");
    await writeFile(trashResumePath, "private trash resume bytes");
    const trashResume = await cli("resume-create", [], { id: "trash-ui-resume", label: "Trash UI resume", path: trashResumePath });
    await cli("resume-trash", ["--id", trashResume.id, "--expected-revision", String(trashResume.revision)]);
    const trashAnswer = await cli("answer-put", [], { question: "Trash UI answer?", state: "confirmed", value: "private-trash-answer" });
    await cli("answer-trash", ["--key", trashAnswer.key, "--expected-revision", String(trashAnswer.revision)]);
    const protectedAnswer = await cli("answer-put", [], { question: "Protected Trash UI answer?", state: "confirmed", value: "protected-private-answer" });
    await cli("history-append", [], { applicationId: "trash-ui-history", event: "reviewed", answerKeys: [protectedAnswer.key] });
    await cli("answer-trash", ["--key", protectedAnswer.key, "--expected-revision", String(protectedAnswer.revision)]);

    await page.locator("#nav-trash").click();
    await page.locator("#trash-refresh").click();
    await page.getByText("1 jobs · 1 resumes · 2 answers").waitFor();
    const trashWorkspaceText = await page.locator("#trash-workspace").innerText();
    for (const privateValue of ["private.example", "private-trash-answer", "protected-private-answer", "private-trash-resume.txt"]) {
      assert.equal(trashWorkspaceText.includes(privateValue), false);
    }
    const typeFilter = page.locator("#trash-type-filter");
    await typeFilter.selectOption("job");
    assert.equal(await page.locator(".trash-card").count(), 1);
    assert.match(await page.locator(".trash-card").innerText(), /Trash UI job/);

    // Restore persists canonically, then a stale destructive request is never retried.
    await page.locator(".trash-card").getByRole("button", { name: "Restore" }).click();
    let currentTrashJob = await cli("job-get", ["--id", trashJob.id]);
    assert.equal(currentTrashJob.deletedAt, null);
    currentTrashJob = await cli("job-trash", ["--id", currentTrashJob.id, "--expected-revision", String(currentTrashJob.revision)]);
    await page.locator("#trash-refresh").click();
    const staleJobCard = page.locator(".trash-card").filter({ hasText: "Trash UI job" });
    const refreshedJob = await cli("job-restore", ["--id", currentTrashJob.id, "--expected-revision", String(currentTrashJob.revision)]);
    currentTrashJob = await cli("job-trash", ["--id", refreshedJob.id, "--expected-revision", String(refreshedJob.revision)]);
    await staleJobCard.getByRole("button", { name: "Delete permanently…" }).click();
    let trashDeleteDialog = page.locator("#trash-delete-dialog");
    await trashDeleteDialog.getByLabel(/Type DELETE JOB/).fill("DELETE JOB");
    await trashDeleteDialog.getByRole("button", { name: "Delete permanently" }).click();
    await page.locator("#trash-delete-conflict").waitFor();
    assert.match(await page.locator("#trash-delete-conflict").innerText(), /Nothing was deleted.*not retried/s);
    assert.ok(await cli("job-get", ["--id", currentTrashJob.id, "--include-trashed"]));
    await page.locator("#trash-conflict-refresh").click();

    // Exact typed deletion removes only the refreshed selected job.
    await page.locator(".trash-card").filter({ hasText: "Trash UI job" }).getByRole("button", { name: "Delete permanently…" }).click();
    await trashDeleteDialog.getByLabel(/Type DELETE JOB/).fill("DELETE JOB");
    await trashDeleteDialog.getByRole("button", { name: "Delete permanently" }).click();
    await trashDeleteDialog.waitFor({ state: "hidden" });
    assert.equal(await cli("job-get", ["--id", currentTrashJob.id, "--include-trashed"]), null);

    // Resume restore persists; its confirmation discloses managed-file destruction.
    await typeFilter.selectOption("resume");
    await page.locator(".trash-card").filter({ hasText: "Trash UI resume" }).getByRole("button", { name: "Restore" }).click();
    let currentTrashResume = await cli("resume-get", ["--id", trashResume.id]);
    assert.equal(currentTrashResume.deletedAt, null);
    currentTrashResume = await cli("resume-trash", ["--id", currentTrashResume.id, "--expected-revision", String(currentTrashResume.revision)]);
    await page.locator("#trash-refresh").click();
    await page.locator(".trash-card").filter({ hasText: "Trash UI resume" }).getByRole("button", { name: "Delete permanently…" }).click();
    assert.match(await page.locator("#trash-delete-impact").innerText(), /managed resume file.*unrelated jobs.*history, sessions, or audit evidence/);
    await trashDeleteDialog.getByLabel(/Type DELETE RESUME/).fill("DELETE RESUME");
    await trashDeleteDialog.getByRole("button", { name: "Delete permanently" }).click();
    await trashDeleteDialog.waitFor({ state: "hidden" });
    assert.equal(await cli("resume-get", ["--id", currentTrashResume.id, "--include-trashed"]), null);

    // Answer restore persists, while protected history produces actionable blocker copy.
    await typeFilter.selectOption("answer");
    const trashAnswerCard = page.locator(".trash-card").filter({ has: page.getByRole("heading", { name: "Trash UI answer?", exact: true }) });
    await trashAnswerCard.getByRole("button", { name: "Restore" }).click();
    let currentTrashAnswer = await cli("answer-get", ["--key", trashAnswer.key]);
    assert.equal(currentTrashAnswer.deletedAt, null);
    currentTrashAnswer = await cli("answer-trash", ["--key", currentTrashAnswer.key, "--expected-revision", String(currentTrashAnswer.revision)]);
    await page.locator("#trash-refresh").click();
    await page.locator(".trash-card").filter({ hasText: "Protected Trash UI answer?" }).getByRole("button", { name: "Delete permanently…" }).click();
    await trashDeleteDialog.getByLabel(/Type DELETE ANSWER/).fill("DELETE ANSWER");
    await trashDeleteDialog.getByRole("button", { name: "Delete permanently" }).click();
    await page.locator("#trash-delete-error").getByText(/protected application history.*1 protected reference/i).waitFor();
    assert.ok(await cli("answer-get", ["--key", protectedAnswer.key, "--include-trashed"]));
    await trashDeleteDialog.getByRole("button", { name: "Cancel" }).click();
    await trashAnswerCard.getByRole("button", { name: "Delete permanently…" }).click();
    await trashDeleteDialog.getByLabel(/Type DELETE ANSWER/).fill("DELETE ANSWER");
    await trashDeleteDialog.getByRole("button", { name: "Delete permanently" }).click();
    await trashDeleteDialog.waitFor({ state: "hidden" });
    assert.equal(await cli("answer-get", ["--key", currentTrashAnswer.key, "--include-trashed"]), null);

    await browser.close(); browser = null;
    server.kill("SIGINT");
    const exitCode = await new Promise((resolve) => server.once("exit", resolve));
    assert.equal(exitCode, 0);
    server = null;
    assert.equal((await cli("job-list", ["--status", "applied"])).some((job) => job.id === uiJob.id), true);
    assert.equal(cliUpdated.role, "CLI canonical edit");
    assert.equal(newest.notes, "Newest canonical note");
  } finally {
    if (browser) await browser.close();
    if (server && server.exitCode === null) {
      server.kill("SIGINT");
      await new Promise((resolve) => server.once("exit", resolve));
    }
    await rm(temporary, { recursive: true, force: true });
  }
});
