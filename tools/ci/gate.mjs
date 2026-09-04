#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export function evaluateGate(results, selectedJobs) {
  const failures = [];
  for (const job of selectedJobs) {
    const status = results[job]?.result ?? "missing";
    if (status !== "success") failures.push({ job, status });
  }
  return { ok: failures.length === 0, failures };
}

export function main(environment = process.env) {
  const results = JSON.parse(environment.CI_RESULTS_JSON ?? "{}");
  const selected = JSON.parse(environment.CI_SELECTED_JOBS ?? "[]");
  if (!Array.isArray(selected) || selected.some((item) => typeof item !== "string")) {
    throw new Error("CI_SELECTED_JOBS must be a JSON string array");
  }
  const decision = evaluateGate(results, selected);
  if (!decision.ok) {
    for (const failure of decision.failures) {
      process.stderr.write(`selected job ${failure.job}: ${failure.status}\n`);
    }
    return 1;
  }
  process.stdout.write(`PR gate accepted ${selected.length} selected job(s)\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
