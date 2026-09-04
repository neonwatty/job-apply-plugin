import { test } from "node:test";
import { assert, assertVisible, chromium, expectValidation, fillCompleteProfile, getState, mkdtemp, path, reachGenericReview, rm, root, spawn, startServer, stopChild, tmpdir, waitForCondition, waitForExit, waitForState, withTimeout, writeFile } from "./renderer_test_support.mjs";

test("renders the exact closed Lever profile through review without final action", async (t) => {
  const controls = [
    ["resume.file", "file", "Resume", true],
    ["contact.full_name", "textbox", "Full name", true],
    ["contact.email", "textbox", "Email address", true],
    ["contact.phone", "textbox", "Phone number", true],
    ["contact.location", "combobox", "Current location", true, ["Phoenix, Arizona, United States", "Seattle, Washington, United States"]],
    ["employment.current_company", "textbox", "Current company", false],
    ["profile.location_url", "textbox", "Current location profile", false],
    ["profile.linkedin", "textbox", "LinkedIn profile", true],
    ["profile.github", "textbox", "GitHub profile", false],
    ["profile.portfolio", "textbox", "Portfolio", false],
    ["profile.website", "textbox", "Website", false],
    ["authorization.work_authorized", "radiogroup", "Authorized to work in the United States?", true, ["Yes", "No", "Not applicable"]],
    ["authorization.sponsorship_status", "radiogroup", "Will you require employment visa sponsorship?", true, ["Yes", "No", "Not applicable"]],
    ["source.discovery_radio", "radiogroup", "How did you hear about this opportunity?", false, ["Professional network", "Referral", "Recruiter", "Career site", "Job board", "Agency", "Other"]],
    ["compensation.total_range", "radiogroup", "Expected total compensation", true, ["Below $100,000", "$100,000–$199,999", "$200,000–$259,999", "$260,000+"]],
    ["compensation.target_salary", "textbox", "Target salary", false],
    ["employment.prior_company", "radiogroup", "Previously worked for this company?", true, ["Yes", "No"]],
    ["conflict.related_person", "radiogroup", "Related to someone at this company?", true, ["Yes", "No"]],
    ["conflict.customer_partner_reseller", "radiogroup", "Worked for a customer, partner, or reseller?", true, ["Yes", "No"]],
    ["location.us_resident", "radiogroup", "Live in the United States?", true, ["Yes", "No"]],
    ["location.city_state", "textbox", "City and state", true],
    ["authorization.us_citizen", "radiogroup", "United States citizen?", false, ["Yes", "No"]],
    ["authorization.green_card", "radiogroup", "Permanent resident?", false, ["Yes", "No"]],
    ["eeo.gender", "combobox", "Gender", false, ["Male", "Female", "Decline to answer"]],
    ["eeo.race", "radiogroup", "Race or ethnicity", false, ["Hispanic or Latino", "White", "Black or African American", "Native Hawaiian or Pacific Islander", "Asian", "American Indian or Alaska Native", "Two or more races", "Decline to answer"]],
    ["eeo.veteran", "combobox", "Veteran status", false, ["Protected veteran", "Not a protected veteran", "Decline to answer"]],
    ["eeo.disability", "combobox", "Disability status", false, ["Yes", "No", "Decline to answer"]],
  ].map(([id, role, label, required, choices]) => ({
    id,
    kind: id,
    role,
    label,
    required,
    ...(choices ? { choices } : {}),
  }));
  const { url } = await startServer(t, (fixture) => ({
    ...fixture,
    id: "lever-browser-v1",
    platformFamily: "lever",
    steps: [
      { id: "step-1", kind: "form", title: "Application form", controls, next: "review" },
      fixture.steps.at(-1),
    ],
  }));
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(url);

  await page.getByLabel("Resume").setInputFiles({
    name: "synthetic-resume.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\nfictional\n%%EOF\n"),
  });
  for (const control of controls.filter((candidate) => candidate.required && candidate.role !== "file")) {
    if (control.role === "textbox")
      await page.locator(`[id="${control.id}"]`).fill("Synthetic response");
    else if (control.role === "combobox")
      await page.getByLabel(control.label, { exact: true }).selectOption(control.choices[0]);
    else
      await page.getByRole("group", { name: control.label }).getByLabel(control.choices[0], { exact: true }).check();
  }
  await page.getByRole("button", { name: "Continue" }).click();
  await assertVisible(page.getByRole("heading", { name: "Review application" }));

  const state = await waitForState(url, (candidate) =>
    candidate.events.some((event) => event.type === "reviewed"),
  );
  assert.equal(state.finalActionActivations, 0);
  assert.deepEqual(
    state.events
      .filter((event) => ["filled", "uploaded"].includes(event.type))
      .map((event) => event.controlId),
    controls.filter((control) => control.required).map((control) => control.id),
  );
  assert.equal(JSON.stringify(state).includes("Synthetic response"), false);
});
