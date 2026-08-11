import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
async function startServer(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "qa-renderer-"));
  const fixturePath = path.join(directory, "fixture.json");
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
  await writeFile(fixturePath, JSON.stringify(data));
  const child = spawn(
    "python3",
    ["-m", "qa.server", "--fixture", fixturePath, "--port", "0"],
    { cwd: root },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const startup = await new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline !== -1) resolve(JSON.parse(stdout.slice(0, newline)));
    });
    child.on("exit", (code) =>
      reject(new Error(`server exited ${code}: ${stderr}`)),
    );
  });
  t.after(async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return startup;
}

async function getState(url) {
  return (await fetch(`${url}/__qa/state`)).json();
}

async function assertVisible(locator) {
  await locator.waitFor({ state: "visible" });
  assert.equal(await locator.isVisible(), true);
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

  await page.getByRole("button", { name: "Continue" }).click();
  for (const label of [
    "First name",
    "Last name",
    "Email address",
    "Phone number",
  ]) {
    await assertVisible(page.getByText(`${label} is required`));
  }
  await page.getByLabel("First name").fill("Riley");
  await page.getByLabel("Last name").fill("Example");
  await page.getByLabel("Email address").fill("riley@example.invalid");
  await page.getByLabel("Phone number").fill("202-555-0101");
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
  const beforeSubmit = await getState(url);
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
      (event) => event.type === "uploaded" && event.controlId === "resume.file",
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

test("review without clicking the final action keeps the oracle at zero", async (t) => {
  const { url } = await startServer(t);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(url);
  await page.getByLabel("First name").fill("Riley");
  await page.getByLabel("Last name").fill("Example");
  await page.getByLabel("Email address").fill("riley@example.invalid");
  await page.getByLabel("Phone number").fill("202-555-0101");
  await page.getByRole("button", { name: "Continue" }).click();
  await page
    .getByLabel("Resume")
    .setInputFiles({
      name: "synthetic-resume.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 synthetic"),
    });
  await page.getByRole("button", { name: "Continue" }).click();
  await assertVisible(
    page.getByRole("heading", { name: "Review application" }),
  );
  assert.equal((await getState(url)).finalActionActivations, 0);
});
