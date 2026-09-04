import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
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



export {
  assert,
  assertVisible,
  chromium,
  expectValidation,
  fillCompleteProfile,
  getState,
  mkdtemp,
  path,
  reachGenericReview,
  rm,
  root,
  spawn,
  startServer,
  stopChild,
  tmpdir,
  waitForCondition,
  waitForExit,
  waitForState,
  withTimeout,
  writeFile,
};
