import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { discoverBrowserExports, checkBrowserBindings } from './browser-exports.mjs';
import { discoverNextBrowserExports, isNextComponentSource } from './next-surfaces.mjs';
import { detectServingMap, HYBRID_RUNTIME_PATHS } from './browser-serving-map.mjs';
import { validateRequirements, missingRequirementCoverage } from './requirements.mjs';
import { validatePackages } from './packages.mjs';
import { discoverTestIds } from './test-bindings.mjs';
import { loadMatrix, suiteFiles } from '../test-runner/matrix.mjs';
import { loadTaskEvidence } from './load-task-evidence.mjs';
import { loadPrerequisites } from './load-prerequisites.mjs';
import { auditHistoricalBoundary } from './historical-boundary.mjs';

export const SCENARIOS = ['valid', 'invalid', 'missing', 'noop', 'privacy', 'conflict',
  'concurrency', 'interruption', 'recovery', 'platform'];
const CODE = /\.(?:py|js|mjs|ts|swift|sh|html|css|c|h)$/;
const ROOTS = new Set(['scripts', 'workspace', 'qa', 'native', 'src', 'runtime']);
const MANIFESTS = new Set(['package.json', '.codex-plugin/plugin.json',
  '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json']);
const COMPANION_SOURCE = /^apps\/companion\/.+\.(?:ts|tsx|mjs|css)$/;
export const inSourceScope = (path) => (ROOTS.has(path.split('/')[0]) && CODE.test(path))
  || MANIFESTS.has(path) || COMPANION_SOURCE.test(path) || path === 'apps/companion/package.json';
const safePath = (path) => typeof path === 'string' && path.trim().length > 0
  && !/^[a-z]:/i.test(path) && !/[\u0000-\u001f\u007f]/.test(path)
  && !path.startsWith('/') && !path.includes('\\') && !path.split('/').some((part) => ['..', '.', ''].includes(part));
const SURFACE_FIELDS = {
  http: ['method', 'path'], cli: ['command'], browser: ['export'],
  document: ['path', 'artifact'], journal: ['path', 'discriminator', 'value'],
};

export function validateReviewLock(lock, hashes) {
  if (lock?.schemaVersion !== 1 || !Array.isArray(lock.files)) return ['Invalid inventory review lock'];
  const errors = [];
  const seen = new Set();
  for (const item of lock.files) {
    if (!safePath(item.path) || seen.has(item.path) || !hashes.has(item.path)
      || !/^[a-f0-9]{64}$/.test(item.sha256) || hashes.get(item.path) !== item.sha256) {
      errors.push(`Inventory shard changed/missing: ${item.path}; explicit review reconciliation required`);
    }
    seen.add(item.path);
  }
  for (const path of hashes.keys()) if (!seen.has(path)) errors.push(`Unreviewed inventory shard ${path}`);
  return errors;
}

export function validateInventory({ nodes, sources, surfaces }, actual, { acceptance = false } = {}) {
  const errors = [];
  const nodeMap = new Map();
  for (const node of nodes) {
    if (!/^[A-Z][A-Z0-9]*$/.test(node.id) || nodeMap.has(node.id)) errors.push(`Invalid/duplicate node ${node.id}`);
    nodeMap.set(node.id, node);
    if (!Array.isArray(node.dependencies) || new Set(node.dependencies).size !== node.dependencies.length) {
      errors.push(`Invalid dependencies ${node.id}`);
    }
    // Acceptance receipts require a future reviewed evidence schema, not arbitrary claims.
    if (node.status !== 'open') errors.push(`Unsupported acceptance claim for ${node.id}`);
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) { errors.push(`Dependency cycle at ${id}`); return; }
    if (visited.has(id)) return;
    const node = nodeMap.get(id);
    if (!node) { errors.push(`Unknown dependency ${id}`); return; }
    visiting.add(id);
    for (const dependency of Array.isArray(node.dependencies) ? node.dependencies : []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of nodeMap.keys()) visit(id);
  const sourceMap = new Map();
  for (const source of sources) {
    if (!safePath(source.path) || sourceMap.has(source.path)) errors.push(`Invalid/duplicate source ${source.path}`);
    sourceMap.set(source.path, source);
    if (!/^[a-f0-9]{64}$/.test(source.sha256) || source.sha256 !== actual.get(source.path)) {
      errors.push(`Source changed/missing: ${source.path}; reconcile inventory before proceeding`);
    }
    if (source.classification !== 'unreviewed') errors.push(`Unsupported source classification ${source.path}`);
  }
  for (const path of actual.keys()) if (!sourceMap.has(path)) errors.push(`Uninventoried source ${path}`);
  const surfaceIds = new Set();
  const identities = new Set();
  for (const surface of surfaces) {
    const allowed = new Set(['id', 'kind', 'node', 'sources', 'effects', 'scenarios', ...(SURFACE_FIELDS[surface.kind] ?? [])]);
    if (Object.keys(surface).some((key) => !allowed.has(key))) errors.push(`Unknown surface field ${surface.id}`);
    if (typeof surface.id !== 'string' || !surface.id || surfaceIds.has(surface.id)) errors.push(`Invalid/duplicate surface ${surface.id}`);
    surfaceIds.add(surface.id);
    if (!nodeMap.has(surface.node)) errors.push(`Unknown owner for ${surface.id}`);
    if (!Array.isArray(surface.sources) || !surface.sources.length
      || surface.sources.some((path) => !sourceMap.has(path))) errors.push(`Missing source binding ${surface.id}`);
    let identity;
    if (surface.kind === 'http') {
      if (!['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'].includes(surface.method)
        || typeof surface.path !== 'string' || !(surface.path.startsWith('/') || surface.path === '*')) {
        errors.push(`Invalid HTTP surface ${surface.id}`);
      }
      identity = `${surface.method}:${surface.path}`;
    } else if (surface.kind === 'cli') {
      if (typeof surface.command !== 'string' || !surface.command) errors.push(`Invalid CLI surface ${surface.id}`);
      identity = `${surface.sources?.[0]}:${surface.command}`;
    } else if (surface.kind === 'browser') {
      if (typeof surface.export !== 'string' || !surface.export) errors.push(`Invalid browser export ${surface.id}`);
      identity = `browser:${surface.sources?.[0]}:${surface.export}`;
    } else if (surface.kind === 'document') {
      if (!safePath(surface.path) || !['json', 'jsonl', 'lock', 'binary', 'temporary'].includes(surface.artifact)) {
        errors.push(`Invalid persisted artifact ${surface.id}`);
      }
      identity = `document:${surface.path}`;
    } else if (surface.kind === 'journal') {
      const emptyOperation = surface.discriminator === 'operation' && surface.value === null;
      const taggedOperation = ['operation.kind', 'operation.stage'].includes(surface.discriminator)
        && typeof surface.value === 'string' && surface.value.length > 0;
      if (!safePath(surface.path) || !(emptyOperation || taggedOperation)) {
        errors.push(`Invalid journal discriminator ${surface.id}`);
      }
      if (!surfaces.some((item) => item.kind === 'document' && item.path === surface.path && item.artifact === 'json')) {
        errors.push(`Missing journal document ${surface.id}`);
      }
      identity = `journal:${surface.path}:${surface.discriminator}:${JSON.stringify(surface.value)}`;
    } else errors.push(`Unknown surface kind ${surface.id}`);
    if (identity && identities.has(identity)) errors.push(`Duplicate public identity ${identity}`);
    identities.add(identity);
    if (surface.effects !== 'unclassified') errors.push(`Unsupported effect claim ${surface.id}`);
    const scenarios = surface.scenarios;
    if (!scenarios || Object.keys(scenarios).length !== SCENARIOS.length
      || SCENARIOS.some((name) => scenarios[name] !== 'unverified')) errors.push(`Unsupported/missing evidence ${surface.id}`);
  }
  if (!nodes.length || !sources.length || !surfaces.length) errors.push('Empty migration inventory');
  if (acceptance) errors.push('Migration acceptance is open: source/effect classification and behavioral/native evidence are not yet verified');
  return errors;
}

export async function checkInventory(root, options = {}) {
  const directory = resolve(root, 'config/migration');
  const nodesFile = JSON.parse(await readFile(resolve(directory, 'nodes.json'), 'utf8'));
  if (nodesFile.schemaVersion !== 1) throw new Error('Unknown node schema');
  const sources = [];
  const surfaces = [];
  const requirements = [];
  const packages = [];
  const hashes = new Map();
  for (const name of (await readdir(directory)).sort()) {
    if (name.endsWith('.json') && name !== 'review-lock.json') {
      hashes.set(name, createHash('sha256').update(await readFile(resolve(directory, name))).digest('hex'));
    }
    if (name.startsWith('requirements-') || name === 'packages.json') {
      const data = JSON.parse(await readFile(resolve(directory, name), 'utf8'));
      const key = name === 'packages.json' ? 'packages' : 'requirements';
      if (data.schemaVersion !== 1 || !Array.isArray(data[key])) throw new Error(`Invalid ${key} schema`);
      (key === 'packages' ? packages : requirements).push(...data[key]);
    }
    const kind = name.startsWith('source-catalog-') ? 'sources' : name.endsWith('-surfaces.json') ? 'surfaces' : null;
    if (!kind) continue;
    const data = JSON.parse(await readFile(resolve(directory, name), 'utf8'));
    if (data.schemaVersion !== 1 || !Array.isArray(data[kind])) throw new Error(`Invalid inventory shard ${name}`);
    (kind === 'sources' ? sources : surfaces).push(...data[kind]);
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  // Include untracked source to catch new parser/route modules before staging.
  const allPaths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root, env, encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024,
  }).split('\0').filter(Boolean);
  const paths = allPaths.filter(inSourceScope);
  const actual = new Map();
  const browserFiles = new Map();
  const nextComponentFiles = new Map();
  const servingFiles = new Map();
  for (const path of new Set(paths)) {
    try {
      const bytes = await readFile(resolve(root, path));
      actual.set(path, createHash('sha256').update(bytes).digest('hex'));
      if (isNextComponentSource(path)) nextComponentFiles.set(path, bytes.toString('utf8'));
      if (path.startsWith('workspace/') && path.endsWith('.js')) browserFiles.set(path, bytes.toString('utf8'));
      if (HYBRID_RUNTIME_PATHS.includes(path)
        || ['scripts/job_apply_workspace/__init__.py', 'scripts/job_apply_workspace/queries.py'].includes(path)) {
        servingFiles.set(path, bytes.toString('utf8'));
      }
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let taskEvidence = { currentAcceptance: 'open', acceptedTasks: new Set(), acceptedPackages: new Set() };
  const errors = validateInventory({ nodes: nodesFile.nodes, sources, surfaces }, actual, options);
  const servingMap = detectServingMap(new Map([...browserFiles, ...servingFiles]));
  if (servingMap) for (const path of HYBRID_RUNTIME_PATHS) {
    if (!servingFiles.has(path)) throw new Error(`Missing browser export source: ${path}`);
    browserFiles.set(path, servingFiles.get(path));
  }
  const browserExports = [...discoverBrowserExports(browserFiles, servingMap),
    ...discoverNextBrowserExports(nextComponentFiles)];
  errors.push(...checkBrowserBindings(browserExports, surfaces));
  const historicalAudit = await auditHistoricalBoundary(root, snapshot => checkInventory(snapshot));
  if (requirements.length || packages.length) {
    const matrix = await loadMatrix(root);
    const testIds = new Map();
    const files = new Map(actual);
    const registered = new Set(allPaths);
    for (const requirement of requirements) {
      for (const binding of Array.isArray(requirement?.testBindings) ? requirement.testBindings : []) {
        if (!safePath(binding?.file) || !registered.has(binding.file) || testIds.has(binding.file)) continue;
        const source = await readFile(resolve(root, binding.file), 'utf8');
        testIds.set(binding.file, discoverTestIds(binding.file, source, { platform: process.platform }));
      }
      for (const file of Array.isArray(requirement?.oracleFiles) ? requirement.oracleFiles : []) {
        if (!safePath(file?.path) || !registered.has(file.path) || files.has(file.path)) continue;
        files.set(file.path, createHash('sha256').update(await readFile(resolve(root, file.path))).digest('hex'));
      }
    }
    const nodes = new Set(nodesFile.nodes.map((item) => item.id));
    const surfaceIds = new Set(surfaces.map((item) => item.id));
    const planningPaths = [...allPaths, ...matrix.suites.filter(suite => suite.kind === 'node-test')
      .flatMap(suite => (suite.include ?? []).filter(path => safePath(path) && !/[*?\[\]{}]/.test(path)))];
    const requirementContext = { nodes, surfaces: surfaceIds, files, testIds,
      platforms: new Set(['node-local']),
      suites: new Map(matrix.suites.filter((suite) => suite.kind === 'node-test')
        .map((suite) => [suite.id, new Set(suiteFiles(suite, planningPaths))])) };
    if (historicalAudit) {
      // Frozen packages/prerequisites are audited at their original source. They
      // cannot unlock current code; current test bindings still must resolve.
      errors.push(...validateRequirements(requirements, requirementContext));
    } else {
      const prerequisites = await loadPrerequisites(root, { requirements,
        registeredTests: new Set(matrix.suites.filter((suite) => suite.kind === 'node-test')
          .flatMap((suite) => suiteFiles(suite, allPaths))) });
      errors.push(...prerequisites.errors);
      // Only independently scoped, immutable prerequisite evidence can unlock work.
      const packageContext = { nodes, surfaces: surfaceIds,
        requirements: new Set(requirements.map((item) => item?.id)), sourcePaths: registered,
        acceptedInterfaces: prerequisites.acceptedInterfaces, acceptedReferences: prerequisites.acceptedReferences,
        knownInterfaces: prerequisites.knownInterfaces, knownReferences: prerequisites.knownReferences,
        requiredRequirements: new Set(requirements.filter((item) => item?.applicability?.status === 'required').map((item) => item.id)),
        referenceRequirements: prerequisites.referenceRequirements,
        acceptedPackages: new Set() };
      const tasks = await loadTaskEvidence(root, { packages, requirements, packageContext, requirementContext, testIds,
        registeredTests: new Set(matrix.suites.filter(suite => suite.kind === 'node-test').flatMap(suite => suiteFiles(suite, planningPaths))) });
      taskEvidence = tasks;
      errors.push(...tasks.errors);
      errors.push(...validateRequirements(requirements, { ...requirementContext, testIds: tasks.planningTestIds ?? testIds }));
      errors.push(...validatePackages(packages, { ...packageContext, acceptedPackages: tasks.acceptedPackages,
        ownershipHandoffs: tasks.ownershipHandoffs ?? [], historicalReadiness: tasks.historicalReadiness ?? new Map() }));
    }
  }
  const lock = JSON.parse(await readFile(resolve(directory, 'review-lock.json'), 'utf8'));
  errors.push(...validateReviewLock(lock, hashes));
  return { schemaVersion: 1, status: errors.length ? 'failed' : 'inventory-consistent',
    acceptance: 'open', ...(historicalAudit ? { historicalAudit } : {}), taskEvidence: { currentAcceptance: taskEvidence.currentAcceptance,
      acceptedTasks: [...taskEvidence.acceptedTasks].sort(), acceptedPackages: [...taskEvidence.acceptedPackages].sort(), retiredTasks: [...(taskEvidence.retiredTasks ?? [])].sort() }, nodes: nodesFile.nodes.length, sources: sources.length,
    surfaces: surfaces.length, requirements: requirements.length, packages: packages.length,
    unmappedRequirementCells: missingRequirementCoverage(surfaces.map((item) => item.id), requirements).length, errors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length && args[0] !== '--acceptance')) throw new Error('Usage: check:migration [--acceptance]');
    const receipt = await checkInventory(process.cwd(), { acceptance: args.includes('--acceptance') });
    console.log(JSON.stringify(receipt, null, 2));
    if (receipt.errors.length) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
