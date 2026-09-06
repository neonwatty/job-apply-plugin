import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const SCENARIOS = ['valid', 'invalid', 'privacy', 'conflict', 'concurrency', 'recovery', 'platform'];
const CODE = /\.(?:py|js|mjs|ts|swift|sh|html|css)$/;
const ROOTS = new Set(['scripts', 'workspace', 'qa', 'native', 'src', 'runtime']);
const MANIFESTS = new Set(['package.json', '.codex-plugin/plugin.json',
  '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json']);
export const inSourceScope = (path) => (ROOTS.has(path.split('/')[0]) && CODE.test(path)) || MANIFESTS.has(path);
const safePath = (path) => typeof path === 'string' && path.length > 0
  && !path.startsWith('/') && !path.includes('\\') && !path.split('/').some((part) => ['..', '.', ''].includes(part));

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
  const hashes = new Map();
  for (const name of (await readdir(directory)).sort()) {
    if (name.endsWith('.json') && name !== 'review-lock.json') {
      hashes.set(name, createHash('sha256').update(await readFile(resolve(directory, name))).digest('hex'));
    }
    const kind = name.startsWith('source-catalog-') ? 'sources' : name.endsWith('-surfaces.json') ? 'surfaces' : null;
    if (!kind) continue;
    const data = JSON.parse(await readFile(resolve(directory, name), 'utf8'));
    if (data.schemaVersion !== 1 || !Array.isArray(data[kind])) throw new Error(`Invalid inventory shard ${name}`);
    (kind === 'sources' ? sources : surfaces).push(...data[kind]);
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  // Include untracked source to catch new parser/route modules before staging.
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root, env, encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024,
  }).split('\0').filter(inSourceScope);
  const actual = new Map();
  for (const path of new Set(paths)) {
    try { actual.set(path, createHash('sha256').update(await readFile(resolve(root, path))).digest('hex')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const errors = validateInventory({ nodes: nodesFile.nodes, sources, surfaces }, actual, options);
  const lock = JSON.parse(await readFile(resolve(directory, 'review-lock.json'), 'utf8'));
  errors.push(...validateReviewLock(lock, hashes));
  return { schemaVersion: 1, status: errors.length ? 'failed' : 'inventory-consistent',
    acceptance: 'open', nodes: nodesFile.nodes.length, sources: sources.length,
    surfaces: surfaces.length, errors };
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
