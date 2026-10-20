#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { collectChanges, resolveRevision, trackedPaths } from "../test-runner/git.mjs";
import { loadMatrix, selectAffected, validateMatrix } from "../test-runner/matrix.mjs";
import { writeReceipt } from "../test-runner/receipt.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function classify(matrix, tracked, changes) {
  return { ...changes, ...selectAffected(matrix, tracked, changes.changedPaths) };
}

export function parseArguments(argv) {
  const options = { base: null, receipt: null, githubOutput: null };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || !["--base", "--receipt", "--github-output"].includes(flag)) {
      throw new Error(`invalid argument: ${flag ?? "<missing>"}`);
    }
    if (flag === "--base") options.base = value;
    if (flag === "--receipt") options.receipt = value;
    if (flag === "--github-output") options.githubOutput = value;
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const [matrix, tracked] = await Promise.all([loadMatrix(ROOT), trackedPaths(ROOT)]);
  const errors = validateMatrix(matrix, tracked);
  if (errors.length) throw new Error(errors.join("\n"));
  const usableBase = options.base && await resolveRevision(ROOT, options.base) ? options.base : null;
  const selection = classify(matrix, tracked, await collectChanges(ROOT, usableBase));
  const receipt = {
    schemaVersion: 1,
    baseSha: selection.baseSha,
    headSha: selection.headSha,
    changedPaths: selection.changedPaths,
    selectedSuites: selection.suiteIds,
    fallbackReason: selection.fallbackReason,
    timings: [],
    status: "shadow-selection",
  };
  if (options.receipt) await writeReceipt(ROOT, options.receipt, receipt);
  if (options.githubOutput) {
    await fs.appendFile(options.githubOutput, `selected_suites=${JSON.stringify(selection.suiteIds)}\n`);
    await fs.appendFile(options.githubOutput, `fallback=${selection.fallbackReason ? "true" : "false"}\n`);
  }
  process.stdout.write(`shadow selected ${selection.suiteIds.length} suite(s)${selection.fallbackReason ? "; full fallback" : ""}\n`);
  return selection;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
