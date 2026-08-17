import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("server shutdown timed out"));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", onExit);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitForExit(child, 2000);
  } catch {
    child.kill("SIGKILL");
    await waitForExit(child, 2000);
  }
}

async function startServer(
  t,
  transformFixture = (fixture) => fixture,
  committedFixturePath = null,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "qa-renderer-"));
  let fixturePath = path.join(directory, "fixture.json");
  const data = {
    schemaVersion: 1,
    id: "renderer-browser-v1",
    platformFamily: "linkedin-easy-apply",
    captureMonth: "2026-08",
    compilerVersion: "1.0.0",
    provenance: {
      recorderVersion: "1.0.0",
      captureMonth: "2026-08",
      sourceRecordingSha256: "a".repeat(64),
    },
    steps: [
      {
        id: "step-1",
        kind: "form",
        title: "Application details",
        controls: [
          {
            id: "contact.first_name",
            kind: "contact.first_name",
            role: "textbox",
            label: "First name",
            required: true,
          },
          {
            id: "contact.last_name",
            kind: "contact.last_name",
            role: "textbox",
            label: "Last name",
            required: true,
          },
          {
            id: "contact.email",
            kind: "contact.email",
            role: "textbox",
            label: "Email address",
            required: true,
          },
          {
            id: "contact.phone",
            kind: "contact.phone",
            role: "textbox",
            label: "Phone number",
            required: true,
          },
        ],
        next: "step-2",
      },
      {
        id: "step-2",
        kind: "form",
        title: "Resume",
        controls: [
          {
            id: "resume.file",
            kind: "resume.file",
            role: "file",
            label: "Resume",
            required: true,
          },
        ],
        next: "review",
      },
      {
        id: "review",
        kind: "review",
        title: "Review application",
        controls: [],
        finalAction: {
          id: "final.apply",
          label: "Submit application",
          enabled: true,
          tripwire: true,
        },
      },
    ],
    oracle: { finalActionActivations: 0 },
  };
  if (committedFixturePath === null)
    await writeFile(fixturePath, JSON.stringify(transformFixture(data)));
  else fixturePath = committedFixturePath;
  let child;
  try {
    child = spawn(
      "python3",
      [
        "-m",
        "qa.server",
        "--fixture",
        fixturePath,
        "--port",
        "0",
        "--expected-resume-filename",
        "synthetic-resume.pdf",
      ],
      { cwd: root },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const startup = await new Promise((resolve, reject) => {
      let stdout = "";
      const timer = setTimeout(
        () => reject(new Error("server startup timed out")),
        5000,
      );
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        const newline = stdout.indexOf("\n");
        if (newline !== -1) {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(stdout.slice(0, newline)));
          } catch (error) {
            reject(error);
          }
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited ${code}: ${stderr}`));
      });
    });
    t.after(async () => {
      try {
        await stopChild(child);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
    return startup;
  } catch (error) {
    try {
      if (child) await stopChild(child);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    throw error;
  }
}

async function getState(url, timeoutMs = 1000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return (
      await fetch(`${url}/__qa/state`, { signal: controller.signal })
    ).json();
  } finally {
    clearTimeout(timer);
  }
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function waitForState(url, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await getState(url);
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("state polling timed out");
}

async function waitForCondition(predicate, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} timed out`);
}

async function assertVisible(locator) {
  await locator.waitFor({ state: "visible", timeout: 3000 });
  assert.equal(await locator.isVisible(), true);
}

async function expectValidation(page, labels) {
  await page.getByRole("button", { name: "Continue" }).click();
  for (const label of labels) {
    await assertVisible(page.getByText(`${label} is required`));
    assert.equal(
      await page.getByLabel(label).getAttribute("aria-invalid"),
      "true",
    );
    await assertVisible(
      page.getByRole("alert").filter({ hasText: `${label} is required` }),
    );
  }
  assert.equal(
    await page
      .getByLabel(labels[0])
      .evaluate((input) => input === document.activeElement),
    true,
  );
}

async function fillCompleteProfile(page) {
  await page.getByLabel("First name").fill("Riley");
  await page.getByLabel("Last name").fill("Example");
  await page.getByLabel("Email address").fill("riley@example.invalid");
  await page.getByLabel("Phone number").fill("202-555-0101");
  for (const label of [
    "First name",
    "Last name",
    "Email address",
    "Phone number",
  ]) {
    assert.equal(
      await page.getByLabel(label).getAttribute("aria-invalid"),
      null,
    );
  }
}

async function reachGenericReview(page) {
  await fillCompleteProfile(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Resume").setInputFiles({
    name: "synthetic-resume.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 synthetic replay resume"),
  });
  await page.getByRole("button", { name: "Continue" }).click();
  await assertVisible(
    page.getByRole("heading", { name: "Review application" }),
  );
}

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
