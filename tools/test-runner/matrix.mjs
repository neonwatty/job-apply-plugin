import fs from "node:fs/promises";
import path from "node:path";
import { expandPatterns, matches } from "./patterns.mjs";

const TIERS = new Set(["fast", "full", "platform", "release"]);
const KINDS = new Set(["command", "python-unittest", "node-test"]);

export async function loadMatrix(root, matrixPath = "config/test-matrix.json") {
  const absolute = path.resolve(root, matrixPath);
  let value;
  try {
    value = JSON.parse(await fs.readFile(absolute, "utf8"));
  } catch (error) {
    throw new Error(`cannot read test matrix: ${error.message}`);
  }
  return value;
}

export function suiteFiles(suite, tracked) {
  return expandPatterns(tracked, suite.include ?? [], suite.exclude ?? []);
}

export function validateMatrix(matrix, tracked) {
  const errors = [];
  const trackedSet = new Set(tracked);
  if (matrix.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!Array.isArray(matrix.suites) || matrix.suites.length === 0) {
    errors.push("suites must be a non-empty array");
    return errors;
  }
  const ids = new Set();
  for (const suite of matrix.suites) {
    if (!suite.id || ids.has(suite.id)) errors.push(`duplicate or empty suite id: ${suite.id}`);
    ids.add(suite.id);
    if (!KINDS.has(suite.kind)) errors.push(`${suite.id}: unsupported kind ${suite.kind}`);
    if (!Array.isArray(suite.tiers) || suite.tiers.some((tier) => !TIERS.has(tier))) {
      errors.push(`${suite.id}: invalid tiers`);
    }
    if (suite.kind === "command" && (!Array.isArray(suite.command) || !suite.command.length)) {
      errors.push(`${suite.id}: command is required`);
    }
    if (suite.kind === "command" && suite.command?.some((part) => typeof part !== "string" || !part)) {
      errors.push(`${suite.id}: command entries must be non-empty strings`);
    }
    for (const part of suite.kind === "command" ? suite.command ?? [] : []) {
      if (/^(scripts|tools|tests|tests_js)\//.test(part) && !trackedSet.has(part)) {
        errors.push(`${suite.id}: command path does not exist: ${part}`);
      }
    }
    if (suite.kind !== "command" && !(suite.include?.length)) {
      errors.push(`${suite.id}: include patterns are required`);
    }
    if (suite.kind !== "command" && suite.include?.length && suiteFiles(suite, tracked).length === 0) {
      errors.push(`${suite.id}: include patterns match no tracked tests`);
    }
  }
  for (const rule of matrix.ownership ?? []) {
    for (const id of rule.suites ?? []) {
      if (!ids.has(id)) errors.push(`ownership references unknown suite: ${id}`);
    }
  }
  const filesBySuite = new Map(
    matrix.suites.map((suite) => [suite.id, suiteFiles(suite, tracked)]),
  );
  const inventory = tracked.filter((item) => matches(item, matrix.inventory?.include ?? []));
  for (const item of inventory) {
    const owned = matrix.suites.some((suite) => filesBySuite.get(suite.id).includes(item))
      || (matrix.ownership ?? []).some((rule) => matches(item, rule.paths))
      || matches(item, matrix.globalPaths ?? []);
    if (!owned) errors.push(`unowned executable/test path: ${item}`);
  }
  const tests = tracked.filter((item) => matches(item, matrix.fullInventory?.include ?? []));
  const counts = new Map(tests.map((item) => [item, 0]));
  for (const suite of matrix.suites.filter((item) => item.tiers.includes("full"))) {
    for (const item of filesBySuite.get(suite.id)) {
      if (counts.has(item)) counts.set(item, counts.get(item) + 1);
    }
  }
  for (const [item, count] of counts) {
    if (count !== 1) errors.push(`full inventory count ${count} for ${item}`);
  }
  return errors;
}

export function tierSuites(matrix, tier) {
  return matrix.suites.filter((suite) => suite.tiers.includes(tier)).map((suite) => suite.id);
}

export function selectAffected(matrix, tracked, changedPaths) {
  const fast = tierSuites(matrix, "fast");
  for (const changed of changedPaths) {
    if (matches(changed, matrix.globalPaths ?? [])) {
      return { suiteIds: tierSuites(matrix, "full"), fallbackReason: `global path: ${changed}` };
    }
  }
  const selected = new Set(fast);
  for (const changed of changedPaths) {
    const selfOwners = matrix.suites
      .filter((suite) => suiteFiles(suite, tracked).includes(changed))
      .map((suite) => suite.id);
    const ruleOwners = (matrix.ownership ?? [])
      .filter((rule) => matches(changed, rule.paths))
      .flatMap((rule) => rule.suites);
    const owners = [...new Set([...selfOwners, ...ruleOwners])];
    if (!owners.length) {
      return { suiteIds: tierSuites(matrix, "full"), fallbackReason: `unknown path: ${changed}` };
    }
    for (const owner of owners) selected.add(owner);
  }
  return { suiteIds: [...selected], fallbackReason: null };
}
