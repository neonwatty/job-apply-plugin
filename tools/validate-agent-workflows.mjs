#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(modulePath), "..");
const validationContract = {
  "schemas/workflow.schema.json": "9a8ec6738c54e22db369db6d2d11b3c6ffe0f59799992dbfa796d0e6dcfe563e",
  "src/workflow.js": "f479c42d901571ac8a8a8adf0b5e77d7433c9c674cb6c47360be564a239b386c",
};
const runnerPackages = ["@lineagehq/workflows", "@neonwatty/agent-workflows"];

export function committedWorkflowPaths(root = defaultRoot) {
  const directory = path.join(root, ".workflows", "workflows");
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".workflow.yaml"))
    .map((entry) => `.workflows/workflows/${entry.name}`)
    .sort();
}

export function parseValidatorResult(stdout, workflowPath) {
  let result;
  try {
    result = JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(`${workflowPath}: validator did not return one JSON result: ${error.message}`);
  }
  if (typeof result?.ok !== "boolean") {
    throw new Error(`${workflowPath}: validator JSON is missing boolean ok`);
  }
  return result;
}

export function workflowRunnerPath(root, packageName = runnerPackages[0]) {
  return path.join(root, "node_modules", ...packageName.split("/"), "bin", "workflow.js");
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function selectWorkflowRunner(root = defaultRoot) {
  for (const packageName of runnerPackages) {
    const runnerPath = workflowRunnerPath(root, packageName);
    if (!existsSync(runnerPath)) continue;
    const packageRoot = path.dirname(path.dirname(runnerPath));
    for (const [relativePath, expected] of Object.entries(validationContract)) {
      const actual = sha256(path.join(packageRoot, relativePath));
      if (actual !== expected) {
        throw new Error(`${packageName} validation contract drifted at ${relativePath}`);
      }
    }
    return { packageName, runnerPath };
  }
  throw new Error(`workflow validator unavailable; npm ci must install ${runnerPackages.join(" or ")}`);
}

export function validateAgentWorkflows({ root = defaultRoot, workflowPaths } = {}) {
  const paths = workflowPaths ?? committedWorkflowPaths(root);
  const runner = selectWorkflowRunner(root);
  const results = paths.map((workflowPath) => {
    const child = spawnSync(process.execPath, [runner.runnerPath, "validate", "--json", workflowPath], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    if (child.error) throw new Error(`${workflowPath}: validator unavailable: ${child.error.message}`);
    if (child.status !== 0 || child.signal !== null) {
      const diagnostic = child.stderr.trim() || "no stderr";
      throw new Error(`${workflowPath}: validator process failed (status ${child.status}, signal ${child.signal}): ${diagnostic}`);
    }
    if (!child.stdout.trim()) {
      const diagnostic = child.stderr.trim() || "no stderr";
      throw new Error(`${workflowPath}: validator returned no JSON (status 0): ${diagnostic}`);
    }
    const result = parseValidatorResult(child.stdout, workflowPath);
    const runnerSucceeded = child.status === 0 && child.signal === null;
    return {
      workflowPath,
      ok: runnerSucceeded && result.ok === true,
      runnerStatus: child.status,
      runnerSignal: child.signal,
      result,
      stderr: child.stderr.trim(),
    };
  });
  return { ok: results.every((item) => item.ok), runnerPackage: runner.packageName, results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  try {
    const report = validateAgentWorkflows();
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  }
}
