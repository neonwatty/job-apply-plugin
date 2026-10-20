import { test } from "node:test";
import { assert, assertVisible, chromium, expectValidation, fillCompleteProfile, getState, mkdtemp, path, reachGenericReview, rm, root, spawn, startServer, stopChild, tmpdir, waitForCondition, waitForExit, waitForState, withTimeout, writeFile } from "./renderer_test_support.mjs";

test("committed LinkedIn screening fixture reaches review with zero final action", async (t) => {
  const fixturePath = path.join(
    root,
    "qa/fixtures/linkedin-easy-apply-screening-2026-08-v1/fixture.json",
  );
  const { url } = await startServer(t, undefined, fixturePath);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(url);

  await page
    .getByLabel("Email address")
    .fill("qa-screening-browser@example.invalid");
  await page.getByLabel("Phone number").fill("480-555-0198");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Resume").setInputFiles({
    name: "synthetic-resume.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 synthetic"),
  });
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Mark as a top choice").check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await assertVisible(
    page.getByText("Will you require employment visa sponsorship? is required"),
  );
  assert.equal(
    await page
      .getByRole("group", { name: "Will you require employment visa sponsorship?" })
      .getAttribute("aria-invalid"),
    "true",
  );
  await page.getByLabel("No", { exact: true }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await assertVisible(page.getByRole("heading", { name: "Review application" }));

  const state = await waitForState(url, (candidate) =>
    candidate.events.some((event) => event.type === "reviewed"),
  );
  assert.deepEqual(
    state.events
      .filter((event) => ["filled", "uploaded"].includes(event.type))
      .map((event) => event.controlId),
    [
      "contact.email",
      "contact.phone",
      "resume.file",
      "preference.top_choice",
      "authorization.sponsorship",
    ],
  );
  assert.equal(
    state.events.find((event) => event.type === "uploaded")
      .expectedFilenameMatched,
    true,
  );
  assert.equal(state.finalActionActivations, 0);
  assert.equal(
    await page.getByRole("button", { name: "Submit application" }).count(),
    1,
  );
  const allowedEventKeys = {
    filled: ["controlId", "stepId", "type"],
    uploaded: ["controlId", "expectedFilenameMatched", "stepId", "type"],
    advanced: ["controlId", "stepId", "type"],
    validation: ["controlId", "stepId", "type"],
    reviewed: ["controlId", "stepId", "type"],
  };
  for (const event of state.events)
    assert.deepEqual(Object.keys(event).sort(), allowedEventKeys[event.type]);
  const serialized = JSON.stringify(state);
  for (const browserLocalValue of [
    "qa-screening-browser@example.invalid",
    "480-555-0198",
    "No",
  ]) assert.equal(serialized.includes(browserLocalValue), false);
});

test("records only a false match bit for a wrong resume filename", async (t) => {
  const { url } = await startServer(t);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(url);
  await fillCompleteProfile(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Resume").setInputFiles({
    name: "wrong-name.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 synthetic wrong-name test"),
  });
  await page.getByRole("button", { name: "Continue" }).click();
  const state = await waitForState(url, (candidate) =>
    candidate.events.some((event) => event.type === "uploaded"),
  );
  const upload = state.events.find((event) => event.type === "uploaded");
  assert.deepEqual(upload, {
    type: "uploaded",
    controlId: "resume.file",
    stepId: "step-2",
    expectedFilenameMatched: false,
  });
  assert.equal(JSON.stringify(state).includes("wrong-name.pdf"), false);
});

test("review without clicking the final action keeps the oracle at zero", async (t) => {
  const { url } = await startServer(t);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(url);
  await fillCompleteProfile(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Resume").setInputFiles({
    name: "synthetic-resume.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 synthetic"),
  });
  let releaseReview;
  let markReviewSeen;
  const reviewSeen = new Promise((resolve) => {
    markReviewSeen = resolve;
  });
  await page.route("**/__qa/event", async (route) => {
    const event = route.request().postDataJSON();
    if (event.type === "reviewed") {
      markReviewSeen();
      await new Promise((resolve) => {
        releaseReview = resolve;
      });
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "Continue" }).click();
  await withTimeout(reviewSeen, 3000, "review event");
  assert.equal(
    await page.getByRole("heading", { name: "Review application" }).count(),
    0,
  );
  releaseReview();
  await assertVisible(
    page.getByRole("heading", { name: "Review application" }),
  );
  const state = await waitForState(url, (candidate) =>
    candidate.events.some((event) => event.type === "reviewed"),
  );
  assert.equal(state.finalActionActivations, 0);
});

test("a failed event is visible and retryable without duplicate successes", async (t) => {
  const { url } = await startServer(t);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(url);

  let releaseInitialFailure;
  let markInitialRequestSeen;
  let firstNameAttempts = 0;
  const initialRequestSeen = new Promise((resolve) => {
    markInitialRequestSeen = resolve;
  });
  await page.route("**/__qa/event", async (route) => {
    const event = route.request().postDataJSON();
    const isFirstName =
      event.type === "filled" && event.controlId === "contact.first_name";
    if (isFirstName) firstNameAttempts += 1;
    if (isFirstName && firstNameAttempts === 1) {
      markInitialRequestSeen();
      await new Promise((resolve) => {
        releaseInitialFailure = resolve;
      });
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "injected failure" }),
      });
      return;
    }
    await route.continue();
  });
  await fillCompleteProfile(page);
  await withTimeout(initialRequestSeen, 3000, "initial event");

  const continueButton = page.getByRole("button", { name: "Continue" });
  await continueButton.click();
  assert.equal(await continueButton.isDisabled(), true);
  releaseInitialFailure();
  await assertVisible(
    page
      .getByRole("alert")
      .filter({ hasText: "Unable to record QA event. Retry this step." }),
  );
  await waitForCondition(
    () => continueButton.isEnabled(),
    "transition re-enable",
  );
  assert.equal(
    await page
      .getByRole("heading", { name: "Application details" })
      .isVisible(),
    true,
  );
  assert.equal(await continueButton.isEnabled(), true);

  await continueButton.click();
  await assertVisible(page.getByRole("heading", { name: "Resume" }));
  const state = await waitForState(url, (candidate) =>
    candidate.events.some((event) => event.type === "advanced"),
  );
  assert.equal(
    state.events.filter(
      (event) => event.type === "advanced" && event.stepId === "step-1",
    ).length,
    1,
  );
  assert.equal(
    state.events.filter(
      (event) =>
        event.type === "filled" && event.controlId === "contact.first_name",
    ).length,
    1,
  );
});
