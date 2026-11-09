import { suiteFiles } from '../test-runner/matrix.mjs';

/** Resolve declared evidence bindings without scheduling or executing any suite. */
export function requirementSuiteRegistry(matrices, paths) {
  const registry = new Map();
  for (const matrix of matrices) for (const suite of matrix.suites) {
    if (suite.kind !== 'node-test') continue;
    const files = registry.get(suite.id) ?? new Set();
    for (const path of suiteFiles(suite, paths)) files.add(path);
    registry.set(suite.id, files);
  }
  return registry;
}
