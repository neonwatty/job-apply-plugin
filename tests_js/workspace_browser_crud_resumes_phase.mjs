import { assert } from "./workspace_test_support.mjs";

export async function runBrowserCrudResumesPhase(context) {
  const { cli, cliJob, jobDialog, page, pageErrors } = context;
  let { profile } = context;
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
    await uploadCard.getByRole("button", { name: "Request fact extraction" }).click();
    await uploadCard.getByText("Waiting for a Job Apply agent").waitFor();
    assert.doesNotMatch(await uploadCard.innerText(), /Extracting/i);
    let extractionRequests = await cli("resume-extraction-request-list", ["--resume-id", uploaded.id]);
    assert.equal(extractionRequests.length, 1);
    await uploadCard.getByRole("button", { name: "Copy agent handoff" }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `Use the Job Apply resume workflow to process extraction request ${extractionRequests[0].requestId}.`);
    assert.equal((await page.evaluate(() => navigator.clipboard.readText())).includes("Browser upload"), false);
    await uploadCard.getByRole("button", { name: "Cancel request" }).click();
    await uploadCard.getByRole("button", { name: "Request fact extraction" }).waitFor();
    assert.equal((await cli("resume-extraction-request-get", ["--id", extractionRequests[0].requestId])).status, "cancelled");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1100));
    let failedRequest = await cli("resume-extraction-request-create", ["--resume-id", uploaded.id, "--expected-resume-revision", String(uploaded.revision)]);
    failedRequest = await cli("resume-extraction-request-fail", ["--id", failedRequest.requestId, "--reason", "interrupted", "--expected-revision", String(failedRequest.revision)]);
    await page.locator("#resumes-refresh").click();
    await uploadCard.getByRole("button", { name: "Try again" }).click();
    await uploadCard.getByText("Waiting for a Job Apply agent").waitFor();
    extractionRequests = await cli("resume-extraction-request-list", ["--resume-id", uploaded.id]);
    const retriedRequest = extractionRequests.find((item) => item.supersedesRequestId === failedRequest.requestId);
    assert.equal(retriedRequest.status, "requested");
    await uploadCard.getByRole("button", { name: "Cancel request" }).click();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1100));
    let staleProfile = await cli("profile-inspect");
    staleProfile = await cli("profile-patch", ["--expected-revision", String(staleProfile.revision), "--source", "user"], { email: staleProfile.profile.email });
    const staleRequest = await cli("resume-extraction-request-create", ["--resume-id", uploaded.id, "--expected-resume-revision", String(uploaded.revision)]);
    const staleCompletion = await cli("resume-extraction-request-complete", ["--id", staleRequest.requestId, "--expected-request-revision", String(staleRequest.revision), "--expected-profile-revision", String(staleProfile.revision)], { email: "new-stale@example.invalid" });
    assert.equal(staleCompletion.request.status, "completed");
    await page.locator("#resumes-refresh").click();
    await uploadCard.getByRole("button", { name: "Manage" }).click();
    const resumeDialog = page.locator("#resume-dialog");
    await resumeDialog.getByLabel("Replacement file").setInputFiles({ name: "stale-replacement.txt", mimeType: "text/plain", buffer: Buffer.from("replacement makes proposal stale") });
    await resumeDialog.getByRole("button", { name: "Replace file" }).click();
    await resumeDialog.waitFor({ state: "hidden" });
    await uploadCard.getByText("Extraction review is no longer current").waitFor();
    await uploadCard.getByRole("button", { name: "Manage" }).click();
    await resumeDialog.getByRole("button", { name: "Review", exact: true }).click();
    const staleProposalDialog = page.locator("#proposal-dialog");
    await staleProposalDialog.waitFor({ state: "visible" });
    const staleCopy = await staleProposalDialog.locator("#proposal-error").innerText();
    assert.match(staleCopy, /no longer current/);
    assert.doesNotMatch(staleCopy, /resume changed/i);
    await staleProposalDialog.getByRole("button", { name: "Request fresh extraction" }).click();
    await staleProposalDialog.waitFor({ state: "hidden" });
    await resumeDialog.getByText("Waiting for a Job Apply agent").waitFor();
    const freshRequests = await cli("resume-extraction-request-list", ["--resume-id", uploaded.id, "--status", "requested"]);
    assert.equal(freshRequests.length, 1);
    assert.notEqual(freshRequests[0].requestId, staleRequest.requestId);
    await resumeDialog.getByRole("button", { name: "Cancel request" }).click();
    await resumeDialog.getByText("Facts not extracted").waitFor();
    await resumeDialog.getByRole("button", { name: "Close resume details" }).click();
    const manageUpload = uploadCard.getByRole("button", { name: "Manage" });
    const manageLifecycleUpload = () => page.locator(".resume-card").filter({ hasText: "Preserved browser draft" }).getByRole("button", { name: "Manage" });
    await manageUpload.click();
    await resumeDialog.getByLabel("Label").fill("Preserved browser draft");
    await resumeDialog.getByLabel("Replacement file").setInputFiles({ name: "replacement.txt", mimeType: "text/plain", buffer: Buffer.from("replacement draft") });
    const uploadBeforeConflict = await cli("resume-get", ["--id", uploaded.id]);
    const canonicalBeforeRefresh = await cli("resume-update", ["--id", uploaded.id, "--expected-revision", String(uploadBeforeConflict.revision)], { tags: ["cli"] });
    await page.locator("#resumes-refresh").evaluate((button) => button.click());
    await page.locator("#resume-conflict").waitFor();
    assert.equal(await resumeDialog.getByLabel("Label").inputValue(), "Preserved browser draft");
    assert.equal(await resumeDialog.getByLabel("Replacement file").evaluate((input) => input.files.length), 1);
    const resumeEndpoint = new URL(`/api/resumes/${encodeURIComponent(uploaded.id)}`, page.url()).href;
    let releaseCanonicalRefresh;
    const heldRefresh = new Promise((resolve) => { releaseCanonicalRefresh = resolve; });
    const holdCanonicalRefresh = async (route) => {
      if (route.request().method() === "GET") {
        await heldRefresh;
      }
      await route.continue();
    };
    await page.route(resumeEndpoint, holdCanonicalRefresh);
    try {
      await Promise.all([
        page.waitForRequest((request) => request.url() === resumeEndpoint && request.method() === "GET", { timeout: 10_000 }),
        page.getByRole("button", { name: "Refresh canonical revision" }).click(),
      ]);
      // Clicking refresh does not mean its GET has completed. A save before
      // completion must fail closed, retain the draft, and remain reviewable.
      const [earlySave] = await Promise.all([
        page.waitForResponse((response) => response.url() === resumeEndpoint && response.request().method() === "PATCH"),
        resumeDialog.getByRole("button", { name: "Save metadata" }).click(),
      ]);
      assert.equal(earlySave.status(), 409);
      await page.waitForFunction(() => document.activeElement?.id === "resume-conflict");
      assert.equal(await resumeDialog.getByLabel("Label").inputValue(), "Preserved browser draft");
      assert.deepEqual(await cli("resume-get", ["--id", uploaded.id]), canonicalBeforeRefresh);
      releaseCanonicalRefresh();
      await page.locator("#resume-conflict").waitFor({ state: "hidden" });
    } finally {
      releaseCanonicalRefresh();
      await page.unroute(resumeEndpoint, holdCanonicalRefresh);
    }
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
    const proposal = await cli("resume-proposal-create", ["--resume-id", proposalResume.id, "--expected-resume-revision", String(proposalResume.revision), "--expected-profile-revision", String(profile.revision)], { firstName: "Extracted browser fact", workHistory: [{ company: "New Co", title: "Principal Engineer" }], browserAutoFact: "Auto-filled browser fact", browserAncestor: { child: "Extracted child" } });
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
    assert.deepEqual(await page.locator("#proposal-rows > .proposal-group > h3").allTextContents(), ["Identity", "Experience", "Additional"]);
    assert.deepEqual(await page.locator("#proposal-form select[name]").evaluateAll((items) => items.map((item) => item.value)), ["", "", ""]);
    const firstNameReview = page.locator(".proposal-row").filter({ has: page.locator("legend", { hasText: "/firstName" }) });
    await page.getByRole("button", { name: "Keep all current" }).click();
    assert.deepEqual(await page.locator("#proposal-form select[name]").evaluateAll((items) => items.map((item) => item.value)), ["keep_current", "keep_current", "keep_current"]);
    await firstNameReview.locator("select").selectOption("use_extracted");
    await page.locator('.proposal-row select[name="/workHistory"]').selectOption("");
    await page.locator('.proposal-row select[name="/browserAncestor/child"]').selectOption("");
    await page.getByRole("button", { name: "Apply selected decisions" }).click();
    await page.locator("#proposal-dialog").waitFor({ state: "hidden" });
    assert.equal((await cli("resume-proposal-get", ["--id", proposal.id])).status, "pending");
    assert.equal((await cli("profile-inspect")).profile.firstName, "Extracted browser fact");
    await resumeDialog.getByRole("button", { name: "Review", exact: true }).click();
    const ancestorReview = page.locator(".proposal-row").filter({ has: page.locator("legend", { hasText: "/browserAncestor/child" }) });
    await page.locator('.proposal-row select[name="/workHistory"]').selectOption("use_extracted");
    await ancestorReview.locator("select").selectOption("use_extracted");
    await ancestorReview.getByText('Using the extracted value will replace existing /browserAncestor: "Canonical ancestor value"').waitFor();
    await page.getByRole("button", { name: "Apply selected decisions" }).click();
    await page.getByText("Confirm that accepting /browserAncestor/child replaces /browserAncestor.").waitFor();
    assert.equal((await cli("profile-inspect")).profile.browserAncestor, "Canonical ancestor value");
    await ancestorReview.getByLabel("I confirm replacing /browserAncestor").check();
    await page.getByRole("button", { name: "Apply selected decisions" }).click();
    const replacementDialog = page.locator("#replacement-confirm-dialog");
    await replacementDialog.waitFor({ state: "visible" });
    assert.match(await replacementDialog.innerText(), /\/workHistory replaces the whole collection/);
    assert.equal((await cli("profile-inspect")).profile.browserAncestor, "Canonical ancestor value");
    await replacementDialog.getByRole("button", { name: "Confirm and apply decisions" }).click();
    await page.locator("#proposal-dialog").waitFor({ state: "hidden" });
    profile = await cli("profile-inspect");
    assert.equal(profile.profile.firstName, "Extracted browser fact");
    assert.equal(profile.profile.browserAutoFact, "Auto-filled browser fact");
    assert.deepEqual(profile.profile.browserAncestor, { child: "Extracted child" });
    assert.deepEqual(profile.profile.workHistory, [{ company: "New Co", title: "Principal Engineer" }]);
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
  Object.assign(context, { profile, reassignedCliJob });
}
