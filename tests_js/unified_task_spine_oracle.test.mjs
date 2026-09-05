import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright";

import { publicFailureReport } from "../qa/unified_task_spine_oracle.mjs";
import { waitForSavedAnswerFocus } from "../qa/unified_task_spine_focus.mjs";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("answer focus waits for refreshed controls, not the closing dialog's old opener", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="job-dialog"><div id="activity-pending">'
      + '<button data-pending-reference="synthetic">Open in Answers</button></div></div>');
    await page.locator("button").focus();
    // Exercise the actual browser predicate without depending on wall-clock sleeps.
    const predicates = [];
    const probe = { waitForFunction: async (predicate) => {
      predicates.push(predicate);
      return page.evaluate(predicate);
    } };
    await waitForSavedAnswerFocus(probe);
    const ready = () => page.evaluate(predicates[0]);
    assert.equal(await ready(), false, "old focused opener must not count as restored focus");
    await page.evaluate(() => {
      document.querySelector("#activity-pending").innerHTML =
        '<button data-pending-reference="synthetic">Open in Answers</button>'
        + '<button data-pending-reference="synthetic">Recheck this revision</button>';
    });
    assert.equal(await ready(), false, "render completion alone must not count as focus");
    await page.getByRole("button", { name: "Recheck this revision" }).focus();
    assert.equal(await ready(), false, "wrong control must not satisfy the wait");
    await page.getByRole("button", { name: "Open in Answers" }).focus();
    assert.equal(await ready(), true);
    const recheck = page.getByRole("button", { name: "Recheck this revision" });
    await recheck.evaluate((button) => { button.dataset.pendingReference = "other"; });
    assert.equal(await ready(), false, "unrelated recheck must not satisfy the wait");
    await recheck.evaluate((button) => { button.dataset.pendingReference = "synthetic"; });
    await waitForSavedAnswerFocus(page);
  } finally {
    await browser.close();
  }
});

test("oracle failures expose only allowlisted diagnostic stages", () => {
  const sensitive = new Error("token at /tmp/private-path");
  sensitive.stage = "answer_save";
  assert.deepEqual(publicFailureReport(sensitive), {
    schemaVersion: 1,
    oracle: "unified_task_spine",
    result: "fail",
    closed: true,
    error: "oracle_failed",
    stage: "answer_save",
  });
  sensitive.stage = "token at /tmp/private-path";
  const serialized = JSON.stringify(publicFailureReport(sensitive));
  assert.match(serialized, /"stage":"unknown"/);
  assert.doesNotMatch(serialized, /token|private-path|\/tmp\//i);
  for (const stage of ["answer_save_response", "answer_save_dialog", "answer_save_activity",
    "answer_save_draft", "answer_save_focus", "answer_save_focus_identity"]) {
    sensitive.stage = stage;
    assert.equal(publicFailureReport(sensitive).stage, stage);
    assert.doesNotMatch(JSON.stringify(publicFailureReport(sensitive)), /token|private-path/);
  }
});

test("package smoke preserves privacy-safe oracle diagnostics", async () => {
  const source = await readFile(join(REPO_ROOT, "scripts", "smoke-plugin.sh"), "utf8");
  assert.match(source, /echo "Running unified task spine oracle"\s+node "\$REPO_ROOT\/qa\/unified_task_spine_oracle\.mjs" --json/);
  assert.doesNotMatch(source, /unified_task_spine_oracle\.mjs" --json\s*>\/dev\/null/);
});

test("unified task spine oracle is executable, deterministic, closed, and privacy-safe", { timeout: 90_000 }, async () => {
  const source = await readFile(join(REPO_ROOT, "qa", "unified_task_spine_oracle.mjs"), "utf8");
  const attemptSource = await readFile(join(REPO_ROOT, "scripts", "job-apply-attempt.py"), "utf8");
  assert.match(source, /job-apply-attempt\.py/);
  assert.match(source, /spawnSync\(PYTHON, finalArgs/);
  assert.doesNotMatch(source, /child\.stdin\.write/);
  assert.doesNotMatch(source, /job-acquire|claim-(?:heartbeat|progress|handoff|recover)|--token/);
  assert.match(attemptSource, /start_new_session=True/);
  assert.match(attemptSource, /socket\.AF_UNIX/);
  assert.match(attemptSource, /peer_is_current_user/);
  assert.match(attemptSource, /path\.chmod\(0o600\)/);
  const child = spawn(process.execPath, [join(REPO_ROOT, "qa", "unified_task_spine_oracle.mjs"), "--json"], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 0, stdout);
  assert.equal(stderr, "");
  assert.equal(stdout.split("\n").filter(Boolean).length, 1);
  const report = JSON.parse(stdout);
  assert.deepEqual(
    { schemaVersion: report.schemaVersion, oracle: report.oracle, result: report.result, closed: report.closed },
    { schemaVersion: 1, oracle: "unified_task_spine", result: "pass", closed: true },
  );
  assert.equal(Object.values(report.proof).every((value) => value === true), true);
  assert.deepEqual(report.counts, {
    canonicalJobs: 2,
    canonicalAcquisitionTargets: 1,
    sequentialAcquisitions: 2,
    finalActionEvents: 0,
  });
  assert.equal(report.transcript.at(-1), "closed_without_final_action");
  assert.doesNotMatch(stdout, /claim_|https?:\/\/|answerKey|answerValue|resumePath|browserState|credential|bearer|token|\/tmp\//i);
});
