#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(modulePath), "..");

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

export function validateAgentWorkflows({ root = defaultRoot, workflowPaths } = {}) {
  const paths = workflowPaths ?? committedWorkflowPaths(root);
  const runner = path.join(root, "node_modules", ".bin", "workflow");
  const results = paths.map((workflowPath) => {
    const child = spawnSync(runner, ["validate", "--json", workflowPath], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    if (child.error) throw new Error(`${workflowPath}: validator unavailable: ${child.error.message}`);
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
  return { ok: results.every((item) => item.ok), results };
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
