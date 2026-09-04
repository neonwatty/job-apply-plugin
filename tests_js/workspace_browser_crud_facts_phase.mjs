import {
  assert, chromium, FACT_SAVE_REVISION_RETRIES, join, minimalSyntheticPdf, PYTHON, REPO_ROOT,
  spawn, writeFile,
} from "./workspace_test_support.mjs";

export async function runBrowserCrudFactsPhase(context) {
  const { cli, storeRoot, temporary, waitForStartup } = context;
  let { browser, server } = context;
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
    context.server = server;
    const startup = await waitForStartup(server);
    browser = await chromium.launch({ headless: true });
    context.browser = browser;
    const browserContext = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
    const page = await browserContext.newPage();
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
    const readiness = page.locator("#profile-readiness");
    await readiness.getByRole("heading", { name: "Profile readiness" }).waitFor();
    assert.deepEqual(await readiness.locator("h3").allTextContents(), ["Essential setup", "Common coverage", "Review health"]);
    assert.match(await readiness.innerText(), /Individual jobs may still require additional information\./);
    assert.doesNotMatch(await readiness.innerText(), /score|percent|application ready|\d+%/i);
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
  Object.assign(context, { browser, server, cliJob, page, pageErrors, jobDialog, profile });
}
