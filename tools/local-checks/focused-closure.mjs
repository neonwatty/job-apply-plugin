import { digest, ordered, safePath, SOURCE_SUFFIX, NATIVE_ROOTS } from './focused-contracts.mjs';
import { reverseClosure } from './consumer-graph.mjs';

const test = path => /\.test\.mjs$/.test(path);
const docs = path => path === 'README.md' || path === 'LICENSE' || path.startsWith('docs/');
export function evaluateFocusedClosure(graph, paths) {
  const reasons = [...graph.reasons], remainingPaths = [], ruleIds = new Set(), light = new Set(), heavy = new Set();
  let sharedContract = false;
  const rules = graph.contract?.rules ?? [];
  function requireTests(expected, discovered, target) {
    for (const path of expected) {
      if (!graph.tracked.has(path) || graph.invalidPaths.has(path)) reasons.push(`Missing required consumer: ${path}`);
      target.add(path);
    }
    for (const path of discovered.filter(test)) if (!expected.includes(path) && !NATIVE_ROOTS.includes(path)) {
      reasons.push(`Unreviewed consumer: ${path}`);
    }
  }
  // Re-evaluate every reviewed seam before cache lookup, even with an empty change list.
  for (const rule of rules) {
    for (const [field, shared] of [['runtimePaths', false], ['sharedContractPaths', true]]) {
      const seeds = rule[field] ?? [];
      if (!seeds.length) continue;
      const found = reverseClosure(graph.edges, seeds, { types: shared, emissions: true, tracked: graph.tracked });
      const expected = [...rule.lightTests ?? [], ...rule.heavyTests ?? [], ...(shared ? [...rule.sharedContractAdditionalLightTests ?? [], ...rule.sharedContractAdditionalHeavyTests ?? []] : [])];
      requireTests(expected, found, new Set());
    }
  }
  for (const path of ordered(paths)) {
    if (!safePath(path) || !graph.tracked.has(path) || graph.invalidPaths.has(path)) {
      remainingPaths.push(path); reasons.push(`Unproven changed path: ${path}`); continue;
    }
    const inputConsumers = reverseClosure(graph.edges, [path]).filter(test);
    const rule = rules.find(rule => ['runtimePaths', 'sharedContractPaths', 'referencePaths', 'testInputPaths']
      .some(field => (rule[field] ?? []).includes(path)));
    if (!rule) {
      if (docs(path) && !SOURCE_SUFFIX.test(path) && !inputConsumers.length) continue;
      remainingPaths.push(path);
      if (docs(path) && inputConsumers.length) reasons.push(`Unclassified test input: ${path}`);
      continue;
    }
    ruleIds.add(rule.id);
    const shared = (rule.sharedContractPaths ?? []).includes(path);
    sharedContract ||= shared;
    if ((rule.referencePaths ?? []).includes(path)) {
      requireTests(rule.referenceTests ?? [], reverseClosure(graph.edges, [path]), light); continue;
    }
    if ((rule.testInputPaths ?? []).includes(path)) {
      requireTests(rule.testInputCompanions ?? [], reverseClosure(graph.edges, [path]), light); continue;
    }
    const source = path.startsWith('runtime/') ? path.replace(/^runtime\//, 'src/').replace(/\.js$/, '.ts') : path;
    const emitted = source.replace(/^src\//, 'runtime/').replace(/\.ts$/, '.js');
    const discovered = reverseClosure(graph.edges, [source, emitted], { types: shared, emissions: true, tracked: graph.tracked });
    const expected = [...rule.lightTests, ...rule.heavyTests, ...(shared ? [...rule.sharedContractAdditionalLightTests ?? [], ...rule.sharedContractAdditionalHeavyTests ?? []] : [])];
    requireTests(expected, discovered, new Set());
    for (const item of [...rule.lightTests, ...(shared ? rule.sharedContractAdditionalLightTests ?? [] : [])]) light.add(item);
    for (const item of [...rule.heavyTests, ...(shared ? rule.sharedContractAdditionalHeavyTests ?? [] : [])]) heavy.add(item);
    if (!graph.tracked.has(source) || !graph.tracked.has(emitted)) reasons.push(`Missing source/emission pair: ${path}`);
  }
  for (const path of graph.nativeTests) { light.delete(path); heavy.delete(path); }
  const result = { bounded: reasons.length === 0, reasons: ordered(reasons), ruleIds: ordered(ruleIds),
    remainingPaths: ordered(remainingPaths), docsOnly: paths.length > 0 && paths.every(path => docs(path) && !SOURCE_SUFFIX.test(path) && !reverseClosure(graph.edges, [path]).some(test)) && reasons.length === 0,
    lightTests: ordered(light), heavyTests: ordered(heavy), sharedContract, nativeTests: graph.nativeTests };
  return { ...result, fingerprint: digest(JSON.stringify({ graph: graph.fingerprint, ...result })) };
}
