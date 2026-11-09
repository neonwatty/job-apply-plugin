import { skillText } from "./workspace_skill_support.mjs";
import {
  assert,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  tmpdir,
  join,
  resolve,
  spawn,
  spawnSync,
  test,
  chromium,
  REPO_ROOT,
  PYTHON,
  minimalSyntheticPdf,
  liveReviewSession,
  answerApiPath,
  answerNeedsFreshConsent,
  answerSummary,
  canApplyAnswerReveal,
  canApplyAnswerDialogResponse,
  canApplyAnswerDialogMutation,
  canRefreshAnswerDraft,
  canRevealAnswer,
  sameAnswerScope,
} from "./workspace_test_support.mjs";

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


test("answer-memory documents guarded profile and preference mutations", async () => {
  const skill = skillText(REPO_ROOT, "answer-memory");
  assert.match(skill, /profile-replace[\s\\]+--input <profile\.json> --expected-revision <revision>[\s\\]+--source <user\|resume\|agent\|migration>/);
  assert.match(skill, /preferences-set[\s\\]+--input <preferences\.json> --expected-revision <revision>[\s\\]+--source <user\|resume\|agent\|migration> \[--replace\]/);
  assert.match(skill, /sole existing-record mutation that intentionally takes no expected revision/);
  assert.match(skill, /--winner-key <accepted-winner-key> --source-key <active-duplicate-key>/);
  assert.doesNotMatch(skill, /--source-key <accepted-duplicate-key>/);
});

test("answer browser routes encode canonical keys at every path boundary", async () => {
  const app = await readFile(join(REPO_ROOT, "workspace", "features", "answers.js"), "utf8");
  for (const expression of [
    "answerApiPath(answer.key, action)",
    "answerApiPath(selected.key)",
    "answerApiPath(source.key, \"merge\")",
  ]) {
    assert.ok(app.includes(expression), expression);
  }
  assert.doesNotMatch(app, /encodeURIComponent\((?:answer|selected|source)\.key\)/);
});


test("pending answer browser journey preserves Job draft and reaches Ready, reacquisition, and awaiting review", { timeout: 60_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pending-answer-browser-"));
  const storeRoot = join(temporary, "store");
  const storeScript = join(REPO_ROOT, "scripts", "job-apply-store.py");
  let inputCounter = 0;
  const cli = async (command, args = [], payload) => {
    const finalArgs = [storeScript, "--root", storeRoot, command, ...args];
    if (payload !== undefined) {
      const inputPath = join(temporary, `pending-${inputCounter++}.json`);
      await writeFile(inputPath, JSON.stringify(payload)); finalArgs.push("--input", inputPath);
    }
    const result = spawnSync(PYTHON, finalArgs, { cwd: REPO_ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`); return JSON.parse(result.stdout);
  };
  const waitForStartup = (child) => new Promise((resolveStartup, rejectStartup) => {
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => rejectStartup(new Error(`workspace startup timed out: ${stderr}`)), 10_000);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => { stdout += chunk; const newline = stdout.indexOf("\n"); if (newline < 0) return; clearTimeout(timer); try { resolveStartup(JSON.parse(stdout.slice(0, newline))); } catch (error) { rejectStartup(error); } });
    child.once("exit", (code) => { clearTimeout(timer); rejectStartup(new Error(`workspace exited during startup (${code}): ${stderr}`)); });
  });

  let server; let browser;
  try {
    await cli("profile-replace", ["--expected-revision", "0", "--source", "user"], { firstName: "Synthetic" });
    const resumePath = join(temporary, "resume.pdf"); await writeFile(resumePath, minimalSyntheticPdf());
    const resume = await cli("resume-create", [], { id: "pending-resume", label: "Pending resume", path: resumePath });
    let job = await cli("job-create", [], { id: "pending-job", url: "https://example.invalid/jobs/pending", role: "Pending Journey", company: "Synthetic", resumeId: resume.id });
    job = await cli("job-transition", ["--id", job.id, "--status", "ready", "--expected-revision", String(job.revision)]);
    const first = await cli("job-acquire", ["--id", job.id, "--owner", "first-owner", "--expected-revision", String(job.revision)]);
    const pendingPayload = { status: "active", step: "questions", answerKeys: [], pendingFields: [{ question: "Shared visible wording?", state: "missing", answerKey: "durable.target", sensitive: false }] };
    await cli("claim-progress", ["--id", job.id, "--token", first.token], pendingPayload);
    job = (await cli("claim-handoff", ["--id", job.id, "--token", first.token, "--status", "needs_info", "--expected-revision", String(first.job.revision)], pendingPayload)).job;
    await cli("answer-put", [], { key: "durable.decoy", question: "Shared visible wording?", scope: { decoy: true }, state: "confirmed", value: "decoy" });
    await cli("answer-put", [], { key: "durable.target", question: "Different canonical wording", state: "missing" });

    server = spawn(PYTHON, [join(REPO_ROOT, "scripts", "job-apply-workspace.py"), "--root", storeRoot, "--port", "0", "--no-open", "--json"], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const startup = await waitForStartup(server);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage(); const pageErrors = []; page.on("pageerror", (error) => pageErrors.push(error));
    await page.addInitScript(() => { globalThis.setInterval = () => 0; });
    await page.goto(startup.url); await page.getByText("Canonical store connected").waitFor();
    await page.locator("#nav-attention").click();
    await page.locator('[data-attention-id="pending-job"]').click();
    const jobDialog = page.locator("#job-dialog"); const answerDialog = page.locator("#answer-dialog");
    await jobDialog.getByLabel("Notes").fill("unsaved browser draft");
    const openAnswer = jobDialog.getByRole("button", { name: "Open in Answers" });
    let releasePendingAnswer;
    let pendingAnswerSeenResolve;
    const pendingAnswerSeen = new Promise((resolve) => { pendingAnswerSeenResolve = resolve; });
    const pendingAnswerRelease = new Promise((resolve) => { releasePendingAnswer = resolve; });
    const pendingAnswerPattern = `**/api/jobs/${job.id}/pending-answers/**`;
    await page.route(pendingAnswerPattern, async (route) => {
      const response = await route.fetch();
      pendingAnswerSeenResolve();
      await pendingAnswerRelease;
      await route.fulfill({ response });
    });
    await openAnswer.click();
    await pendingAnswerSeen;
    await jobDialog.getByLabel("Notes").fill("newest unsaved browser draft");
    releasePendingAnswer();
    await answerDialog.waitFor({ state: "visible" });
    await page.unroute(pendingAnswerPattern);
    assert.equal(await jobDialog.isVisible(), true);
    assert.equal(await answerDialog.getByLabel("Question").inputValue(), "Different canonical wording");
    assert.equal(await jobDialog.getByLabel("Notes").inputValue(), "newest unsaved browser draft");
    await answerDialog.getByLabel("State").selectOption("confirmed");
    await answerDialog.getByLabel("Value", { exact: true }).fill("accepted synthetic value");
    await answerDialog.getByRole("button", { name: "Save answer" }).click();
    await answerDialog.waitFor({ state: "hidden" });
    assert.equal(await jobDialog.isVisible(), true);
    assert.equal(await jobDialog.getByLabel("Notes").inputValue(), "newest unsaved browser draft");
    await openAnswer.waitFor();
    await page.waitForFunction(() => (
      document.activeElement?.closest("#job-dialog")
      && document.activeElement.textContent?.trim() === "Open in Answers"
    ));
    await jobDialog.getByRole("button", { name: "Recheck this revision" }).click();
    await jobDialog.getByText(/Canonical status ready/i).waitFor();
    assert.equal((await cli("job-get", ["--id", job.id])).status, "ready");
    assert.equal(await jobDialog.getByLabel("Notes").inputValue(), "newest unsaved browser draft");
    await jobDialog.getByRole("button", { name: "Close job details" }).click();
    await page.locator("#attention-workspace").waitFor({ state: "visible" });
    assert.equal(await page.locator("#attention-list [data-attention-id='pending-job']").count(), 0);

    job = await cli("job-get", ["--id", job.id]);
    const second = await cli("job-acquire", ["--id", job.id, "--owner", "second-owner", "--expected-revision", String(job.revision)]);
    for (const field of ["id", "revision", "contentRevision", "digest"]) assert.equal(second.resume[field], first.resume[field]);
    assert.deepEqual(await readFile(second.resume.path), await readFile(first.resume.path));
    job = (await cli("claim-handoff", ["--id", job.id, "--token", second.token, "--status", "awaiting_review", "--expected-revision", String(second.job.revision)], await liveReviewSession(second.job.revision))).job;
    await page.getByRole("button", { name: "Jobs", exact: true }).click(); await page.locator("#refresh").click();
    await page.getByRole("button", { name: /Pending Journey/ }).click();
    await jobDialog.getByText(/Canonical status awaiting review/i).waitFor();
    const events = await cli("history-list");
    assert.deepEqual(events.map((event) => event.event), ["job-started", "job-blocked", "job-started", "reviewed"]);
    assert.equal(events.some((event) => ["completed", "applied"].includes(event.event) || event.status === "applied"), false);
    assert.equal((await cli("job-get", ["--id", job.id])).status, "awaiting_review");
    assert.equal(pageErrors.length, 0, pageErrors.map(String).join("\n"));
  } finally {
    if (browser) await browser.close();
    if (server && server.exitCode === null) { server.kill("SIGINT"); await new Promise((resolveExit) => server.once("exit", resolveExit)); }
    await rm(temporary, { recursive: true, force: true });
  }
});
