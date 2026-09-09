// Reviewed boundary for checker maintenance. This grants no product acceptance
// and skips no historical validation or hook suite. Each change is bound to an
// actual single-parent Git snapshot, not mutable worktree content or a flag.
export const MAINTENANCE_BASE = '6de52b694b1247661fba302bf504eeb4a2a5c688';
export const MAINTENANCE_FILES = Object.freeze([
  'tools/migration/evidence-io.mjs',
  'tools/migration/history-records.mjs',
  'tools/migration/snapshot-maintenance.mjs',
  'tools/migration/load-task-lineage.mjs',
  'tools/migration/load-task-evidence.mjs',
  'tools/migration/task-metadata.mjs',
  'tools/migration/task-receipts.mjs',
  'tests_js/migration_task_loader.test.mjs',
  'tests_js/local_checks_migration_maintenance.test.mjs',
  'docs/migration/checker-maintenance.md',
]);

export function maintenancePaths(io, head, base = MAINTENANCE_BASE) {
  const allowed = new Set(MAINTENANCE_FILES), result = new Set();
  if (!io.revision(base) || !io.ancestor(base, head)) return result;
  const candidates = new Map();
  function admitted(revision) {
    if (candidates.has(revision)) return candidates.get(revision);
    const parents = io.parents(revision);
    const changes = parents.length === 1 && io.ancestor(base, parents[0])
      ? io.diff(parents[0], revision) : [];
    const valid = changes.length > 0 && changes.every(change =>
      ['A', 'M'].includes(change.status) && !change.oldPath && allowed.has(change.path)
      && io.fileAt(revision, change.path) !== null);
    candidates.set(revision, valid);
    return valid;
  }
  for (const change of io.diff(base, head)) {
    if (!allowed.has(change.path) || !['A', 'M'].includes(change.status)) continue;
    const current = io.fileAt(head, change.path);
    if (current === null) continue;
    const changes = io.changes(change.path).filter(revision => !io.ancestor(revision, base));
    // Every post-boundary modification of this path must be maintenance-only.
    // An unrelated product commit cannot be laundered by a later restoration.
    if (changes.length && changes.every(admitted)
      && changes.some(revision => io.fileAt(revision, change.path)?.equals(current))) result.add(change.path);
  }
  return result;
}
