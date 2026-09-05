#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PYTHON = process.env.PYTHON || "python3";
const PASS_REPORT = Object.freeze({
  schemaVersion: 1,
  oracle: "unified_task_spine",
  result: "pass",
  closed: true,
  proof: {
    isolatedStore: true,
    uxFirstIntake: true,
    agentFirstCanonicalIntake: true,
    duplicateConvergence: true,
    sharedComparisonSnapshot: true,
    ownerConfirmedExactRevisionSelection: true,
    oneCanonicalAcquisitionTarget: true,
    sharedActivity: true,
    sharedNeedsAttention: true,
    durableLinkedAnswerResolved: true,
    unsavedJobDraftPreserved: true,
    managedResumeContinuity: true,
    detachedStoreScopedAttemptBroker: true,
    launcherTeardownAndIndependentClients: true,
    awaitingReviewInBothClients: true,
    privacySafeTranscript: true,
    zeroFinalActions: true,
    cleanupComplete: true,
  },
  counts: {
    canonicalJobs: 2,
    canonicalAcquisitionTargets: 1,
    sequentialAcquisitions: 2,
    finalActionEvents: 0,
  },
  transcript: [
    "ux_intake_saved",
    "agent_intake_created",
    "duplicate_converged",
    "comparison_shared",
    "owner_selected_exact_revision",
    "canonical_job_acquired",
    "needs_attention_shared",
    "linked_answer_resolved",
    "canonical_job_reacquired",
    "awaiting_review_shared",
    "closed_without_final_action",
  ],
});

const PUBLIC_STAGES = new Set([
  "setup", "ux_intake", "agent_intake", "selection", "first_acquisition",
  "attention_open", "answer_open", "answer_save", "answer_recheck",
  "second_acquisition", "final_verification", "cleanup",
]);

class OracleFailure extends Error {
  constructor(code, stage = "cleanup") {
    super(code);
    this.stage = stage;
  }
}

export function publicFailureReport(error) {
  return {
    schemaVersion: 1,
    oracle: "unified_task_spine",
    result: "fail",
    closed: true,
    error: "oracle_failed",
    stage: PUBLIC_STAGES.has(error?.stage) ? error.stage : "unknown",
  };
}

function check(condition, code) {
  if (!condition) throw new OracleFailure(code);
}

function syntheticPdf() {
  const header = "%PDF-1.7\n";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n",
  ];
  const offsets = [];
  let body = header;
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body));
    body += object;
  }
  const xrefOffset = Buffer.byteLength(body);
  const entries = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return Buffer.from(`${body}xref\n0 4\n0000000000 65535 f \n${entries}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
}

async function liveReviewSession(attemptRevision) {
  const fixture = JSON.parse(await readFile(
    join(REPO_ROOT, "qa", "fixtures", "greenhouse-form-readiness-v1", "fixture.json"),
    "utf8",
  ));
  const observationRevision = 17;
  const requiredControlIds = fixture.steps.flatMap((step) => step.controls)
    .filter((control) => control.required)
    .map((control) => control.id)
    .sort();
  const controlSetFingerprint = `sha256:${createHash("sha256").update(JSON.stringify({
    platformFamily: fixture.platformFamily, requiredControlIds,
  })).digest("hex")}`;
  return {
    status: "review",
    step: "review",
    pendingFields: [],
    answerKeys: [],
    attemptRevision,
    readinessInput: {
      attemptRevision,
      evidenceKind: "agent_attested_current_attempt",
      fixture,
      formManifest: {
        schemaVersion: 1,
        platformFamily: fixture.platformFamily,
        observationRevision,
        requiredControlIds,
        controlSetFingerprint,
        complete: true,
      },
      expectedObservationRevision: observationRevision,
      observation: {
        schemaVersion: 1,
        platformFamily: "greenhouse",
        observationRevision,
        adapterState: "accessible",
        uploadCapability: "available",
        controls: [
          { controlId: "authorization.sponsorship_select", kind: "selection", state: "complete", observationRevision },
          { controlId: "contact.first_name", kind: "text", state: "complete", observationRevision },
          { controlId: "contact.phone_country", kind: "selection", state: "complete", observationRevision },
          { controlId: "resume.file", kind: "upload", state: "accepted", observationRevision },
        ],
        validationErrorControlIds: [],
        finalControlState: "available",
      },
    },
  };
}

function waitForStartup(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => reject(new OracleFailure("server_start_timeout")), 10_000);
    child.stdout.setEncoding("utf8");
    child.stderr.resume();
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(stdout.slice(0, newline)));
      } catch {
        reject(new OracleFailure("server_start_invalid"));
      }
    });
    child.once("exit", () => {
      clearTimeout(timeout);
      reject(new OracleFailure("server_start_failed"));
    });
  });
}

function privateAttempt(script, storeRoot, jobId, owner, expectedRevision, temporary) {
  let inputCounter = 0;
  const client = async (name, args = [], payload) => {
    const finalArgs = [script, "--root", storeRoot, name, ...args];
    let inputPath;
    if (payload !== undefined) {
      inputPath = join(temporary, `attempt-input-${inputCounter++}.json`);
      await writeFile(inputPath, JSON.stringify(payload));
      finalArgs.push("--input", inputPath);
    }
    const result = spawnSync(PYTHON, finalArgs, {
      cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    if (inputPath) await rm(inputPath, { force: true });
    check(result.status === 0 && result.stderr === "", "attempt_client_failed");
    let response;
    try { response = JSON.parse(result.stdout); } catch { response = null; }
    check(response?.ok, "attempt_command_failed");
    return response;
  };
  return {
    async start() {
      const response = await client("start", [
        "--id", jobId, "--owner", owner,
        "--expected-revision", String(expectedRevision),
      ]);
      check(response?.ok && response.event === "acquired", "attempt_acquire_failed");
      return response.attempt;
    },
    async send(request) {
      if (request.command === "heartbeat" && Object.keys(request).length === 1) {
        return client("heartbeat");
      }
      if (request.command === "progress" && Object.keys(request).length === 2) {
        return client("progress", [], request.session);
      }
      if (request.command === "handoff" && Object.keys(request).length === 3) {
        return client("handoff", ["--status", request.status], request.session);
      }
      throw new OracleFailure("attempt_request_invalid");
    },
    async completed() {},
  };
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return true;
  child.kill("SIGINT");
  const code = await new Promise((resolve) => child.once("exit", resolve));
  return code === 0;
}

function publicReportIsSafe(report) {
  const serialized = JSON.stringify(report);
  const forbidden = [
    "claim_", "https://", "http://", "answerKey", "answerValue", "resumePath",
    "browserState", "credential", "bearer", "token", tmpdir(), REPO_ROOT,
  ];
  return forbidden.every((value) => !serialized.toLowerCase().includes(value.toLowerCase()));
}

export async function runOracle() {
  const temporary = await mkdtemp(join(tmpdir(), "unified-task-spine-"));
  const storeRoot = join(temporary, "store");
  const storeScript = join(REPO_ROOT, "scripts", "job-apply-store.py");
  const taskScript = join(REPO_ROOT, "scripts", "job-apply-task.py");
  const attemptScript = join(REPO_ROOT, "scripts", "job-apply-attempt.py");
  let inputCounter = 0;
  let server;
  let browser;
  let serverStopped = false;
  let browserStopped = false;
  let storeRemoved = false;
  let stage = "setup";
  const attempts = [];

  const command = async (script, name, args = [], payload) => {
    const finalArgs = [script, "--root", storeRoot, name, ...args];
    if (payload !== undefined) {
      const inputPath = join(temporary, `input-${inputCounter++}.json`);
      await writeFile(inputPath, JSON.stringify(payload));
      finalArgs.push("--input", inputPath);
    }
    const result = spawnSync(PYTHON, finalArgs, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      let failureCode = "rejected";
      try { failureCode = JSON.parse(result.stdout)?.error?.code || failureCode; } catch {}
      throw new OracleFailure(`${name}_${failureCode}`);
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new OracleFailure("cli_invalid_json");
    }
  };
  const store = (name, args = [], payload) => command(storeScript, name, args, payload);
  const task = (name, args = [], payload) => command(taskScript, name, args, payload);

  try {
    await store("profile-replace", ["--expected-revision", "0", "--source", "user"], { firstName: "Synthetic" });
    const sourceResume = join(temporary, "synthetic-resume.pdf");
    await writeFile(sourceResume, syntheticPdf());
    const resume = await store("resume-create", [], { id: "oracle-resume", label: "Synthetic resume", path: sourceResume });

    server = spawn(PYTHON, [
      join(REPO_ROOT, "scripts", "job-apply-workspace.py"),
      "--root", storeRoot, "--port", "0", "--no-open", "--json",
    ], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const startup = await waitForStartup(server);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", () => pageErrors.push(true));
    await page.addInitScript(() => { globalThis.setInterval = () => 0; });
    await page.goto(startup.url);
    await page.getByText("Canonical store connected").waitFor();

    stage = "ux_intake";
    const uxUrl = "https://ux-first.example.invalid/jobs/canonical";
    await page.getByRole("button", { name: "Jobs", exact: true }).click();
    await page.getByRole("button", { name: "New job" }).click();
    const jobDialog = page.locator("#job-dialog");
    await jobDialog.getByLabel("Job URL").fill(uxUrl);
    await jobDialog.getByLabel("Role").fill("UX First Role");
    await jobDialog.getByLabel("Company").fill("Synthetic Company");
    await jobDialog.getByLabel("Priority").fill("5");
    await jobDialog.getByLabel("Resume").selectOption(resume.id);
    await jobDialog.getByRole("button", { name: "Save job" }).click();
    await jobDialog.waitFor({ state: "hidden" });

    let jobs = await store("job-list");
    check(jobs.length === 1 && jobs[0].role === "UX First Role", "ux_intake_failed");
    const selectedId = jobs[0].id;

    stage = "agent_intake";
    const agentUrl = "https://agent-first.example.invalid/jobs/comparison";
    const agent = await task("intake", [], {
      url: agentUrl, role: "Agent First Role", company: "Synthetic Company",
    });
    check(agent.ok && agent.action === "create", "agent_intake_failed");
    const duplicate = await task("intake", [], { url: uxUrl, role: "UX First Role" });
    check(duplicate.ok && duplicate.job.id === selectedId && duplicate.action !== "create", "duplicate_did_not_converge");

    const beforeSelection = await task("snapshot");
    check(beforeSelection.ok && beforeSelection.snapshot.jobs.length === 2, "snapshot_job_count");
    check(beforeSelection.snapshot.jobs.every((job) => (
      typeof job.role === "string" && typeof job.company === "string"
      && Number.isInteger(job.priority) && Number.isInteger(job.revision)
    )), "snapshot_missing_comparison_inputs");
    const candidate = beforeSelection.snapshot.jobs.find((job) => job.id === selectedId);
    check(candidate?.status === "saved", "selection_candidate_missing");
    stage = "selection";
    const selection = await task("select", [
      "--id", selectedId, "--expected-revision", String(candidate.revision), "--owner-confirmed",
    ]);
    check(selection.ok && selection.job.status === "ready" && selection.job.revision > candidate.revision, "selection_failed");

    stage = "first_acquisition";
    const firstSession = privateAttempt(
      attemptScript, storeRoot, selectedId, "synthetic-agent", selection.job.revision, temporary,
    );
    attempts.push(firstSession);
    const first = await firstSession.start();
    const resumeBytesBefore = await readFile(first.resume.path);
    const pending = {
      status: "active", step: "questions", answerKeys: [],
      pendingFields: [{ question: "Shared visible wording?", state: "missing", answerKey: "durable.target", sensitive: false }],
    };
    await firstSession.send({ command: "heartbeat" });
    await firstSession.send({ command: "progress", session: pending });
    await firstSession.send({ command: "handoff", status: "needs_info", session: pending });
    await firstSession.completed();
    await store("answer-put", [], {
      key: "durable.decoy", question: "Shared visible wording?", scope: { decoy: true },
      state: "confirmed", value: "synthetic decoy",
    });
    await store("answer-put", [], { key: "durable.target", question: "Different canonical wording", state: "missing" });

    const activity = await task("activity", ["--id", selectedId]);
    check(activity.activity.job.status === "needs_info", "activity_not_blocked");
    check(activity.activity.session.pendingInformation.length === 1, "activity_pending_count");
    check(beforeSelection.snapshot.attention.items.length === 0, "attention_not_initially_empty");
    const blockedSnapshot = await task("snapshot");
    check(blockedSnapshot.snapshot.attention.items.some((item) => item.jobId === selectedId), "cli_attention_missing");

    stage = "attention_open";
    await page.reload();
    await page.getByText("Canonical store connected").waitFor();
    await page.locator("#nav-attention").click();
    await page.locator(`[data-attention-id="${selectedId}"]`).click();
    await jobDialog.getByText(/Canonical status needs info/i).waitFor();
    await jobDialog.getByRole("heading", { name: "Application activity" }).waitFor();
    await jobDialog.getByLabel("Notes").fill("unsaved synthetic draft");
    stage = "answer_open";
    const openAnswer = jobDialog.getByRole("button", { name: "Open in Answers" });
    await openAnswer.click();
    const answerDialog = page.locator("#answer-dialog");
    await answerDialog.waitFor({ state: "visible" });
    check(await answerDialog.getByLabel("Question").inputValue() === "Different canonical wording", "wrong_linked_answer");
    check(await jobDialog.getByLabel("Notes").inputValue() === "unsaved synthetic draft", "draft_lost_on_navigation");
    await answerDialog.getByLabel("State").selectOption("confirmed");
    await answerDialog.getByLabel("Value", { exact: true }).fill("synthetic accepted value");
    stage = "answer_save";
    const answerPath = `/api/answers/by-key/${Buffer.from("durable.target").toString("base64url")}`;
    const answerSaved = page.waitForResponse((response) => (
      new URL(response.url()).pathname === answerPath
      && response.request().method() === "PATCH"
    ));
    const activityReloaded = page.waitForResponse((response) => (
      new URL(response.url()).pathname === `/api/jobs/${encodeURIComponent(selectedId)}/activity`
      && response.request().method() === "GET"
    ));
    await answerDialog.getByRole("button", { name: "Save answer" }).click();
    check((await answerSaved).ok(), "answer_save_response_failed");
    await answerDialog.waitFor({ state: "hidden" });
    check((await activityReloaded).ok(), "activity_reload_failed");
    check(await jobDialog.getByLabel("Notes").inputValue() === "unsaved synthetic draft", "draft_lost_on_answer_save");
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Open in Answers");
    check(await openAnswer.evaluate((button) => document.activeElement === button), "focus_not_restored");
    stage = "answer_recheck";
    const answerResolved = page.waitForResponse((response) => (
      new URL(response.url()).pathname === `/api/jobs/${encodeURIComponent(selectedId)}/resolve-pending-answer`
      && response.request().method() === "POST"
    ));
    await jobDialog.getByRole("button", { name: "Recheck this revision" }).click();
    check((await answerResolved).ok(), "answer_recheck_response_failed");
    await jobDialog.getByText(/Canonical status ready/i).waitFor();
    check(await jobDialog.getByLabel("Notes").inputValue() === "unsaved synthetic draft", "draft_lost_on_resolution");
    await jobDialog.getByRole("button", { name: "Close job details" }).click();

    const ready = await store("job-get", ["--id", selectedId]);
    check(ready.status === "ready" && ready.revision > first.job.revision, "resolution_not_ready");
    stage = "second_acquisition";
    const secondSession = privateAttempt(
      attemptScript, storeRoot, selectedId, "synthetic-agent-resume", ready.revision, temporary,
    );
    attempts.push(secondSession);
    const second = await secondSession.start();
    for (const field of ["id", "revision", "contentRevision", "digest"]) {
      check(second.resume[field] === first.resume[field], "resume_identity_changed");
    }
    check(Buffer.compare(await readFile(second.resume.path), resumeBytesBefore) === 0, "resume_bytes_changed");
    await secondSession.send({
      command: "handoff", status: "awaiting_review",
      session: await liveReviewSession(second.job.revision),
    });
    await secondSession.completed();

    stage = "final_verification";
    const finalActivity = await task("activity", ["--id", selectedId]);
    const finalSnapshot = await task("snapshot");
    check(finalActivity.activity.job.status === "awaiting_review", "cli_not_awaiting_review");
    check(finalSnapshot.snapshot.jobs.find((job) => job.id === selectedId)?.status === "awaiting_review", "snapshot_not_awaiting_review");
    await page.getByRole("button", { name: "Jobs", exact: true }).click();
    await page.locator("#refresh").click();
    await page.locator(`[data-id="${selectedId}"]`).click();
    await jobDialog.getByText(/Canonical status awaiting review/i).waitFor();

    jobs = await store("job-list");
    const events = await store("history-list");
    const selectedIds = new Set(events.filter((event) => event.event === "job-started").map((event) => event.applicationId));
    check(jobs.length === 2, "canonical_job_count_changed");
    check(selectedIds.size === 1 && selectedIds.has(selectedId), "multiple_acquisition_targets");
    check(events.map((event) => event.event).join(",") === "job-started,job-blocked,job-started,reviewed", "history_not_closed");
    check(!events.some((event) => ["applied", "completed"].includes(event.event) || event.status === "applied"), "final_action_detected");
    check(pageErrors.length === 0, "browser_error");
    check(publicReportIsSafe(PASS_REPORT), "report_privacy_failure");
    assert.notEqual(process.env.JOB_APPLY_STORE_ROOT, storeRoot);
  } catch (error) {
    throw new OracleFailure("oracle_failed", stage);
  } finally {
    const brokerPidPath = join(storeRoot, ".job-apply-attempt.pid");
    try {
      const brokerPid = Number((await readFile(brokerPidPath, "utf8")).trim());
      if (Number.isInteger(brokerPid) && brokerPid > 1) process.kill(brokerPid, "SIGKILL");
    } catch {}
    if (browser) {
      await browser.close().catch(() => {});
      browserStopped = true;
    }
    serverStopped = await stopServer(server).catch(() => false);
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    storeRemoved = await access(temporary).then(() => false, () => true);
  }
  check(browserStopped && serverStopped && storeRemoved, "cleanup_failed");
  return PASS_REPORT;
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "--json") {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, oracle: "unified_task_spine", result: "fail", closed: true, error: "invalid_invocation" })}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(await runOracle())}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(publicFailureReport(error))}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
