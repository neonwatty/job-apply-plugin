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
const {
  ApiError,
  FACT_SAVE_REVISION_RETRIES,
  canMarkReadyFrom,
  createApi,
  conflictingPaths,
  filterJobs,
  formPatch,
  patchForPaths,
  pointerValue,
  safeSessionStorage,
  sessionToken,
  shouldRetryFactSave,
  summarizeProvenance,
  tokenFromHash,
  transitionsFor,
} = await import(pathToFileURL(join(REPO_ROOT, "workspace", "app.js")).href);

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
});

test("styles include visible focus, reduced motion, contrast mode, and responsive behavior", async () => {
  const css = await readFile(join(REPO_ROOT, "workspace", "styles.css"), "utf8");
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /prefers-color-scheme: dark/);
  assert.match(css, /@media \(max-width:/);
});

test("real browser and CLI share CRUD, conflict, ready handoff, semantics, focus, and shutdown", { timeout: 60_000 }, async () => {
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
    await writeFile(resumePath, "resume");
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
    await page.goto(startup.url);
    await page.getByText("Canonical store connected").waitFor();
    await page.reload();
    await page.getByText("Canonical store connected").waitFor();
    const jobDialog = page.locator("#job-dialog");

    await page.getByRole("button", { name: "Facts" }).click();
    await page.getByLabel("First name").waitFor();
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
    const browserEdited = await cli("job-get", ["--id", cliJob.id]);
    assert.equal(browserEdited.role, "Browser-edited CLI Engineer");
    assert.equal(browserEdited.notes, "Edited in the browser");
    assert.equal(browserEdited.revision, cliJob.revision + 1);
    await page.waitForFunction((id) => document.activeElement?.dataset?.id === id, cliJob.id);

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

    await browser.close(); browser = null;
    server.kill("SIGINT");
    const exitCode = await new Promise((resolve) => server.once("exit", resolve));
    assert.equal(exitCode, 0);
    server = null;
    assert.equal((await cli("job-list", ["--status", "ready"])).some((job) => job.id === uiJob.id), true);
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
