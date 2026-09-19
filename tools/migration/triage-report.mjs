import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep this order aligned with SCENARIOS in check.mjs and requirements.mjs.
export const SCENARIOS = ['valid', 'invalid', 'missing', 'noop', 'privacy',
  'conflict', 'concurrency', 'interruption', 'recovery', 'platform'];
export const STATUSES = ['required-planned', 'reviewed-inapplicable', 'unassessed'];
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const emptyCounts = () => Object.fromEntries(STATUSES.map((status) => [status, 0]));

function add(group, key, status) {
  group[key] ??= emptyCounts();
  group[key][status] += 1;
}

export function buildTriageReport(surfaces, requirements) {
  if (!Array.isArray(surfaces) || !Array.isArray(requirements)) throw new Error('Expected surface and requirement arrays');
  const surfaceMap = new Map();
  for (const surface of surfaces) {
    if (!nonempty(surface?.id) || !nonempty(surface?.kind) || !nonempty(surface?.node)
      || surfaceMap.has(surface.id)) throw new Error(`Invalid or duplicate surface: ${surface?.id}`);
    surfaceMap.set(surface.id, surface);
  }
  const mapped = new Map();
  const requirementIds = new Set();
  for (const item of requirements) {
    if (!nonempty(item?.id) || requirementIds.has(item.id)) throw new Error(`Invalid or duplicate requirement: ${item?.id}`);
    requirementIds.add(item.id);
    if (!SCENARIOS.includes(item.category) || !Array.isArray(item.surfaceIds) || !item.surfaceIds.length
      || new Set(item.surfaceIds).size !== item.surfaceIds.length) throw new Error(`Invalid coverage: ${item.id}`);
    const applicability = item.applicability;
    if (applicability?.status === 'inapplicable') {
      if (!nonempty(applicability.rationale) || !nonempty(applicability.reviewer)
        || !Array.isArray(applicability.sourcePaths) || !applicability.sourcePaths.length
        || applicability.sourcePaths.some((path) => !item.oracleFiles?.some((file) => file?.path === path))
        || item.testBindings?.length || item.expectedArtifacts?.length) {
        throw new Error(`Unreviewed inapplicability: ${item.id}`);
      }
    } else if (applicability?.status !== 'required') throw new Error(`Unknown applicability: ${item.id}`);
    for (const surfaceId of item.surfaceIds) {
      if (!surfaceMap.has(surfaceId)) throw new Error(`Unknown surface: ${item.id}:${surfaceId}`);
      const key = JSON.stringify([surfaceId, item.category]);
      if (mapped.has(key)) throw new Error(`Duplicate cell mapping: ${surfaceId}:${item.category}`);
      mapped.set(key, item);
    }
  }
  const report = {
    schemaVersion: 1,
    note: 'Requirement mappings are plans, not accepted test evidence. Unassessed cells are not confirmed behavior differences.',
    surfaces: surfaces.length,
    totalCells: surfaces.length * SCENARIOS.length,
    counts: emptyCounts(), byKind: {}, byNode: {}, byCategory: {}, cells: [],
  };
  for (const surface of surfaces) for (const category of SCENARIOS) {
    const item = mapped.get(JSON.stringify([surface.id, category]));
    const status = item ? item.applicability.status === 'required'
      ? 'required-planned' : 'reviewed-inapplicable' : 'unassessed';
    report.counts[status] += 1;
    add(report.byKind, surface.kind, status);
    add(report.byNode, surface.node, status);
    add(report.byCategory, category, status);
    report.cells.push({ surfaceId: surface.id, kind: surface.kind, node: surface.node,
      category, status, ...(item ? { requirementId: item.id } : {}) });
  }
  return report;
}

export async function loadTriageReport(root) {
  const directory = resolve(root, 'config/migration');
  const names = (await readdir(directory)).sort();
  const surfaces = [];
  const requirements = [];
  for (const name of names) {
    const key = name.endsWith('-surfaces.json') ? 'surfaces'
      : name.startsWith('requirements-') && name.endsWith('.json') ? 'requirements' : null;
    if (!key) continue;
    const document = JSON.parse(await readFile(resolve(directory, name), 'utf8'));
    if (document.schemaVersion !== 1 || !Array.isArray(document[key])) throw new Error(`Invalid shard: ${name}`);
    (key === 'surfaces' ? surfaces : requirements).push(...document[key]);
  }
  return buildTriageReport(surfaces, requirements);
}

function textSummary(report) {
  const lines = [`${report.surfaces} surfaces × ${SCENARIOS.length} scenarios = ${report.totalCells} cells`];
  for (const status of STATUSES) lines.push(`${status}: ${report.counts[status]}`);
  lines.push(report.note);
  for (const [label, group] of [['kind', report.byKind], ['node', report.byNode], ['category', report.byCategory]]) {
    lines.push(`${label}:`);
    for (const [key, counts] of Object.entries(group).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  ${key}: ${STATUSES.map((status) => `${status}=${counts[status]}`).join(' ')}`);
    }
  }
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => !['--json', '--summary'].includes(arg)) || args.includes('--json') && args.includes('--summary')) {
      throw new Error('Usage: node tools/migration/triage-report.mjs [--json | --summary]');
    }
    const report = await loadTriageReport(process.cwd());
    console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : textSummary(report));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
