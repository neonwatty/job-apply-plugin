import { test } from "node:test";
import { assert, assertVisible, chromium, expectValidation, fillCompleteProfile, getState, mkdtemp, path, reachGenericReview, rm, root, spawn, startServer, stopChild, tmpdir, waitForCondition, waitForExit, waitForState, withTimeout, writeFile } from "./renderer_test_support.mjs";

test("renders the generic fixture and blocks the final action without leaking values", async (t) => {
  const { url } = await startServer(t);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto(url);

  assert.equal(await page.title(), "Application replay");
  await assertVisible(
    page.getByRole("heading", { name: "Application details" }),
  );
  assert.equal(
    (await page.locator("body").innerText()).match(/linkedin|employer/i),
    null,
  );
  assert.equal(
    requests.every(
      (requestUrl) => new URL(requestUrl).origin === new URL(url).origin,
    ),
    true,
  );

  await expectValidation(page, [
    "First name",
    "Last name",
    "Email address",
    "Phone number",
  ]);
  await fillCompleteProfile(page);
  await page.getByRole("button", { name: "Continue" }).click();

  await assertVisible(page.getByRole("heading", { name: "Resume" }));
  await page.getByLabel("Resume").setInputFiles({
    name: "synthetic-resume.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 synthetic replay resume"),
  });
  await assertVisible(page.getByText("synthetic-resume.pdf"));
  await page.getByRole("button", { name: "Continue" }).click();

  await assertVisible(
    page.getByRole("heading", { name: "Review application" }),
  );
  await assertVisible(page.getByText("Riley", { exact: true }));
  await assertVisible(page.getByText("synthetic-resume.pdf", { exact: true }));
  const beforeSubmit = await waitForState(url, (state) =>
    state.events.some((event) => event.type === "reviewed"),
  );
  assert.deepEqual(
    beforeSubmit.events
      .filter((event) => event.type === "filled")
      .map((event) => event.controlId)
      .sort(),
    [
      "contact.email",
      "contact.first_name",
      "contact.last_name",
      "contact.phone",
    ],
  );
  assert.equal(
    beforeSubmit.events.some(
      (event) =>
        event.type === "uploaded" &&
        event.controlId === "resume.file" &&
        event.expectedFilenameMatched === true,
    ),
    true,
  );
  assert.deepEqual(
    beforeSubmit.events
      .filter((event) => event.type === "advanced")
      .map((event) => event.stepId),
    ["step-1", "step-2"],
  );
  assert.equal(
    beforeSubmit.events.some(
      (event) => event.type === "reviewed" && event.stepId === "review",
    ),
    true,
  );
  const serialized = JSON.stringify(beforeSubmit);
  for (const secret of [
    "Riley",
    "Example",
    "riley@example.invalid",
    "202-555-0101",
    "%PDF-1.4",
  ])
    assert.equal(serialized.includes(secret), false);

  const originalUrl = page.url();
  const button = page.getByRole("button", { name: "Submit application" });
  assert.equal(await button.isEnabled(), true);
  await button.click();
  await assertVisible(page.getByText("Final action blocked by QA tripwire"));
  assert.equal(page.url(), originalUrl);
  assert.equal((await getState(url)).finalActionActivations, 1);
});

test("does not claim the tripwire blocked when its request is unconfirmed", async (t) => {
  const { url } = await startServer(t);
  const browser = await chromium.launch();
  t.after(() => browser.close());

  for (const failure of ["abort", "server-error"]) {
    const page = await browser.newPage();
    await page.goto(url);
    await reachGenericReview(page);
    await page.route("**/__qa/final-action", async (route) => {
      if (failure === "abort") await route.abort("failed");
      else await route.fulfill({ status: 500, body: "failure" });
    });

    await page.getByRole("button", { name: "Submit application" }).click();
    await assertVisible(page.getByText("Unable to confirm the QA tripwire"));
    assert.equal(
      await page.getByText("Final action blocked by QA tripwire").count(),
      0,
    );
    await page.close();
  }
  assert.equal((await getState(url)).finalActionActivations, 0);
});
