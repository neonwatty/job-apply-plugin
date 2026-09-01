import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

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
