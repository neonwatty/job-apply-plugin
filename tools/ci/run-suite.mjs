#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { executeSuites } from "../test-runner/execute.mjs";
import { trackedPaths } from "../test-runner/git.mjs";
import { loadMatrix, validateMatrix } from "../test-runner/matrix.mjs";
import { buildReceipt, writeReceipt } from "../test-runner/receipt.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export async function main(argv = process.argv.slice(2)) {
  const [suiteId, receiptPath] = argv;
  if (!suiteId || argv.length > 2) throw new Error("usage: run-suite.mjs <suite-id> [receipt-path]");
  const [matrix, tracked] = await Promise.all([loadMatrix(ROOT), trackedPaths(ROOT)]);
  const errors = validateMatrix(matrix, tracked);
  if (errors.length) throw new Error(errors.join("\n"));
  const suite = matrix.suites.find((item) => item.id === suiteId);
  if (!suite) throw new Error(`unknown suite: ${suiteId}`);
  const results = await executeSuites(ROOT, [suite], tracked, { concurrency: 1 });
  const receipt = buildReceipt({ suiteIds: [suiteId], fallbackReason: null }, results);
  if (receiptPath) await writeReceipt(ROOT, receiptPath, receipt);
  return receipt.status === "passed" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
