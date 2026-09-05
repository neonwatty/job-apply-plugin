import {
  assert, join, liveReviewSession, readFile, writeFile,
} from "./workspace_test_support.mjs";

export async function runBrowserCrudJobsPhase(context) {
  const { cli, cliJob, jobDialog, page, reassignedCliJob, storeRoot } = context;
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
    await activityPanel.getByText("Information requested · missing · sensitive").waitFor();
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
    assert.equal(await activityPanel.getByRole("button", { name: "Open in Answers" }).count(), 1);
    assert.equal(await activityPanel.getByRole("button", { name: "Recheck this revision" }).count(), 0);
    await page.getByRole("button", { name: "Mark ready" }).click();
    await page.locator("#job-dialog").waitFor({ state: "hidden" });

    activityJob = await cli("job-get", ["--id", uiJob.id]);
    claim = await cli("job-acquire", ["--id", uiJob.id, "--owner", "private-recovery-owner", "--expected-revision", String(activityJob.revision)]);
    const coordinatorPath = join(storeRoot, "coordinator.json");
    const coordinator = JSON.parse(await readFile(coordinatorPath, "utf8"));
    coordinator.claim.acquiredAt = "1999-12-31T23:58:00Z";
    coordinator.claim.heartbeatAt = "1999-12-31T23:59:00Z";
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
    await cli("claim-handoff", ["--id", uiJob.id, "--token", recovered.token, "--status", "awaiting_review", "--expected-revision", String(activityJob.revision)], await liveReviewSession(activityJob.revision));
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
  Object.assign(context, { uiJob, cliUpdated, newest });
}
