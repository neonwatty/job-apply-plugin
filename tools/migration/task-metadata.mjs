import { closed, digest, equal, hash, sha } from './evidence-io.mjs';
import { containsRecords, recordKeys } from './history-records.mjs';

export const CATALOG = 'config/migration/task-contracts.json';
export const REVIEW_LOCK = 'config/migration/review-lock.json';
export const HANDOFFS = 'config/migration/task-handoffs.json';
export const RECEIPTS = 'config/migration/task-receipts.json';
export const LINEAGE = 'config/migration/task-lineage.json';
export const COORDINATOR = new Set([CATALOG, REVIEW_LOCK, HANDOFFS, RECEIPTS, LINEAGE]);

export function createTaskMetadata({ io, catalog, collection, handoffShard, planningBindings, manifests, baseFiles, authorizations, activated, lineage }) {
const catalogCache = new Map(), lockCache = new Set();
let catalogBytes = 0;
function catalogAt(revision) {
  if (catalogCache.has(revision)) return catalogCache.get(revision);
  const value = io.fileAt(revision, CATALOG);
  if (value === null) throw new Error('Execution base lacks task authorization catalog');
  const prior = JSON.parse(value);
  if (!closed(prior, ['schemaVersion', 'dag', 'assignments', 'environments', 'audits']) || prior.schemaVersion !== 1
    || !equal(prior.dag, catalog.dag)) throw new Error('Planning catalog identity differs');
  for (const key of ['assignments', 'environments', 'audits']) {
    if (!Array.isArray(prior[key]) || new Set(prior[key].map(item => item?.id ?? item?.path)).size !== prior[key].length
      || prior[key].some(item => !catalog[key].some(approved => equal(approved, item)))) throw new Error('Planning catalog authorization differs');
  }
  if (catalogCache.size >= 4096 || catalogBytes + value.length > 8 * 1024 * 1024) { catalogCache.clear(); catalogBytes = 0; }
  catalogCache.set(revision, prior); catalogBytes += value.length;
  return prior;
}
function collectionAt(path, revision, key, latest) {
  const bytes = io.fileAt(revision, path);
  if (bytes === null) return [];
  const value = JSON.parse(bytes);
  if (!closed(value, ['schemaVersion', key]) || value.schemaVersion !== 1 || !Array.isArray(value[key])
    || new Set(value[key].map(item => item?.id ?? item?.path)).size !== value[key].length
    || value[key].some(item => !latest.some(current => equal(item, current)))) throw new Error('Coordinator evidence identity changed');
  return value[key];
}
const histories = new Set();
function metadataHistory(path) {
  if (path === LINEAGE) return;
  if (histories.has(path)) return;
  const key = path === RECEIPTS ? 'receipts' : 'handoffs';
  const snapshots = [];
  for (const revision of io.changes(path)) {
    const next = path === CATALOG ? (() => { const value = catalogAt(revision); return [...value.assignments, ...value.environments, ...value.audits]; })()
      : collectionAt(path, revision, key, path === RECEIPTS ? collection.receipts : handoffShard.handoffs);
    const records = recordKeys(next);
    for (const previous of snapshots) if (!containsRecords(records, previous.records)
      && io.ancestor(previous.revision, revision)) throw new Error('Coordinator history removed or replaced evidence');
    snapshots.push({ revision, records });
  }
  histories.add(path);
}
function reviewLockAt(revision) {
  if (lockCache.has(revision)) return;
  const value = io.fileAt(revision, REVIEW_LOCK);
  if (value === null) throw new Error('Missing planning review lock');
  const lock = JSON.parse(value);
  const paths = io.pathsAt(revision).filter(path => /^config\/migration\/[^/]+\.json$/.test(path) && path !== REVIEW_LOCK);
  if (!closed(lock, ['schemaVersion', 'files']) || lock.schemaVersion !== 1 || !Array.isArray(lock.files)
    || !equal(lock.files.map(item => `config/migration/${item?.path}`).sort(), paths.sort())
    || lock.files.some(item => !closed(item, ['path', 'sha256']) || !hash(item.sha256)
      || digest(io.fileAt(revision, `config/migration/${item.path}`) ?? '') !== item.sha256)) throw new Error('Invalid exact planning review lock');
  if (lockCache.size >= 4096) lockCache.clear();
  lockCache.add(revision);
}
function planningPath(path, revision) {
  if (path === LINEAGE) { lineage.validateAt(revision); return true; }
  if (path === 'config/migration/packages.json' && lineage.registryAt(revision)) return true;
  if (lineage.preparedPath(path, revision)) return true;
  if (path === CATALOG) { catalogAt(revision); metadataHistory(path); return true; }
  if (path === RECEIPTS || path === HANDOFFS) {
    collectionAt(path, revision, path === RECEIPTS ? 'receipts' : 'handoffs', path === RECEIPTS ? collection.receipts : handoffShard.handoffs);
    metadataHistory(path); return true;
  }
  if (path === REVIEW_LOCK) { reviewLockAt(revision); return true; }
  if (!planningBindings.has(path)) return false;
  return digest(io.fileAt(revision, path) ?? '') === planningBindings.get(path);
}
function authorizedShardChange(path, base, revision) {
  const before = io.fileAt(base, path), after = io.fileAt(revision, path);
  const beforeHash = before === null ? null : digest(before), afterHash = after === null ? null : digest(after);
  function follow(expected, seen) {
    if (expected === afterHash) return true;
    return manifests.some(owner => {
      if (lineage.retiredTasks.has(owner.id)) return false;
      if (seen.has(owner.id) || !owner.package.allowed_files.includes(path) || !io.ancestor(owner.base, revision)
        || baseFiles.get(owner.base)?.get(path) !== expected) return false;
      const receipt = collection.receipts.find(item => item?.id === owner.id);
      if (receipt) {
        if (!sha(receipt.subject?.sha) || !io.ancestor(receipt.subject.sha, revision)) return false;
        const bytes = io.fileAt(receipt.subject.sha, path), next = bytes === null ? null : digest(bytes);
        return follow(next, new Set([...seen, owner.id]));
      }
      const authorization = authorizations.get(owner.id);
      return io.ancestor(authorization.manifest.revision, revision) && activated(owner, catalogAt(revision));
    });
  }
  return follow(beforeHash, new Set());
}
function metadataTransition(manifest, base, revision, parallel = false) {
  const allowed = new Set(manifest.package.allowed_files);
  for (const change of io.diff(base, revision)) {
    if (!change.path.startsWith('config/migration/') || change.path.includes('/', 'config/migration/'.length)) continue;
    if (COORDINATOR.has(change.path)) {
      if (!['A', 'M'].includes(change.status) || !planningPath(change.path, revision)) throw new Error('Invalid coordinator transition');
    } else if (!allowed.has(change.path) && !(change.path === 'config/migration/packages.json' && lineage.registryChange(base, revision)) && !(parallel && authorizedShardChange(change.path, base, revision))) {
      throw new Error(`Unrelated shard changed during coordinator transition: ${change.path}`);
    }
  }
  for (const path of [CATALOG, RECEIPTS, HANDOFFS]) metadataHistory(path);
  reviewLockAt(revision);
}
  return { catalogAt, collectionAt, metadataHistory, reviewLockAt, planningPath, metadataTransition };
}
