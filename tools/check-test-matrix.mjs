#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { trackedPaths } from "./test-runner/git.mjs";
import { loadMatrix, validateMatrix } from "./test-runner/matrix.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tracked = await trackedPaths(root);
const matrix = await loadMatrix(root);
const errors = validateMatrix(matrix, tracked);
if (errors.length) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`test matrix valid: ${matrix.suites.length} suites, ${tracked.length} tracked paths\n`);
}
