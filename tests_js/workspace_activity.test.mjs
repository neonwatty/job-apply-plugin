import {
  assert,
  mkdtemp,
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
  activityAnnouncement,
  activitySignature,
  shouldUseActivityResponse,
} from "./workspace_test_support.mjs";

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


test("activity responses never regress a newer canonical Job detail revision", () => {
  const selected = { id: "job-one", status: "awaiting_review", revision: 8 };
  assert.equal(shouldUseActivityResponse({ job: { id: "job-one", status: "in_progress", revision: 7 } }, selected), false);
  assert.equal(shouldUseActivityResponse({ job: { id: "job-one", status: "awaiting_review", revision: 8 } }, selected), true);
  assert.equal(shouldUseActivityResponse({ job: { id: "job-one", status: "applied", revision: 9 } }, selected), true);
  const listed = { id: "job-one", status: "applied", revision: 10 };
  assert.equal(shouldUseActivityResponse({ job: { id: "job-one", status: "applied", revision: 9 } }, selected, listed), false);
  assert.equal(shouldUseActivityResponse({ job: { id: "job-one", status: "applied", revision: 10 } }, selected, listed), true);
  assert.equal(shouldUseActivityResponse(null, selected, listed), false);
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
    await page.getByRole("button", { name: "Jobs", exact: true }).click();

    const pollingCard = page.getByRole("button", { name: /Polling Engineer/ });
    const activityPattern = `**/api/jobs/${pollingJob.id}/activity`;
    let releaseInitialEqualActivity;
    let initialEqualActivitySeenResolve;
    const initialEqualActivitySeen = new Promise((resolve) => { initialEqualActivitySeenResolve = resolve; });
    const initialEqualActivityRelease = new Promise((resolve) => { releaseInitialEqualActivity = resolve; });
    await page.route(activityPattern, async (route) => {
      const response = await route.fetch();
      initialEqualActivitySeenResolve();
      await initialEqualActivityRelease;
      await route.fulfill({ response });
    });
    await pollingCard.focus();
    await page.keyboard.press("Enter");
    const jobDialog = page.locator("#job-dialog");
    const activityPanel = jobDialog.getByRole("region", { name: "Application activity" });
    const readyHandoff = jobDialog.locator("#ready-handoff");
    await initialEqualActivitySeen;
    await readyHandoff.waitFor({ state: "visible" });
    releaseInitialEqualActivity();
    await activityPanel.getByText(/Canonical status ready/).waitFor();
    assert.equal(await readyHandoff.isVisible(), true);
    await page.unroute(activityPattern);
    await page.waitForTimeout(4_500);
    assert.equal(await readyHandoff.isVisible(), true);

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
    await activityPanel.getByText("Information requested · missing · sensitive").waitFor();
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
