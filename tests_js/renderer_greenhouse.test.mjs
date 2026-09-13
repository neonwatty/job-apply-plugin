import { test } from "node:test";
import { assert, assertVisible, chromium, expectValidation, fillCompleteProfile, getState, mkdtemp, path, reachGenericReview, rm, root, spawn, startServer, stopChild, tmpdir, waitForCondition, waitForExit, waitForState, withTimeout, writeFile } from "./renderer_test_support.mjs";

test("renders the closed Greenhouse form with deterministic comboboxes", async (t) => {
  const { url } = await startServer(t, (fixture) => ({
    ...fixture,
    id: "greenhouse-browser-v1",
    platformFamily: "greenhouse",
    steps: [
      {
        id: "step-1",
        kind: "form",
        title: "Application form",
        controls: [
          {
            id: "contact.phone_country",
            kind: "contact.phone_country",
            role: "combobox",
            label: "Phone country",
            required: true,
            choices: ["United States +1", "Canada +1"],
          },
          {
            id: "contact.location_city",
            kind: "contact.location_city",
            role: "combobox",
            label: "City",
            required: true,
            choices: [
              "Phoenix, Arizona, United States",
              "Seattle, Washington, United States",
            ],
          },
          {
            id: "authorization.sponsorship_select",
            kind: "authorization.sponsorship_select",
            role: "combobox",
            label: "Will you require employment visa sponsorship?",
            required: true,
            choices: ["Yes", "No"],
          },
        ],
        next: "review",
      },
      fixture.steps.at(-1),
    ],
  }));
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(url);

  await expectValidation(page, [
    "Phone country",
    "City",
    "Will you require employment visa sponsorship?",
  ]);
  await page.getByLabel("Phone country").selectOption("United States +1");
  await page
    .getByLabel("City")
    .selectOption("Phoenix, Arizona, United States");
  await page
    .getByLabel("Will you require employment visa sponsorship?")
    .selectOption("No");
  await page.getByRole("button", { name: "Continue" }).click();
  await assertVisible(page.getByRole("heading", { name: "Review application" }));

  const state = await waitForState(url, (candidate) =>
    candidate.events.some((event) => event.type === "reviewed"),
  );
  assert.deepEqual(
    state.events
      .filter((event) => event.type === "filled")
      .map((event) => event.controlId),
    [
      "contact.phone_country",
      "contact.location_city",
      "authorization.sponsorship_select",
    ],
  );
  assert.equal(state.finalActionActivations, 0);
  const serialized = JSON.stringify(state);
  for (const localValue of [
    "United States +1",
    "Phoenix, Arizona, United States",
    "No",
  ]) assert.equal(serialized.includes(localValue), false);
});
