import { access, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const ENTRY_FIELDS = ['path', 'role', 'state', 'replacement'];
const ROLES = new Set(['ordinary', 'policy', 'contract-helper', 'qa']);
const STATES = new Set(['python-required', 'typescript-fixture-only']);
const ROUTING_FILES = new Set([
  'apps/companion/launch.mjs', 'src/package/installed-artifacts.ts',
]);

const safePath = value => typeof value === 'string' && value.length > 0
  && !value.startsWith('/') && !value.includes('\\')
  && !value.split('/').some(part => !part || part === '.' || part === '..');

function normalizePythonTarget(value) {
  const name = value.includes('/') ? value : `scripts/${value}`;
  return name.startsWith('scripts/') && name.endsWith('.py') ? name : null;
}

export function discoverPythonRuntimeTargets(files) {
  const targets = new Map();
  for (const [path, source] of files) {
    if (!(path.startsWith('skills/') && path.endsWith('.md')) && !ROUTING_FILES.has(path)) continue;
    for (const match of source.matchAll(/(?:scripts\/)?[A-Za-z0-9_-]+\.py\b/g)) {
      const target = normalizePythonTarget(match[0]);
      if (!target) continue;
      if (!targets.has(target)) targets.set(target, new Set());
      targets.get(target).add(path);
    }
  }
  return new Map([...targets].sort(([left], [right]) => left.localeCompare(right)));
}

export function validatePythonRuntimeClosure(manifest, files, existingPaths) {
  const errors = [];
  if (!manifest || manifest.schemaVersion !== 1 || !['migration-open', 'migration-closed'].includes(manifest.status)
    || !Array.isArray(manifest.entrypoints) || !Array.isArray(manifest.packagedPythonTrees)) {
    return ['Invalid Python runtime closure manifest'];
  }
  const declared = new Map();
  for (const entry of manifest.entrypoints) {
    const label = entry?.path ?? '<unknown>';
    if (!entry || Object.keys(entry).sort().join('\0') !== [...ENTRY_FIELDS].sort().join('\0')
      || !safePath(entry.path) || !entry.path.startsWith('scripts/') || !entry.path.endsWith('.py')
      || !ROLES.has(entry.role) || !STATES.has(entry.state) || declared.has(entry.path)
      || !existingPaths.has(entry.path)) {
      errors.push(`Invalid Python runtime entrypoint ${label}`);
      continue;
    }
    if (entry.state === 'python-required') {
      if (entry.replacement !== null) errors.push(`Python-only entrypoint has a replacement claim ${entry.path}`);
    } else if (!safePath(entry.replacement) || !existingPaths.has(entry.replacement)
      || !entry.replacement.startsWith('runtime/') || !entry.replacement.endsWith('.js')) {
      errors.push(`Invalid TypeScript replacement binding ${entry.path}`);
    }
    declared.set(entry.path, entry);
  }
  const discovered = discoverPythonRuntimeTargets(files);
  for (const [path, callers] of discovered) {
    if (!declared.has(path)) errors.push(`Unclassified shipped Python runtime target ${path} (${[...callers].sort().join(', ')})`);
  }
  for (const path of declared.keys()) {
    if (!discovered.has(path)) errors.push(`Stale Python runtime declaration ${path}`);
  }
  const trees = manifest.packagedPythonTrees;
  if (new Set(trees).size !== trees.length || trees.some(path => !safePath(path)
    || !path.startsWith('scripts/') || !existingPaths.has(path))) {
    errors.push('Invalid packaged Python tree inventory');
  }
  if (manifest.status === 'migration-closed'
    && (manifest.entrypoints.length !== 0 || trees.length !== 0 || discovered.size !== 0)) {
    errors.push('Closed Python runtime inventory must be empty');
  }
  return errors;
}

export async function checkPythonRuntimeClosure(root) {
  const manifestPath = resolve(root, 'config/migration/python-runtime-closure.json');
  try { await access(manifestPath); } catch { return null; }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', timeout: 5000 })
    .split('\0').filter(Boolean);
  const existingPaths = new Set(tracked);
  for (const tree of manifest.packagedPythonTrees ?? []) {
    if (tracked.some(path => path.startsWith(`${tree}/`))) existingPaths.add(tree);
  }
  const routing = tracked.filter(path => (path.startsWith('skills/') && path.endsWith('.md')) || ROUTING_FILES.has(path));
  const files = new Map(await Promise.all(routing.map(async path => [path, await readFile(resolve(root, path), 'utf8')])));
  const errors = validatePythonRuntimeClosure(manifest, files, existingPaths);
  const discovered = discoverPythonRuntimeTargets(files);
  return {
    schemaVersion: 1,
    status: errors.length ? 'failed' : 'inventory-consistent',
    pythonRuntimeEntrypoints: discovered.size,
    pythonRequired: manifest.entrypoints.filter(entry => entry.state === 'python-required').length,
    fixtureOnlyReplacements: manifest.entrypoints.filter(entry => entry.state === 'typescript-fixture-only').length,
    errors,
  };
}
