#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { executeSuites } from "./test-runner/execute.mjs";
import { collectChanges, trackedPaths } from "./test-runner/git.mjs";
import { loadMatrix, selectAffected, tierSuites, validateMatrix } from "./test-runner/matrix.mjs";
import { buildReceipt, writeReceipt } from "./test-runner/receipt.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VALID_TIERS = new Set(["fast", "affected", "full", "platform", "release"]);

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write("usage: node tools/test-runner.mjs <fast|affected|full|platform|release> [--base ref] [--receipt path] [--concurrency count]\n");
  return 2;
}

export function parseArguments(argv) {
  const [tier, ...rest] = argv;
  if (!VALID_TIERS.has(tier)) throw new Error(`unknown test tier: ${tier ?? "<missing>"}`);
  const options = { tier, base: null, receipt: null, concurrency: null };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (!["--base", "--receipt", "--concurrency"].includes(flag) || !rest[index + 1]) {
      throw new Error(`invalid argument: ${flag}`);
    }
    const value = rest[++index];
    if (flag === "--base") options.base = value;
    if (flag === "--receipt") options.receipt = value;
    if (flag === "--concurrency") {
      options.concurrency = Number(value);
      if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16) {
        throw new Error("concurrency must be an integer from 1 to 16");
      }
    }
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    return usage(error.message);
  }
  const [matrix, tracked] = await Promise.all([loadMatrix(ROOT), trackedPaths(ROOT)]);
  const errors = validateMatrix(matrix, tracked);
  if (errors.length) {
    process.stderr.write(`${errors.join("\n")}\n`);
    return 2;
  }
  let selection = { suiteIds: tierSuites(matrix, options.tier), fallbackReason: null };
  if (options.tier === "affected") {
    const changes = await collectChanges(ROOT, options.base);
    selection = { ...changes, ...selectAffected(matrix, tracked, changes.changedPaths) };
    process.stdout.write(`[selection] ${selection.suiteIds.join(", ")}${selection.fallbackReason ? ` (${selection.fallbackReason})` : ""}\n`);
  }
  const suitesById = new Map(matrix.suites.map((suite) => [suite.id, suite]));
  const suites = selection.suiteIds.map((id) => suitesById.get(id));
  const results = await executeSuites(ROOT, suites, tracked, { concurrency: options.concurrency });
  const receipt = buildReceipt(selection, results);
  if (options.receipt) await writeReceipt(ROOT, options.receipt, receipt);
  process.stdout.write(`[summary] ${receipt.status}; ${results.length} suite(s)\n`);
  return receipt.status === "passed" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
