import {
  assert, join, writeFile,
} from "./workspace_test_support.mjs";

export async function runOwnerBetaFreshnessRestartPhase(context) {
  const { cli, jobDialog, launch, page, preflightPattern, readyHandoff, resumePath, runWorkspacePoll, stop, storeRoot } = context;
  let { job, ownerResume, running } = context;
    await writeFile(join(storeRoot, "resume-files", ownerResume.managedFile), "polling dependency changed");
    const dependencyPreflightResponse = page.waitForResponse((response) => (
      new URL(response.url()).pathname === `/api/jobs/${job.id}/preflight`
    ));
    await runWorkspacePoll();
    await dependencyPreflightResponse;
    await jobDialog.getByText("The resume file changed since it was added", { exact: true }).waitFor();
    assert.equal(await readyHandoff.isVisible(), false);
    ownerResume = await cli(
      "resume-update",
      ["--id", ownerResume.id, "--expected-revision", String(ownerResume.revision)],
      { path: resumePath },
    );
    const repairedDependencyPreflightResponse = page.waitForResponse((response) => (
      new URL(response.url()).pathname === `/api/jobs/${job.id}/preflight`
    ));
    await runWorkspacePoll();
    await repairedDependencyPreflightResponse;
    await readyHandoff.waitFor({ state: "visible" });

    let releaseDependencyStalePreflight;
    let dependencyStalePreflightSeenResolve;
    const dependencyStalePreflightSeen = new Promise((resolve) => { dependencyStalePreflightSeenResolve = resolve; });
    const dependencyStalePreflightRelease = new Promise((resolve) => { releaseDependencyStalePreflight = resolve; });
    await page.route(preflightPattern, async (route) => {
      const response = await route.fetch();
      dependencyStalePreflightSeenResolve();
      await dependencyStalePreflightRelease;
      await route.fulfill({ response });
    });
    await jobDialog.getByRole("button", { name: "Run ready check" }).click();
    await dependencyStalePreflightSeen;
    await writeFile(join(storeRoot, "resume-files", ownerResume.managedFile), "newer dependency failure");
    const newerDependencyState = page.waitForResponse((response) => (
      new URL(response.url()).pathname === "/api/state" && response.ok()
    ));
    await page.locator("#refresh").evaluate((button) => button.click());
    await newerDependencyState;
    const dependencyStalePreflightResponse = page.waitForResponse((response) => (
      new URL(response.url()).pathname === `/api/jobs/${job.id}/preflight`
    ));
    releaseDependencyStalePreflight();
    await dependencyStalePreflightResponse;
    assert.equal(await readyHandoff.isVisible(), false);
    assert.equal(await page.locator("#preflight-panel").isVisible(), false);
    await page.unroute(preflightPattern);
    await jobDialog.getByRole("button", { name: "Run ready check" }).click();
    await jobDialog.getByText("The resume file changed since it was added", { exact: true }).waitFor();
    assert.equal(await readyHandoff.isVisible(), false);
    ownerResume = await cli(
      "resume-update",
      ["--id", ownerResume.id, "--expected-revision", String(ownerResume.revision)],
      { path: resumePath },
    );
    await jobDialog.getByRole("button", { name: "Run ready check" }).click();
    await readyHandoff.waitFor({ state: "visible" });

    let releaseOlderCanonicalPreflight;
    let olderCanonicalPreflightSeenResolve;
    const olderCanonicalPreflightSeen = new Promise((resolve) => { olderCanonicalPreflightSeenResolve = resolve; });
    const olderCanonicalPreflightRelease = new Promise((resolve) => { releaseOlderCanonicalPreflight = resolve; });
    await page.route(preflightPattern, async (route) => {
      const response = await route.fetch();
      olderCanonicalPreflightSeenResolve();
      await olderCanonicalPreflightRelease;
      await route.fulfill({ response });
    });
    await jobDialog.getByRole("button", { name: "Run ready check" }).click();
    await olderCanonicalPreflightSeen;
    job = await cli(
      "job-update",
      ["--id", job.id, "--expected-revision", String(job.revision), "--origin", "human"],
      { notes: "newer canonical freshness note" },
    );
    const newerStateResponse = page.waitForResponse((response) => (
      new URL(response.url()).pathname === "/api/state" && response.ok()
    ));
    await page.evaluate(() => document.querySelector("#refresh").click());
    await newerStateResponse;
    await jobDialog.getByLabel("Role", { exact: true }).fill("Stale preflight draft");
    await jobDialog.getByRole("button", { name: "Save job" }).click();
    await page.locator("#conflict").waitFor({ state: "visible" });
    const olderCanonicalPreflightResponse = page.waitForResponse((response) => (
      new URL(response.url()).pathname === `/api/jobs/${job.id}/preflight`
    ));
    releaseOlderCanonicalPreflight();
    await olderCanonicalPreflightResponse;
    assert.equal(await readyHandoff.isVisible(), false);
    await page.getByRole("button", { name: "Load canonical values" }).click();
    await page.unroute(preflightPattern);
    await jobDialog.getByRole("button", { name: "Run ready check" }).click();
    await readyHandoff.waitFor({ state: "visible" });

    let releaseNewerCanonicalPreflight;
    let newerCanonicalPreflightSeenResolve;
    const newerCanonicalPreflightSeen = new Promise((resolve) => { newerCanonicalPreflightSeenResolve = resolve; });
    const newerCanonicalPreflightRelease = new Promise((resolve) => { releaseNewerCanonicalPreflight = resolve; });
    await page.route(preflightPattern, async (route) => {
      newerCanonicalPreflightSeenResolve();
      await newerCanonicalPreflightRelease;
      await route.continue();
    });
    await jobDialog.getByLabel("Role", { exact: true }).fill("Draft retained across newer preflight");
    await jobDialog.getByRole("button", { name: "Run ready check" }).click();
    await newerCanonicalPreflightSeen;
    job = await cli(
      "job-update",
      ["--id", job.id, "--expected-revision", String(job.revision), "--origin", "human"],
      { notes: "preflight proves browser revision stale" },
    );
    const newerCanonicalPreflightResponse = page.waitForResponse((response) => (
      new URL(response.url()).pathname === `/api/jobs/${job.id}/preflight`
    ));
    releaseNewerCanonicalPreflight();
    await newerCanonicalPreflightResponse;
    assert.equal(await readyHandoff.isVisible(), false);
    assert.equal(await jobDialog.getByLabel("Role", { exact: true }).inputValue(), "Draft retained across newer preflight");
    await page.unroute(preflightPattern);
    const changedResumeStateResponse = page.waitForResponse((response) => (
      new URL(response.url()).pathname === "/api/state" && response.ok()
    ));
    await page.evaluate(() => document.querySelector("#refresh").click());
    await changedResumeStateResponse;

    await page.getByRole("button", { name: "Close job details" }).click();
    await jobDialog.waitFor({ state: "hidden" });

    await writeFile(join(storeRoot, "resume-files", ownerResume.managedFile), "tampered owner resume");
    await page.getByRole("button", { name: /Owner Beta Engineer/ }).click();
    await jobDialog.getByText("The resume file changed since it was added", { exact: true }).waitFor();
    assert.equal(await readyHandoff.isVisible(), false);
    await page.getByRole("button", { name: "Close job details" }).click();
    await jobDialog.waitFor({ state: "hidden" });
    ownerResume = await cli(
      "resume-update",
      ["--id", ownerResume.id, "--expected-revision", String(ownerResume.revision)],
      { path: resumePath },
    );

    let releaseStalePreflight;
    let stalePreflightSeenResolve;
    const stalePreflightSeen = new Promise((resolve) => { stalePreflightSeenResolve = resolve; });
    const stalePreflightRelease = new Promise((resolve) => { releaseStalePreflight = resolve; });
    await page.route(preflightPattern, async (route) => {
      stalePreflightSeenResolve();
      await stalePreflightRelease;
      await route.continue();
    });
    await page.getByRole("button", { name: /Owner Beta Engineer/ }).click();
    await stalePreflightSeen;
    await page.getByRole("button", { name: "Close job details" }).click();
    await jobDialog.waitFor({ state: "hidden" });
    await page.locator("#new-job").click();
    await jobDialog.waitFor({ state: "visible" });
    const stalePreflightResponse = page.waitForResponse((response) => (
      new URL(response.url()).pathname === `/api/jobs/${job.id}/preflight`
    ));
    releaseStalePreflight();
    await stalePreflightResponse;
    assert.equal(await readyHandoff.isVisible(), false);
    await page.getByRole("button", { name: "Close job details" }).click();
    await jobDialog.waitFor({ state: "hidden" });
    await page.unroute(preflightPattern);

    await page.getByRole("button", { name: /Owner Beta Engineer/ }).click();
    await readyHandoff.waitFor({ state: "visible" });
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("clipboard denied")) },
    }));
    await readyHandoff.getByRole("button", { name: "Copy Codex invocation" }).click();
    const readyFallback = readyHandoff.locator(".clipboard-fallback");
    await readyFallback.waitFor({ state: "visible" });
    const readyFallbackValue = readyFallback.getByLabel("Invocation to copy");
    assert.equal(await readyFallbackValue.inputValue(), "$job-apply:job-apply");
    assert.equal(await readyFallbackValue.evaluate((input) => document.activeElement === input), true);
    assert.deepEqual(await readyFallbackValue.evaluate((input) => [input.selectionStart, input.selectionEnd]), [0, "$job-apply:job-apply".length]);

    const codexCopy = readyHandoff.getByRole("button", { name: "Copy Codex invocation" });
    const claudeCopy = readyHandoff.getByRole("button", { name: "Copy Claude Code invocation" });
    await page.evaluate(() => {
      globalThis.ownerBetaClipboardAttempts = [];
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: (text) => new Promise((resolve, reject) => {
          globalThis.ownerBetaClipboardAttempts.push({ text, resolve, reject });
        }) },
      });
    });
    await codexCopy.click();
    await claudeCopy.click();
    await page.waitForFunction(() => globalThis.ownerBetaClipboardAttempts.length === 2);
    await page.evaluate(() => globalThis.ownerBetaClipboardAttempts[1].reject(new Error("latest denied")));
    await readyFallback.waitFor({ state: "visible" });
    assert.equal(await readyFallbackValue.inputValue(), "/job-apply:job-apply");
    await page.evaluate(() => globalThis.ownerBetaClipboardAttempts[0].resolve());
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await readyFallback.isVisible(), true);
    assert.equal(await readyFallbackValue.inputValue(), "/job-apply:job-apply");

    await codexCopy.click();
    await claudeCopy.click();
    await page.waitForFunction(() => globalThis.ownerBetaClipboardAttempts.length === 4);
    await page.evaluate(() => globalThis.ownerBetaClipboardAttempts[3].resolve());
    await readyFallback.waitFor({ state: "hidden" });
    await page.getByText("Claude Code invocation copied", { exact: true }).waitFor();
    await page.evaluate(() => globalThis.ownerBetaClipboardAttempts[2].reject(new Error("older denied")));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await readyFallback.isVisible(), false);
    assert.equal(await page.locator("#toast").innerText(), "Claude Code invocation copied");

    await page.getByRole("button", { name: "Close job details" }).click();
    await jobDialog.waitFor({ state: "hidden" });
    await page.locator("#new-job").click();
    await jobDialog.waitFor({ state: "visible" });
    assert.equal(await readyHandoff.isVisible(), false);
    await page.getByRole("button", { name: "Close job details" }).click();
    await jobDialog.waitFor({ state: "hidden" });
    await page.locator("#nav-overview").click();
    const claim = await cli("job-acquire", ["--id", job.id, "--owner", "owner-beta-agent", "--expected-revision", String(job.revision)]);
    job = (await cli("claim-handoff", ["--id", job.id, "--token", claim.token, "--status", "needs_info", "--expected-revision", String(claim.job.revision)], {
      status: "active", step: "questions", answerKeys: [], pendingFields: [{ question: "Work authorization?", state: "missing", sensitive: true }],
    })).job;
    await page.locator("#overview-refresh").click();
    await page.getByRole("heading", { name: "Resolve Needs Attention" }).waitFor();

    await stop(running.child); running = null;
    context.running = running;
    running = await launch();
    context.running = running;
    await page.goto(running.startup.url);
    await page.getByRole("heading", { name: "Resolve Needs Attention" }).waitFor();
    await page.locator("#nav-attention").click();
    await page.getByText("Needs information", { exact: true }).waitFor();
    job = await cli("job-transition", ["--id", job.id, "--status", "saved", "--expected-revision", String(job.revision)]);
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.locator("#overview-refresh").click();
    await page.getByRole("heading", { name: "Prepare the next job" }).waitFor();

    await stop(running.child); running = null;
    context.running = running;
    const privateCorruption = "owner-private-corrupt-value-and-path";
    await writeFile(join(storeRoot, "jobs.json"), privateCorruption);
    running = await launch();
    context.running = running;
    await page.goto(running.startup.url);
    await page.getByRole("heading", { name: /workspace is read-only/ }).waitFor();
    const recovery = await page.locator("#boot-recovery").innerText();
    assert.match(recovery, /No canonical values or filesystem paths were exposed to this browser/);
    assert.match(recovery, /Nothing was automatically repaired, downgraded, or overwritten/);
    assert.equal(recovery.includes(privateCorruption), false);
    assert.equal(await page.getByRole("button", { name: "Jobs", exact: true }).isDisabled(), true);
  Object.assign(context, { job, ownerResume, running });
}
