import { test } from "node:test";
import { assert, assertVisible, chromium, expectValidation, fillCompleteProfile, getState, mkdtemp, path, reachGenericReview, rm, root, spawn, startServer, stopChild, tmpdir, waitForCondition, waitForExit, waitForState, withTimeout, writeFile } from "./renderer_test_support.mjs";

test("renders the closed Ashby profile through review without final action", async (t) => {
  const { url } = await startServer(t, (fixture) => ({
    ...fixture,
    id: "ashby-browser-v1",
    platformFamily: "ashby",
    steps: [
      {
        id: "step-1",
        kind: "form",
        title: "Application form",
        controls: [
          { id: "contact.full_name", kind: "contact.full_name", role: "textbox", label: "Full name", required: true },
          { id: "contact.email", kind: "contact.email", role: "textbox", label: "Email address", required: true },
          { id: "resume.file", kind: "resume.file", role: "file", label: "Resume", required: true },
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

  await expectValidation(page, ["Full name", "Email address", "Resume"]);
  await page.getByLabel("Full name").fill("Avery Replay");
  await page.getByLabel("Email address").fill("avery.replay@example.com");
  await page.getByLabel("Resume").setInputFiles({
    name: "synthetic-resume.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\nfictional\n%%EOF\n"),
  });
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
    ["contact.full_name", "contact.email", "resume.file"],
  );
  const serialized = JSON.stringify(state);
  for (const value of ["Avery Replay", "avery.replay@example.com", "%PDF-1.4"])
    assert.equal(serialized.includes(value), false);
});
