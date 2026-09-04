import {
  assert, join, minimalSyntheticPdf, writeFile,
} from "./workspace_test_support.mjs";

export async function runOwnerBetaOverviewAndPreflightPhase(context) {
  const { browser, cli, running, temporary } = context;
    const page = await browser.newPage();
    await page.addInitScript(() => {
      globalThis.__workspaceIntervals = [];
      globalThis.setInterval = (callback, delay) => {
        globalThis.__workspaceIntervals.push({ callback, delay });
        return globalThis.__workspaceIntervals.length;
      };
    });
    await page.goto(running.startup.url);
    await page.getByRole("heading", { name: "Import a resume" }).waitFor();
    assert.match(await page.locator("#overview-workspace").innerText(), /0 jobs.*0 ready.*0 need attention/);
    assert.equal(await page.getByRole("button", { name: "Copy Codex invocation" }).getAttribute("data-copy"), "$job-apply:job-apply");
    assert.equal(await page.getByRole("button", { name: "Copy Claude Code invocation" }).getAttribute("data-copy"), "/job-apply:job-apply");

    await page.getByRole("button", { name: "Automation" }).click();
    await page.getByRole("heading", { name: "Account controls that fail closed." }).waitFor();
    await page.getByLabel("Exact employer portal URL").fill("https://acme.wd5.myworkdayjobs.com/en-US/jobs/one");
    await page.getByLabel("Optional signup email override").fill("realm@example.com");
    await page.getByRole("button", { name: "Add resolved realm" }).click();
    const overrideForm = page.getByRole("form", { name: /Edit signup email override for Workday realm/ });
    await overrideForm.waitFor();
    await overrideForm.getByLabel("Signup email override").fill("replacement@example.com");
    await overrideForm.getByRole("button", { name: "Save override" }).click();
    await page.getByText(/discovered · revision 2 · email override configured/).waitFor();
    const account = (await cli("employer-account-list"))[0];
    await cli(
      "employer-account-update",
      ["--realm-ref", account.realmRef, "--expected-revision", String(account.revision)],
      { signupEmailOverride: null },
    );
    await overrideForm.getByLabel("Signup email override").fill("newer@example.com");
    await overrideForm.getByRole("button", { name: "Save override" }).click();
    const realmConflict = overrideForm.getByRole("alert");
    await realmConflict.waitFor();
    assert.equal(await realmConflict.evaluate((element) => element === document.activeElement), true);
    await page.getByRole("button", { name: "Overview" }).click();

    const bootPattern = "**/api/boot";
    await page.route(bootPattern, (route) => route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "boot_unavailable", message: "transient boot failure" } }),
    }));
    await page.reload();
    await page.getByText("Workspace startup failed: transient boot failure", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => globalThis.__workspaceIntervals.length), 0);
    await page.unroute(bootPattern);
    await page.locator("#overview-refresh").click();
    await page.getByRole("heading", { name: "Import a resume" }).waitFor();
    await page.waitForFunction(() => globalThis.__workspaceIntervals?.some(({ delay }) => delay === 4000));
    await page.locator("#overview-refresh").click();
    assert.equal(
      await page.evaluate(() => globalThis.__workspaceIntervals.filter(({ delay }) => delay === 4000).length),
      1,
    );

    const overviewPattern = "**/api/overview";
    await page.route(overviewPattern, (route) => route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "overview_unavailable", message: "unavailable for owner beta test" } }),
    }));
    await page.reload();
    await page.locator("#overview-unavailable").waitFor({ state: "visible" });
    assert.equal(await page.locator("#overview-ready").isVisible(), false);
    assert.equal(await page.locator("#connection-label").innerText(), "Overview unavailable — refresh to retry");
    await page.unroute(overviewPattern);
    await page.locator("#overview-refresh").click();
    await page.getByRole("heading", { name: "Import a resume" }).waitFor();
    assert.equal(await page.locator("#overview-unavailable").isVisible(), false);

    const pendingOverviewRoutes = [];
    let resolveFirstOverview;
    let resolveSecondOverview;
    const firstOverviewSeen = new Promise((resolve) => { resolveFirstOverview = resolve; });
    const secondOverviewSeen = new Promise((resolve) => { resolveSecondOverview = resolve; });
    await page.route(overviewPattern, (route) => {
      pendingOverviewRoutes.push(route);
      if (pendingOverviewRoutes.length === 1) resolveFirstOverview();
      if (pendingOverviewRoutes.length === 2) resolveSecondOverview();
    });
    await page.locator("#overview-refresh").click();
    await firstOverviewSeen;
    await page.locator("#overview-refresh").click();
    await secondOverviewSeen;
    const projection = (nextAction, targetWorkspace) => ({
      setup: { hasProfileFacts: false, hasResume: true },
      counts: { jobs: 0, readyJobs: 0, attentionJobs: 0, resumes: 1, answers: 0 },
      nextAction,
      targetWorkspace,
    });
    await pendingOverviewRoutes[1].fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify(projection("review_facts", "facts")),
    });
    await page.getByRole("heading", { name: "Review your application facts" }).waitFor();
    await pendingOverviewRoutes[0].fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify(projection("import_resume", "resumes")),
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator("#next-step-heading").innerText(), "Review your application facts");
    await page.unroute(overviewPattern);
    await page.locator("#overview-refresh").click();
    await page.getByRole("heading", { name: "Import a resume" }).waitFor();

    const resumePath = join(temporary, "owner-resume.pdf");
    await writeFile(resumePath, minimalSyntheticPdf());
    await cli("profile-replace", ["--expected-revision", "1", "--source", "user"], { firstName: "Owner" });
    let ownerResume = await cli("resume-create", [], { id: "owner-beta-resume", label: "Owner beta resume", path: resumePath });
    await page.locator("#overview-refresh").click();
    await page.getByRole("heading", { name: "Capture your first job" }).waitFor();

    let job = await cli("job-create", [], { id: "owner-beta-job", url: "https://example.invalid/jobs/owner", role: "Owner Beta Engineer" });
    job = await cli("job-transition", ["--id", job.id, "--status", "ready", "--expected-revision", String(job.revision)]);
    await page.locator("#overview-refresh").click();
    await page.getByRole("heading", { name: "Hand off a ready job" }).waitFor();
    await page.locator("#nav-jobs").click();
    await page.locator("#refresh").click();
    await page.getByRole("button", { name: /Owner Beta Engineer/ }).click();
    const readyHandoff = page.locator("#ready-handoff");
    const jobDialog = page.locator("#job-dialog");
    const preflightPattern = `**/api/jobs/${job.id}/preflight`;
    await readyHandoff.waitFor({ state: "visible" });

    await page.route(preflightPattern, (route) => route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "preflight_unavailable", message: "latest preflight unavailable" } }),
    }));
    await jobDialog.getByRole("button", { name: "Run ready check" }).click();
    await jobDialog.getByText("latest preflight unavailable", { exact: true }).waitFor();
    assert.equal(await readyHandoff.isVisible(), false);
    assert.equal(await page.locator("#preflight-panel").isVisible(), false);
    await page.unroute(preflightPattern);
    await jobDialog.getByRole("button", { name: "Run ready check" }).click();
    await readyHandoff.waitFor({ state: "visible" });
    assert.equal(await page.locator("#form-error").isVisible(), false);
  Object.assign(context, { page, resumePath, ownerResume, job, readyHandoff, jobDialog, preflightPattern });
}

export async function runOwnerBetaPollingRecoveryPhase(context) {
  const { cli, jobDialog, page, preflightPattern, readyHandoff } = context;
  let { job } = context;
    await jobDialog.getByLabel("Notes", { exact: true }).fill("Unsaved note survives a failed refresh");
    const epochStatePattern = "**/api/state";
    let guardedPreflightRequests = 0;
    let holdRecoveryPreflight = false;
    let recoveryPreflightSeenResolve;
    let releaseRecoveryPreflightResolve;
    const recoveryPreflightSeen = new Promise((resolve) => { recoveryPreflightSeenResolve = resolve; });
    const releaseRecoveryPreflight = new Promise((resolve) => { releaseRecoveryPreflightResolve = resolve; });
    await page.route(preflightPattern, async (route) => {
      guardedPreflightRequests += 1;
      if (holdRecoveryPreflight) {
        recoveryPreflightSeenResolve();
        await releaseRecoveryPreflight;
      }
      await route.continue();
    });
    const heldFailedStateRoutes = [];
    let failedStateSeenResolve;
    let secondFailedStateSeenResolve;
    const failedStateSeen = new Promise((resolve) => { failedStateSeenResolve = resolve; });
    const secondFailedStateSeen = new Promise((resolve) => { secondFailedStateSeenResolve = resolve; });
    await page.route(epochStatePattern, (route) => {
      heldFailedStateRoutes.push(route);
      failedStateSeenResolve();
      if (heldFailedStateRoutes.length === 2) secondFailedStateSeenResolve();
    });
    const failedStateResponse = page.waitForResponse((response) => (
      new URL(response.url()).pathname === "/api/state" && response.status() === 503
    ));
    await page.evaluate(() => {
      document.querySelector("#refresh").click();
      document.querySelector("#refresh").click();
    });
    assert.equal(await readyHandoff.isVisible(), false);
    assert.equal(await page.locator("#preflight-panel").isVisible(), false);
    assert.equal(await page.locator("#mark-ready").isVisible(), false);
    assert.equal(await jobDialog.getByLabel("Notes", { exact: true }).inputValue(), "Unsaved note survives a failed refresh");
    await failedStateSeen;
    assert.equal(heldFailedStateRoutes.length, 1);
    await jobDialog.getByRole("button", { name: "Run ready check" }).click();
    assert.equal(guardedPreflightRequests, 0);
    await heldFailedStateRoutes[0].fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "state_unavailable", message: "canonical refresh unavailable" } }),
    });
    await failedStateResponse;
    await jobDialog.getByText("canonical refresh unavailable", { exact: true }).waitFor();
    assert.equal(await readyHandoff.isVisible(), false);
    assert.equal(await page.locator("#preflight-panel").isVisible(), false);
    assert.equal(await jobDialog.getByLabel("Notes", { exact: true }).inputValue(), "Unsaved note survives a failed refresh");
    await jobDialog.getByRole("button", { name: "Run ready check" }).click();
    assert.equal(guardedPreflightRequests, 0);

    const failedPollResponse = page.waitForResponse((response) => (
      new URL(response.url()).pathname === "/api/state" && response.status() === 503
    ));
    const failedPoll = page.evaluate(() => {
      const interval = globalThis.__workspaceIntervals.find(({ delay }) => delay === 4000);
      return interval.callback();
    });
    await secondFailedStateSeen;
    assert.equal(guardedPreflightRequests, 0);
    await heldFailedStateRoutes[1].fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "state_unavailable", message: "canonical polling refresh unavailable" } }),
    });
    await failedPollResponse;
    await failedPoll;
    assert.equal(guardedPreflightRequests, 0);
    assert.equal(await readyHandoff.isVisible(), false);
    assert.equal(await page.locator("#preflight-panel").isVisible(), false);

    await page.unroute(epochStatePattern);
    const recoveryStateResponse = page.waitForResponse((response) => (
      new URL(response.url()).pathname === "/api/state" && response.ok()
    ));
    holdRecoveryPreflight = true;
    const recoveryPoll = page.evaluate(() => {
      const interval = globalThis.__workspaceIntervals.find(({ delay }) => delay === 4000);
      return interval.callback();
    });
    await recoveryStateResponse;
    await recoveryPreflightSeen;
    assert.equal(await readyHandoff.isVisible(), false);
    assert.equal(await page.locator("#preflight-panel").isVisible(), false);
    assert.equal(guardedPreflightRequests, 1);
    releaseRecoveryPreflightResolve();
    await recoveryPoll;
    await readyHandoff.waitFor({ state: "visible" });
    assert.equal(guardedPreflightRequests, 1);
    assert.equal(await jobDialog.getByLabel("Notes", { exact: true }).inputValue(), "Unsaved note survives a failed refresh");
    await page.unroute(preflightPattern);
    await page.getByRole("button", { name: "Close job details" }).click();
    await jobDialog.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: /Owner Beta Engineer/ }).click();
    await readyHandoff.waitFor({ state: "visible" });

    for (const staleOutcome of ["success", "error"]) {
      let stalePreflightSeenResolve;
      let releaseStalePreflightResolve;
      const stalePreflightSeen = new Promise((resolve) => { stalePreflightSeenResolve = resolve; });
      const releaseStalePreflight = new Promise((resolve) => { releaseStalePreflightResolve = resolve; });
      await page.route(preflightPattern, async (route) => {
        stalePreflightSeenResolve();
        await releaseStalePreflight;
        if (staleOutcome === "success") await route.continue();
        else await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "stale_preflight", message: "stale preflight error" } }),
        });
      });
      await jobDialog.getByRole("button", { name: "Run ready check" }).click();
      await stalePreflightSeen;

      let heldStateRoute;
      let heldStateSeenResolve;
      const heldStateSeen = new Promise((resolve) => { heldStateSeenResolve = resolve; });
      await page.route(epochStatePattern, (route) => {
        heldStateRoute = route;
        heldStateSeenResolve();
      });
      const heldStateResponse = page.waitForResponse((response) => (
        new URL(response.url()).pathname === "/api/state" && response.ok()
      ));
      await page.evaluate(() => { document.querySelector("#toast").textContent = ""; });
      await page.locator("#refresh").evaluate((button) => button.click());
      await heldStateSeen;
      const stalePreflightResponse = page.waitForResponse((response) => (
        new URL(response.url()).pathname === `/api/jobs/${job.id}/preflight`
      ));
      releaseStalePreflightResolve();
      await stalePreflightResponse;
      assert.equal(await page.locator("#preflight-panel").isVisible(), false);
      assert.equal(await readyHandoff.isVisible(), false);
      assert.equal(await page.locator("#mark-ready").isVisible(), false);
      assert.equal(await jobDialog.getByText("stale preflight error", { exact: true }).isVisible(), false);
      await heldStateRoute.continue();
      await heldStateResponse;
      await page.getByText("Jobs refreshed from the canonical store", { exact: true }).waitFor();
      await page.unroute(epochStatePattern);
      await page.unroute(preflightPattern);
      await jobDialog.getByRole("button", { name: "Run ready check" }).click();
      await readyHandoff.waitFor({ state: "visible" });
    }

    await page.route("**/api/jobs/**", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.pathname === `/api/jobs/${job.id}` && route.request().method() === "PATCH") {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "save_unavailable", message: "unrelated save unavailable" } }),
        });
        return;
      }
      await route.continue();
    });
    await jobDialog.getByLabel("Notes", { exact: true }).fill("Unsaved note survives preflight success");
    await jobDialog.getByRole("button", { name: "Save job" }).click();
    await jobDialog.getByText("unrelated save unavailable", { exact: true }).waitFor();
    await jobDialog.getByRole("button", { name: "Run ready check" }).click();
    await readyHandoff.waitFor({ state: "visible" });
    assert.equal(await page.locator("#form-error").innerText(), "unrelated save unavailable");
    assert.equal(await page.locator("#form-error").isVisible(), true);
    await page.unroute("**/api/jobs/**");

    await page.waitForFunction(() => globalThis.__workspaceIntervals?.some(({ delay }) => delay === 4000));
    const runWorkspacePoll = () => page.evaluate(() => {
      const interval = globalThis.__workspaceIntervals.find(({ delay }) => delay === 4000);
      interval.callback();
    });
    let releaseOlderReadyPreflight;
    let olderReadyPreflightSeenResolve;
    const olderReadyPreflightSeen = new Promise((resolve) => { olderReadyPreflightSeenResolve = resolve; });
    const olderReadyPreflightRelease = new Promise((resolve) => { releaseOlderReadyPreflight = resolve; });
    await page.route(preflightPattern, async (route) => {
      const response = await route.fetch();
      olderReadyPreflightSeenResolve();
      await olderReadyPreflightRelease;
      await route.fulfill({ response });
    });
    await runWorkspacePoll();
    await olderReadyPreflightSeen;
    assert.equal(await readyHandoff.isVisible(), false);

    await jobDialog.getByLabel("Role", { exact: true }).fill("Preserved external-trash draft");
    job = await cli("job-trash", ["--id", job.id, "--expected-revision", String(job.revision)]);
    const statePattern = "**/api/state";
    let releaseAbsentState;
    const absentStateRelease = new Promise((resolve) => { releaseAbsentState = resolve; });
    await page.route(statePattern, async (route) => {
      const response = await route.fetch();
      await absentStateRelease;
      await route.fulfill({ response });
    });
    const missingActivityResponse = page.waitForResponse((response) => (
      new URL(response.url()).pathname === `/api/jobs/${job.id}/activity`
    ));
    await runWorkspacePoll();
    assert.equal((await missingActivityResponse).status(), 404);
    await jobDialog.getByText(/Durable activity could not be refreshed/).waitFor();
    assert.equal(await jobDialog.isVisible(), true);
    assert.equal(await readyHandoff.isVisible(), false);
    assert.equal(await jobDialog.getByLabel("Role", { exact: true }).inputValue(), "Preserved external-trash draft");
    const absentStateResponse = page.waitForResponse((response) => (
      new URL(response.url()).pathname === "/api/state" && response.ok()
    ));
    const absentPreflightResponse = page.waitForResponse((response) => (
      new URL(response.url()).pathname === `/api/jobs/${job.id}/preflight`
    ));
    releaseAbsentState();
    releaseOlderReadyPreflight();
    await Promise.all([absentStateResponse, absentPreflightResponse]);
    await page.unroute(statePattern);
    await page.unroute(preflightPattern);
    assert.equal(await readyHandoff.isVisible(), false);

    job = await cli("job-restore", ["--id", job.id, "--expected-revision", String(job.revision)]);
    const restoredStateResponse = page.waitForResponse((response) => (
      new URL(response.url()).pathname === "/api/state" && response.ok()
    ));
    await page.evaluate(() => document.querySelector("#refresh").click());
    await restoredStateResponse;
    assert.equal(await readyHandoff.isVisible(), false);
    assert.equal(await jobDialog.getByLabel("Role", { exact: true }).inputValue(), "Preserved external-trash draft");
    await page.getByRole("button", { name: "Close job details" }).click();
    await jobDialog.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: /Owner Beta Engineer/ }).click();
    await readyHandoff.waitFor({ state: "visible" });
  Object.assign(context, { job, runWorkspacePoll });
}
