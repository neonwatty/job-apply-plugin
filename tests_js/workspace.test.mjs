import {
  assert, chromium, join, liveReviewSession, minimalSyntheticPdf, mkdtemp, PYTHON, readFile,
  REPO_ROOT, resolve, rm, spawn, spawnSync, test, tmpdir, writeFile,
} from "./workspace_test_support.mjs";
import {
  cleanupOwnerBetaScenario, createOwnerBetaScenario, startOwnerBetaScenario,
} from "./workspace_owner_beta_scenario_support.mjs";
import {
  runOwnerBetaOverviewAndPreflightPhase, runOwnerBetaPollingRecoveryPhase,
} from "./workspace_owner_beta_overview_phases.mjs";
import { runOwnerBetaFreshnessRestartPhase } from "./workspace_owner_beta_recovery_phase.mjs";
import {
  cleanupBrowserCrudScenario, createBrowserCrudScenario,
} from "./workspace_browser_crud_scenario_support.mjs";
import { runBrowserCrudFactsPhase } from "./workspace_browser_crud_facts_phase.mjs";
import { runBrowserCrudResumesPhase } from "./workspace_browser_crud_resumes_phase.mjs";
import { runBrowserCrudJobsPhase } from "./workspace_browser_crud_jobs_phase.mjs";
import { runBrowserCrudAnswersPhase } from "./workspace_browser_crud_answers_phase.mjs";
import { runBrowserCrudTrashShutdownPhase } from "./workspace_browser_crud_trash_phase.mjs";

test("owner beta clean packaged browser and CLI journey survives restart and fails closed for recovery", { timeout: 90_000 }, async () => {
  const context = await createOwnerBetaScenario();
  try {
    await startOwnerBetaScenario(context);
    await runOwnerBetaOverviewAndPreflightPhase(context);
    await runOwnerBetaPollingRecoveryPhase(context);
    await runOwnerBetaFreshnessRestartPhase(context);
  } finally {
    await cleanupOwnerBetaScenario(context);
  }
});

test("Needs Attention browser and CLI walkthrough converges all canonical reasons", { timeout: 60_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "job-attention-browser-"));
  const storeRoot = join(temporary, "store");
  const storeScript = join(REPO_ROOT, "scripts", "job-apply-store.py");
  let inputCounter = 0;
  const cli = async (command, args = [], payload) => {
    const finalArgs = [storeScript, "--root", storeRoot, command, ...args];
    if (payload !== undefined) {
      const inputPath = join(temporary, `attention-${inputCounter++}.json`);
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
    const resumePath = join(temporary, "attention-resume.pdf");
    await writeFile(resumePath, minimalSyntheticPdf());
    await cli("profile-replace", ["--expected-revision", "0", "--source", "user"], { firstName: "Ada" });
    await cli("resume-create", [], { id: "attention-resume", label: "Attention resume", path: resumePath });
    const ready = async (id, role, priority) => {
      let job = await cli("job-create", [], { id, url: `https://example.com/jobs/${id}`, role, company: "Attention Co", priority });
      job = await cli("job-transition", ["--id", id, "--status", "ready", "--expected-revision", String(job.revision)]);
      return job;
    };

    let review = await ready("review-attention", "Review attention", 5);
    const reviewClaim = await cli("job-acquire", ["--id", review.id, "--owner", "private-review-owner", "--expected-revision", String(review.revision)]);
    review = (await cli("claim-handoff", ["--id", review.id, "--token", reviewClaim.token, "--status", "awaiting_review", "--expected-revision", String(reviewClaim.job.revision)], await liveReviewSession(reviewClaim.job.revision))).job;

    let needs = await ready("needs-attention", "Needs attention", 4);
    const needsClaim = await cli("job-acquire", ["--id", needs.id, "--owner", "private-needs-owner", "--expected-revision", String(needs.revision)]);
    needs = (await cli("claim-handoff", ["--id", needs.id, "--token", needsClaim.token, "--status", "needs_info", "--expected-revision", String(needsClaim.job.revision)], {
      status: "active", step: "questions", answerKeys: ["private.answer.key"],
      pendingFields: [{ question: "Private sponsorship answer?", state: "missing", answerKey: "private.answer.key", sensitive: true }],
    })).job;

    let interrupted = await ready("interrupted-attention", "Interrupted attention", 3);
    const interruptedClaim = await cli("job-acquire", ["--id", interrupted.id, "--owner", "private-interrupted-owner", "--expected-revision", String(interrupted.revision)]);
    interrupted = interruptedClaim.job;
    const coordinatorPath = join(storeRoot, "coordinator.json");
    await writeFile(coordinatorPath, JSON.stringify({ schemaVersion: 1, claim: null }));

    let expired = await ready("expired-attention", "Expired attention", 1);
    const expiredClaim = await cli("job-acquire", ["--id", expired.id, "--owner", "private-expired-owner", "--expected-revision", String(expired.revision)]);
    expired = expiredClaim.job;
    const coordinator = JSON.parse(await readFile(coordinatorPath, "utf8"));
    coordinator.claim.acquiredAt = "1999-12-31T23:58:00Z";
    coordinator.claim.heartbeatAt = "1999-12-31T23:59:00Z";
    coordinator.claim.expiresAt = "2000-01-01T00:00:00Z";
    await writeFile(coordinatorPath, JSON.stringify(coordinator));

    server = spawn(PYTHON, [join(REPO_ROOT, "scripts", "job-apply-workspace.py"), "--root", storeRoot, "--port", "0", "--no-open", "--json"], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const startup = await waitForStartup(server);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const payloads = [];
    page.on("response", async (response) => {
      if (new URL(response.url()).pathname !== "/api/attention" || !response.ok()) return;
      try { payloads.push(await response.json()); } catch { /* visible assertions cover failures */ }
    });
    await page.goto(startup.url);
    await page.getByText("Canonical store connected").waitFor();
    await page.locator("#attention-nav-count").getByText("4", { exact: true }).waitFor();
    await page.locator("#nav-attention").click();
    await page.locator("#attention-count").getByText("4 jobs", { exact: true }).waitFor();
    assert.deepEqual(await page.locator(".attention-reason").allTextContents(), [
      "Expired agent attempt", "Interrupted agent attempt", "Awaiting your review", "Needs information",
    ]);
    assert.match(await page.locator('[data-attention-id="needs-attention"]').innerText(), /1 missing information item/);
    const forbidden = [expiredClaim.token, reviewClaim.token, "private-expired-owner", "private-review-owner", "Private sponsorship answer?", "private.answer.key", "tokenHash", "claimId", "ownerLabel", "answerKey", "operationId", "browserState"];
    const attentionDom = await page.locator("#attention-workspace").innerText();
    for (const value of forbidden) assert.equal(attentionDom.includes(value), false, value);
    for (const payload of payloads) for (const value of forbidden) assert.equal(JSON.stringify(payload).includes(value), false, value);

    let releaseAbandonedDetail;
    let abandonedDetailSeenResolve;
    const abandonedDetailSeen = new Promise((resolveSeen) => { abandonedDetailSeenResolve = resolveSeen; });
    const releaseAbandonedDetailPromise = new Promise((resolveRelease) => { releaseAbandonedDetail = resolveRelease; });
    const abandonedDetailPattern = `**/api/jobs/${expired.id}`;
    const delayAbandonedDetail = async (route) => {
      if (route.request().method() !== "GET") { await route.continue(); return; }
      const response = await route.fetch();
      abandonedDetailSeenResolve();
      await releaseAbandonedDetailPromise;
      await route.fulfill({ response });
    };
    await page.route(abandonedDetailPattern, delayAbandonedDetail);
    await page.locator('[data-attention-id="expired-attention"]').click();
    await abandonedDetailSeen;
    await page.getByRole("button", { name: "Facts", exact: true }).click();
    await page.getByRole("heading", { name: "Your canonical application facts." }).waitFor();
    const abandonedDetailResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/jobs/${expired.id}` && response.ok());
    releaseAbandonedDetail();
    await abandonedDetailResponse;
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator("#job-dialog[open]").count(), 0);
    assert.match(await page.title(), /^Facts/);
    await page.unroute(abandonedDetailPattern, delayAbandonedDetail);
    await page.locator("#nav-attention").click();
    await page.locator("#attention-count").getByText("4 jobs", { exact: true }).waitFor();

    let releaseEarlierSelection;
    let earlierSelectionSeenResolve;
    const earlierSelectionSeen = new Promise((resolveSeen) => { earlierSelectionSeenResolve = resolveSeen; });
    const releaseEarlierSelectionPromise = new Promise((resolveRelease) => { releaseEarlierSelection = resolveRelease; });
    const expiredDetailPattern = `**/api/jobs/${expired.id}`;
    const delayExpiredDetail = async (route) => {
      if (route.request().method() !== "GET") { await route.continue(); return; }
      const response = await route.fetch();
      earlierSelectionSeenResolve();
      await releaseEarlierSelectionPromise;
      await route.fulfill({ response });
    };
    await page.route(expiredDetailPattern, delayExpiredDetail);
    await page.locator('[data-attention-id="expired-attention"]').click();
    await earlierSelectionSeen;
    await page.locator('[data-attention-id="review-attention"]').click();
    await page.locator("#job-dialog[open]").waitFor();
    assert.equal(await page.locator("#job-dialog").getByRole("heading", { name: "Review attention" }).count(), 1);
    const earlierSelectionResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/jobs/${expired.id}` && response.ok());
    releaseEarlierSelection();
    await earlierSelectionResponse;
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator("#job-dialog").getByRole("heading", { name: "Review attention" }).count(), 1);
    await page.getByRole("button", { name: "Close job details" }).click();
    await page.locator("#job-dialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.dataset?.attentionId === "review-attention");
    await page.unroute(expiredDetailPattern, delayExpiredDetail);

    await page.locator('[data-attention-id="review-attention"]').click();
    await page.locator("#job-dialog[open]").waitFor();
    let delayAttentionReturn = false;
    let attentionReturnSeenResolve;
    let releaseAttentionReturn;
    const attentionReturnSeen = new Promise((resolveSeen) => { attentionReturnSeenResolve = resolveSeen; });
    const releaseAttentionReturnPromise = new Promise((resolveRelease) => { releaseAttentionReturn = resolveRelease; });
    const delayNextAttention = async (route) => {
      if (!delayAttentionReturn || route.request().method() !== "GET") { await route.continue(); return; }
      delayAttentionReturn = false;
      const response = await route.fetch();
      attentionReturnSeenResolve();
      await releaseAttentionReturnPromise;
      await route.fulfill({ response });
    };
    await page.route("**/api/attention", delayNextAttention);
    delayAttentionReturn = true;
    await page.getByRole("button", { name: "Close job details" }).click();
    await page.locator("#job-dialog").waitFor({ state: "hidden" });
    await attentionReturnSeen;
    await page.getByRole("button", { name: "Facts", exact: true }).click();
    await page.getByRole("heading", { name: "Your canonical application facts." }).waitFor();
    const attentionReturnResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/attention" && response.ok());
    releaseAttentionReturn();
    await attentionReturnResponse;
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.match(await page.title(), /^Facts/);
    assert.equal(await page.locator("#facts-workspace.hidden").count(), 0);
    await page.unroute("**/api/attention", delayNextAttention);
    await page.getByRole("button", { name: /Needs Attention/ }).click();
    await page.locator("#attention-count").getByText("4 jobs", { exact: true }).waitFor();

    let releaseStaleDetail;
    let staleDetailSeenResolve;
    const staleDetailSeen = new Promise((resolveSeen) => { staleDetailSeenResolve = resolveSeen; });
    const releaseStaleDetailPromise = new Promise((resolveRelease) => { releaseStaleDetail = resolveRelease; });
    const needsDetailPattern = `**/api/jobs/${needs.id}`;
    const delayNeedsDetail = async (route) => {
      if (route.request().method() !== "GET") { await route.continue(); return; }
      const response = await route.fetch();
      staleDetailSeenResolve();
      await releaseStaleDetailPromise;
      await route.fulfill({ response });
    };
    await page.route(needsDetailPattern, delayNeedsDetail);
    await page.locator('[data-attention-id="needs-attention"]').click();
    await staleDetailSeen;
    needs = await cli("job-update", ["--id", needs.id, "--expected-revision", String(needs.revision), "--origin", "human"], { role: "Newest canonical attention role" });
    const newerStateResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/state" && response.ok());
    await page.locator("#refresh").evaluate((button) => button.click());
    await newerStateResponse;
    await page.waitForFunction(({ id, role }) => document.querySelector(`[data-id="${CSS.escape(id)}"]`)?.textContent?.includes(role), { id: needs.id, role: needs.role });
    releaseStaleDetail();
    await page.locator("#job-dialog[open]").waitFor();
    assert.equal(await page.locator("#job-dialog").getByLabel("Role", { exact: true }).inputValue(), needs.role);
    assert.match(await page.locator("#dialog-kicker").textContent(), new RegExp(`REVISION ${needs.revision}$`));
    await page.locator("#job-dialog").getByLabel("Notes", { exact: true }).fill("Saved from the newest routed revision");
    await page.getByRole("button", { name: "Save job" }).click();
    await page.locator("#job-dialog").waitFor({ state: "hidden" });
    needs = await cli("job-get", ["--id", needs.id]);
    assert.equal(needs.notes, "Saved from the newest routed revision");
    assert.equal(needs.role, "Newest canonical attention role");
    await page.waitForFunction(() => document.activeElement?.dataset?.attentionId === "needs-attention");
    await page.unroute(needsDetailPattern, delayNeedsDetail);

    const reviewCard = page.locator('[data-attention-id="review-attention"]');
    await reviewCard.focus();
    await page.keyboard.press("Enter");
    await page.locator("#job-dialog[open]").waitFor();
    assert.equal(await page.locator("#job-dialog").getByRole("heading", { name: "Review attention" }).count(), 1);
    await page.getByRole("button", { name: "Close job details" }).click();
    await page.locator("#job-dialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.dataset?.attentionId === "review-attention");

    await page.evaluate(() => {
      globalThis.__attentionAnnouncements = [];
      const live = document.querySelector("#attention-live");
      globalThis.__attentionObserver = new MutationObserver(() => globalThis.__attentionAnnouncements.push(live.textContent));
      globalThis.__attentionObserver.observe(live, { childList: true, characterData: true, subtree: true });
    });
    const failAttention = (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "attention_unavailable", message: "attention unavailable for test" } }) });
    await page.route("**/api/attention", failAttention);
    await page.locator("#attention-refresh").click();
    await page.locator("#attention-unavailable").waitFor();
    assert.equal(await page.locator(".attention-card").first().isDisabled(), true);
    await page.locator("#attention-refresh").click();
    assert.deepEqual(await page.evaluate(() => globalThis.__attentionAnnouncements), ["Needs Attention data is unavailable. Row actions are disabled."]);
    await page.unroute("**/api/attention", failAttention);
    await page.locator("#attention-refresh").click();
    await page.getByText("Needs Attention data is available again.").waitFor({ state: "attached" });
    assert.equal(await page.locator(".attention-card").first().isEnabled(), true);
    await page.locator("#attention-refresh").click();
    assert.deepEqual(await page.evaluate(() => globalThis.__attentionAnnouncements), [
      "Needs Attention data is unavailable. Row actions are disabled.",
      "Needs Attention data is available again.",
    ]);
    await page.evaluate(() => globalThis.__attentionObserver?.disconnect());

    const recovered = await cli("claim-recover", ["--id", expired.id, "--owner", "replacement-owner"]);
    await page.locator("#attention-refresh").click();
    await page.waitForFunction(() => document.querySelectorAll(".attention-card").length === 3);
    assert.equal(await page.locator('[data-attention-id="expired-attention"]').count(), 0);

    interrupted = await cli("job-transition", ["--id", interrupted.id, "--status", "needs_info", "--expected-revision", String(interrupted.revision)]);
    await page.locator("#attention-refresh").click();
    await page.locator('[data-attention-id="interrupted-attention"] .attention-reason').getByText("Needs information").waitFor();
    interrupted = await cli("job-transition", ["--id", interrupted.id, "--status", "saved", "--expected-revision", String(interrupted.revision)]);
    needs = await cli("job-transition", ["--id", needs.id, "--status", "saved", "--expected-revision", String(needs.revision)]);

    await page.locator('[data-attention-id="review-attention"]').click();
    page.once("dialog", (prompt) => prompt.accept());
    await page.getByRole("button", { name: "Mark applied…" }).click();
    await page.locator("#job-dialog").waitFor({ state: "hidden" });
    await page.locator("#attention-refresh").click();
    await page.getByRole("heading", { name: "Nothing needs your attention" }).waitFor();
    assert.equal((await cli("job-get", ["--id", review.id])).status, "applied");
    assert.equal((await cli("job-get", ["--id", expired.id])).status, "in_progress");
    assert.equal(recovered.job.id, expired.id);

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
  const context = await createBrowserCrudScenario();
  try {
    await runBrowserCrudFactsPhase(context);
    await runBrowserCrudResumesPhase(context);
    await runBrowserCrudJobsPhase(context);
    await runBrowserCrudAnswersPhase(context);
    await runBrowserCrudTrashShutdownPhase(context);
  } finally {
    await cleanupBrowserCrudScenario(context);
  }
});
